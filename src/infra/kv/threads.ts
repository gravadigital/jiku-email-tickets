import { createHash } from 'node:crypto';

// El KV entra SOLO por el subpath del SDK, nunca de `@nats-io/kv` ni de `nats` (ADR-002 / S-023):
// garantiza UNA SOLA copia de `nats-core` en el arbol, sin la cual un `instanceof` contra una clase
// de error del SDK falla contra la copia que lo lanzo. Hay un test de propiedad que escanea todo
// `src/infra/kv/` para afirmarlo, y este archivo cae dentro de su alcance. Ademas, el UNICO simbolo
// que este archivo toma del bus es el TIPO `KV`: no construye ningun `Kvm`, no abre ninguna
// conexion, y no crea ningun bucket — el handle llega ya abierto y verificado por `openKvStores()`.
import type { KV } from '@gravadigital/jiku/nats';
import type { Logger } from 'pino';

import { parsePositiveId } from '#infra/kv/parse.js';

/**
 * Las tres operaciones del Mapa de Hilos: la clave hasheada, el write y el lookup.
 *
 * El modulo no lee `process.env` y no llama a `getLogger()`: el handle y el logger llegan por
 * parametro en un objeto de opciones nombrado, igual que `openKvStores()` y `startTicketMapWatch()`.
 * Eso es lo que permite inyectar un logger de captura en los tests sin tocar el singleton.
 *
 * =============================================================================================
 * LAS TRES RAZONES DE ESTE MODULO. Son exactamente lo que un refactor bienintencionado borra, y
 * cada una tiene un test de propiedad que escanea `src/` para detectar que se rompio. NO las
 * borres al "simplificar".
 * =============================================================================================
 *
 * RAZON 1 — POR QUE EL HASH Y NO EL `Message-Id`.
 *
 * `validKeyRe` de `@nats-io/kv` (`lib/kv.js:86`) es `/^[-/=.\w]+$/` y por lo tanto RECHAZA `<`, `>`
 * y `@` — los tres presentes en un `Message-Id` real (`<abc@cliente.com>`). Una clave invalida hace
 * que la libreria lance un `Error` PLANO, sin `name` ni `code` distintivos: no hay diagnostico
 * estructural que recuperar de ella, asi que la defensa es no producirla nunca.
 *
 * La alternativa obvia —normalizar y escapar el `Message-Id` para que entre en el regex— NO se
 * implementa, y no por comodidad: permitiria que dos `Message-Id` distintos colapsen a la misma
 * clave y RUTEEN UN COMENTARIO AL REQUISITO EQUIVOCADO, que viola G-04. Que la clave no se lea con
 * `nats kv ls` (son 64 chars de hex) es un riesgo ACEPTADO EXPLICITAMENTE; la legibilidad no vale
 * un comentario en el ticket de otro cliente.
 *
 * Corolario: `sha256hex()` no hace `trim()` ni `toLowerCase()` ni ninguna normalizacion. El hash va
 * sobre el `Message-Id` CRUDO, con sus brackets, tal como `mailparser` lo entrega. Cualquier
 * normalizacion agregada aca reintroduce el colapso de claves que el hash existe para prohibir.
 *
 * RAZON 2 — POR QUE `get()` PUNTUAL Y NO `watch()`.
 *
 * El Mapa de Hilos es estado de ALTO CARDINAL que cambia en CADA MAIL: una entrada por mail del
 * hilo, con un TTL de 90 dias. Una copia en memoria como la del Mapa de Tickets seria un mapa
 * creciendo sin techo y desactualizado.
 *
 * El contraste con `ticket-map.ts` es DELIBERADO y no una inconsistencia: el Mapa de Tickets tiene
 * decenas de entradas que administra un humano y se lee en cada mail, asi que la copia se paga una
 * vez y se amortiza. Este tiene una entrada por mail y se lee solo cuando hay referencias.
 *
 * El round-trip se paga SOLO cuando `referenceIds` no esta vacio: un mail nuevo no lee nada.
 *
 * RAZON 3 — POR QUE NINGUNA DE LAS DOS OPERACIONES LANZA.
 *
 * - El write falla SIN CANCELAR EL ALTA: el requisito ya se creo en Jiku y no hay comando de
 *   compensacion (invariante 9). Lanzar obligaria al tick a envolver la llamada en un `try/catch`
 *   que reintroduciria la decision en el lugar equivocado. La consecuencia asumida es que ese hilo
 *   no va a rutear despues; el contador `creados` NO se revierte.
 * - El lookup falla devolviendo un resultado DISTINGUIBLE de "sin match". Sin esa distincion el
 *   tick no puede elegir entre `hilo_desconocido` ("esta respuesta apunta a un hilo que no
 *   conozco") y `es_respuesta` ("no pude averiguar a que hilo apunta"), que es la distincion que
 *   toda la story existe para preservar.
 *
 * Ninguna de las dos reintenta: un solo intento, coherente con ADR-001.
 */

/**
 * La clave del bucket: el sha256 en hex del valor TAL CUAL se lo pasan.
 *
 * Sin `trim()`, sin `toLowerCase()`, sin normalizacion de ninguna clase — ver la RAZON 1 de la
 * cabecera antes de agregar cualquiera de las tres.
 *
 * 64 chars de `[0-9a-f]`, que matchean `validKeyRe` por construccion.
 */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface RecordThreadEntryOptions {
  /** El handle que `openKvStores()` ya abrio y verifico. NO se abre ninguna conexion nueva. */
  readonly threads: KV;
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
 * Es una union discriminada, la forma idiomatica del servicio para esto — el precedente directo es
 * `RouteResult` en `#shared/motivo-descarte.js`.
 */
export type ThreadLookupResult =
  /** Se encontro el hilo: esta es la unica forma que trae un `requirementId`. */
  | { readonly found: true; readonly requirementId: number }
  /** Se pudo consultar y ninguna referencia matcheo. Degrada a `hilo_desconocido`. */
  | { readonly found: false; readonly consultable: true }
  /** NO se pudo consultar (bucket inaccesible). Degrada a `es_respuesta`. */
  | { readonly found: false; readonly consultable: false };

export interface LookupThreadOptions {
  /** El handle que `openKvStores()` ya abrio y verifico. */
  readonly threads: KV;
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
 * Escribe la entrada del hilo: `sha256(Message-Id crudo) -> requirementId`.
 *
 * NUNCA LANZA (RAZON 3 de la cabecera). Un `put()` que rechaza se absorbe con UNA linea `warn` y la
 * funcion resuelve normalmente: el alta ya ocurrio y no se compensa.
 *
 * El valor va como el entero en TEXTO (`String(requirementId)`), con el mismo criterio que el
 * bucket de slugs, para que `nats kv get` muestre algo legible y `parsePositiveId()` lo lea igual.
 * NO JSON: `entry.json<T>()` LANZA si el payload no es parseable, y una excepcion por un dato malo
 * de una sola clave no puede ser un modo de falla aca (es el HALLAZGO 5 de `ticket-map.ts`).
 *
 * El `put()` va SIN objeto de opciones. El TTL es del BUCKET y lo fija el operador
 * (`nats kv add MAIL_THREADS --ttl=90d`): el conector no lo toca, y hay un test de propiedad que
 * escanea todo `src/infra/kv/` para afirmar que ningun archivo pasa un ttl.
 */
export async function recordThreadEntry({
  threads,
  messageId,
  requirementId,
  logger,
}: RecordThreadEntryOptions): Promise<void> {
  const messageIdHash = sha256hex(messageId);

  try {
    await threads.put(messageIdHash, String(requirementId));
  } catch {
    // Contexto PLANO de un nivel (convencion `logging`): `redact.paths` de Pino no tiene comodin
    // profundo, asi que un contexto anidado podria dejar un valor sin redactar sin avisar.
    //
    // El campo se llama `messageIdHash` y NO `key`: `REDACT_PATHS` (`#shared/log-redaction.js`)
    // incluye `'key'` y `'*.key'` para cubrir la clave privada RSA del machine user, asi que un
    // campo llamado `key` saldria `[REDACTED]` sin fallar y sin avisar.
    //
    // El `messageId` va EN CLARO: ADR-006 lo exige en cada linea, y el hash no lo reemplaza en el
    // log — solo en la clave. Lo que no viaja es el cuerpo del mail ni el contenido de un adjunto.
    //
    // La CONSECUENCIA ASUMIDA de este camino es que ese hilo no va a rutear despues: una respuesta
    // a este mail se descartara como `hilo_desconocido`. Es la falla segura, y no se compensa.
    logger.warn(
      { messageId, messageIdHash, requirementId },
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
 * Con `referenceIds` vacio no se invoca `get()` ni una vez: un mail nuevo no paga ningun
 * round-trip de lectura.
 *
 * Una entrada con VALOR MAL FORMADO no es un hit: se saltea con un `warn` que nombra el
 * `messageIdHash` y la iteracion CONTINUA con la referencia siguiente — el dato malo de una clave
 * no puede tapar el hilo real que esta en la siguiente. Un `get()` que RECHAZA, en cambio, CORTA:
 * un bucket inaccesible no se vuelve accesible en la referencia siguiente, y seguir iterando serian
 * N fallos por el mismo motivo.
 */
export async function lookupThread({
  threads,
  referenceIds,
  logger,
}: LookupThreadOptions): Promise<ThreadLookupResult> {
  for (const referenceId of referenceIds) {
    const messageIdHash = sha256hex(referenceId);

    let raw: string | undefined;
    try {
      const entry = await threads.get(messageIdHash);
      // `get()` devuelve `null` cuando la clave no existe — no lanza. Un `null` es "no esta", que
      // es un resultado normal y NO un fallo de consulta: se sigue con la referencia siguiente.
      if (entry === null) continue;
      raw = entry.string();
    } catch {
      logger.warn(
        { messageId: referenceId, messageIdHash },
        'no se pudo consultar el Mapa de Hilos; no se puede saber a que hilo apunta esta respuesta',
      );
      return { found: false, consultable: false };
    }

    const requirementId = parsePositiveId(raw);

    if (requirementId === undefined) {
      // El `messageIdHash` viaja porque es LA CLAVE con la que se cruza el bucket
      // (`nats kv get MAIL_THREADS <hash>`), y es un hash: no es contenido del cliente. El VALOR
      // crudo no viaja — no aporta al arreglo y seria volcar contenido del bucket al log.
      logger.warn(
        { messageId: referenceId, messageIdHash },
        'una entrada del Mapa de Hilos tiene un requirementId invalido y se saltea',
      );
      continue;
    }

    // EL CORTE EN EL PRIMER HIT. Las referencias posteriores no se consultan.
    return { found: true, requirementId };
  }

  return { found: false, consultable: true };
}
