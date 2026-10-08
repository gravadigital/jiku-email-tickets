// El KV es el Espacio KV del SDK (`client.kv()`, REQ-008): este archivo no toma NADA del bus. El
// handle llega ya abierto por `openKvSpace()` como `KvSpace` (solo `get` y `put`), y los tipos salen
// de la entrada principal del SDK. No construye ningun cliente, no abre ninguna conexion y no crea
// ningun bucket; hay un test de propiedad que escanea `src/` para afirmarlo.
import type { KVEntry } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import { errorClassOf } from '#infra/kv/errors.js';
import { sha256hex, threadKey } from '#infra/kv/keys.js';
import { parsePositiveId } from '#infra/kv/parse.js';
import type { KvSpace } from '#infra/kv/space.js';

/**
 * Las dos operaciones del Mapa de Hilos sobre el Espacio KV: el write y el lookup.
 *
 * El modulo no lee `process.env` y no llama a `getLogger()`: el espacio y el logger llegan por
 * parametro en un objeto de opciones nombrado, igual que `openKvSpace()` y `lookupTicket()`. Eso es
 * lo que permite inyectar un logger de captura en los tests sin tocar el singleton.
 *
 * =============================================================================================
 * LAS TRES RAZONES DE ESTE MODULO. Son exactamente lo que un refactor bienintencionado borra, y
 * cada una tiene un test que detecta que se rompio. NO las borres al "simplificar".
 * =============================================================================================
 *
 * RAZON 1 — POR QUE EL HASH Y NO EL `Message-Id`.
 *
 * Vive junto a `sha256hex()` en `#infra/kv/keys.js`, que es donde se arma la clave
 * (`threadKey()` = `hilos.` + el sha256 del `Message-Id` CRUDO, sin normalizar). Resumen: las reglas
 * de clave del SDK rechazan `<`, `>` y `@`, y normalizar el `Message-Id` para que entre haria
 * colapsar dos hilos distintos en la misma clave (invariante 23).
 *
 * RAZON 2 — POR QUE `get()` PUNTUAL Y SIN COPIA EN MEMORIA.
 *
 * El Mapa de Hilos es estado de ALTO CARDINAL que cambia en CADA MAIL: una entrada por mail del
 * hilo, sin expiracion. Una copia en memoria seria un mapa creciendo sin techo y desactualizado.
 * Desde REQ-008 los DOS mapas son `get` puntual (`lookupTicket()` tampoco copia nada): no hay
 * contraste que justificar.
 *
 * El round-trip se paga SOLO cuando `referenceIds` no esta vacio: un mail nuevo no lee el Mapa de
 * Hilos (solo consulta su slug).
 *
 * Una entrada de CUALQUIER antiguedad matchea: nada en este modulo lee `created` (invariante 32).
 *
 * RAZON 3 — POR QUE NINGUNA DE LAS DOS OPERACIONES LANZA.
 *
 * - El write falla SIN CANCELAR EL ALTA: el requisito ya se creo en Jiku y no hay comando de
 *   compensacion (invariante 9). Lanzar obligaria al tick a envolver la llamada en un `try/catch`
 *   que reintroduciria la decision en el lugar equivocado. La consecuencia asumida es que ese hilo
 *   no va a rutear despues; el contador `creados` NO se revierte. Incluye el `JikuBucketFull`: el
 *   bucket es compartido por todas las identidades y no tiene cuota por identidad.
 * - El lookup falla devolviendo un resultado DISTINGUIBLE de "sin match". Sin esa distincion el
 *   tick no puede elegir entre `hilo_desconocido` ("esta respuesta apunta a un hilo que no
 *   conozco") y `es_respuesta` ("no pude averiguar a que hilo apunta").
 *
 * Ninguna de las dos reintenta: un solo intento, coherente con ADR-001.
 */

export interface RecordThreadEntryOptions {
  /** El espacio que `openKvSpace()` abrio en el arranque. NO se abre ninguna conexion nueva. */
  readonly space: KvSpace;
  /** El `Message-Id` CRUDO, con sus brackets, tal como lo entrega `normalize()`. */
  readonly messageId: string;
  /** El id del Requisito que el alta acaba de crear en Jiku. */
  readonly requirementId: number;
  readonly logger: Logger;
}

/**
 * El resultado del lookup, con sus TRES estados distinguibles por el typechecker.
 *
 * `number | undefined` NO sirve: colapsaria "no esta" con "no pude preguntar", que es exactamente
 * la distincion que sostiene el motivo del descarte (`hilo_desconocido` contra `es_respuesta`).
 *
 * Es una union discriminada, la forma idiomatica del servicio para esto — la misma que
 * `TicketLookupResult` en `#infra/kv/tickets.js`.
 */
export type ThreadLookupResult =
  /** Se encontro el hilo: esta es la unica forma que trae un `requirementId`. */
  | { readonly found: true; readonly requirementId: number }
  /** Se pudo consultar y ninguna referencia matcheo. Degrada a `hilo_desconocido`. */
  | { readonly found: false; readonly consultable: true }
  /** NO se pudo consultar (espacio inaccesible). Degrada a `es_respuesta`. */
  | { readonly found: false; readonly consultable: false };

export interface LookupThreadOptions {
  /** El espacio que `openKvSpace()` abrio en el arranque. */
  readonly space: KvSpace;
  /**
   * Las referencias del mail, EN EL ORDEN QUE `normalize()` YA PRODUJO.
   *
   * `mergeReferenceIds()` (`#domain/ingesta/headers.js`) entrega la union deduplicada de
   * `In-Reply-To` y `References`, en orden de aparicion, con el de `In-Reply-To` PRIMERO. Este
   * modulo NO ordena, NO deduplica y NO filtra: reordenar aca seria reimplementar en el lugar
   * equivocado una regla que ya tiene dueno.
   */
  readonly referenceIds: readonly string[];
  readonly logger: Logger;
}

/**
 * Escribe la entrada del hilo: `hilos.<sha256(Message-Id crudo)> -> requirementId`.
 *
 * NUNCA LANZA (RAZON 3 de la cabecera). Un `put()` que rechaza se absorbe con UNA linea `warn` y la
 * funcion resuelve normalmente: el alta ya ocurrio y no se compensa.
 *
 * El valor va como el entero en TEXTO (`String(requirementId)`), con el mismo criterio que el Mapa
 * de Tickets, para que `nats kv get` muestre algo legible y `parsePositiveId()` lo lea igual. NO
 * JSON: un dato malo de una sola clave no puede ser una excepcion.
 *
 * El `put()` va SIN objeto de opciones: ni timeout propio (rige el del cliente, ADR-002) ni TTL (el
 * Espacio KV no lo expone y los hilos no expiran).
 */
export async function recordThreadEntry({
  space,
  messageId,
  requirementId,
  logger,
}: RecordThreadEntryOptions): Promise<void> {
  try {
    await space.put(threadKey(messageId), String(requirementId));
  } catch (error) {
    // Contexto PLANO de un nivel (convencion `logging`): `redact.paths` de Pino no tiene comodin
    // profundo, asi que un contexto anidado podria dejar un valor sin redactar sin avisar.
    //
    // El campo se llama `messageIdHash` y NO `key`: `REDACT_PATHS` (`#shared/log-redaction.js`)
    // incluye `'key'` y `'*.key'` para cubrir la clave privada RSA del machine user, asi que un
    // campo llamado `key` saldria `[REDACTED]` sin fallar y sin avisar. Es el hash SOLO, sin el
    // prefijo `hilos.`, como antes de REQ-008.
    //
    // El `messageId` va EN CLARO: ADR-006 lo exige en cada linea, y el hash no lo reemplaza en el
    // log — solo en la clave. Lo que no viaja es el cuerpo del mail ni el contenido de un adjunto.
    // `errorClass` distingue un bucket lleno (`JikuBucketFull`) de un timeout o un permiso.
    //
    // La CONSECUENCIA ASUMIDA de este camino es que ese hilo no va a rutear despues: una respuesta
    // a este mail se descartara como `hilo_desconocido`. Es la falla segura, y no se compensa.
    logger.warn(
      { messageId, messageIdHash: sha256hex(messageId), requirementId, errorClass: errorClassOf(error) },
      'no se pudo escribir la entrada del Mapa de Hilos; el requisito ya se creo y no se compensa',
    );
  }
}

/**
 * Recorre las referencias EN ORDEN y devuelve el `requirementId` del primer hit valido.
 *
 * NUNCA LANZA (RAZON 3 de la cabecera): los tres estados son valores de retorno tipados.
 *
 * REGLA DURA: NADA DE `Promise.all` SOBRE LAS REFERENCIAS. Es la "optimizacion" que se ve obvia y
 * que rompe dos cosas a la vez: (a) borra el CORTE en el primer hit —se pagarian N round-trips
 * donde el diseno paga 1— y (b) borra el ORDEN, que es lo que hace que la referencia de
 * `In-Reply-To` gane. El bucle es secuencial a proposito, en linea con ADR-001.
 *
 * Con `referenceIds` vacio no se invoca `get()` ni una vez.
 *
 * Una entrada con VALOR MAL FORMADO no es un hit: se saltea con un `warn` que nombra el
 * `messageIdHash` y la iteracion CONTINUA con la referencia siguiente — el dato malo de una clave
 * no puede tapar el hilo real que esta en la siguiente. Un `get()` que RECHAZA, en cambio, CORTA:
 * un espacio inaccesible no se vuelve accesible en la referencia siguiente, y seguir iterando serian
 * N fallos por el mismo motivo.
 */
export async function lookupThread({
  space,
  referenceIds,
  logger,
}: LookupThreadOptions): Promise<ThreadLookupResult> {
  for (const referenceId of referenceIds) {
    let entry: KVEntry | undefined;
    try {
      entry = await space.get(threadKey(referenceId));
    } catch {
      logger.warn(
        { messageId: referenceId, messageIdHash: sha256hex(referenceId) },
        'no se pudo consultar el Mapa de Hilos; no se puede saber a que hilo apunta esta respuesta',
      );
      return { found: false, consultable: false };
    }

    // `get()` devuelve `undefined` cuando la clave no existe — no lanza. Es "no esta", un resultado
    // normal y NO un fallo de consulta: se sigue con la referencia siguiente.
    if (entry === undefined) continue;

    const requirementId = parsePositiveId(new TextDecoder().decode(entry.value));

    if (requirementId === undefined) {
      // El `messageIdHash` viaja porque es lo que identifica la clave en el espacio, y es un hash:
      // no es contenido del cliente. El VALOR crudo no viaja — no aporta al arreglo y seria volcar
      // contenido del KV al log.
      logger.warn(
        { messageId: referenceId, messageIdHash: sha256hex(referenceId) },
        'una entrada del Mapa de Hilos tiene un requirementId invalido y se saltea',
      );
      continue;
    }

    // EL CORTE EN EL PRIMER HIT. Las referencias posteriores no se consultan.
    return { found: true, requirementId };
  }

  return { found: false, consultable: true };
}
