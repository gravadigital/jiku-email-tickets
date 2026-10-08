import type { KVEntry } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import { errorClassOf } from '#infra/kv/errors.js';
import { isStorableSlug, ticketKey } from '#infra/kv/keys.js';
import { parsePositiveId } from '#infra/kv/parse.js';
import type { KvSpace } from '#infra/kv/space.js';

/**
 * El Mapa de Tickets: la consulta `slug -> projectId` de un mail nuevo, contra el Espacio KV.
 *
 * Reemplaza al `watch()` y a la copia en memoria de S-025 (REQ-008): un `get` puntual por mail, sin
 * carga inicial, sin reintento de fondo y sin estado.
 *
 * =============================================================================================
 * LAS CUATRO SITUACIONES, Y POR QUE CADA UNA TERMINA DONDE TERMINA.
 * =============================================================================================
 *
 * 1. `get()` devuelve una entrada con un entero positivo -> `found: true`. Sin log: la linea del alta
 *    ya lleva `slug` y `projectId`.
 * 2. `get()` devuelve `undefined` (nunca se cargo, o se borro) -> `consultable: true`: el tick lo
 *    descarta como `slug_no_mapeado`, y el arreglo es CARGAR EL SLUG.
 * 3. La entrada tiene un valor que no es un entero positivo -> tambien `consultable: true`, con un
 *    `warn` que nombra el SLUG y NUNCA el valor crudo (ADR-004; invariante 22). Un valor malo nunca
 *    va a resolver: es un slug no mapeado, no un KV roto.
 * 4. El slug NO PUEDE SER CLAVE (`isStorableSlug()` falso: `a+b`, `al..fa`, acentos) -> tambien
 *    `consultable: true`, y SIN round-trip: un slug asi nunca pudo cargarse, asi que preguntar por el
 *    solo agregaria un `JikuInvalidRequest` que se confundiria con un KV caido (REQ-008, Riesgo 7).
 *
 * Y la quinta, que no es "no esta": `get()` RECHAZA (timeout, permisos, bucket, conexion) ->
 * `consultable: false`, con un `warn` que lleva `slug` y `errorClass`. El tick lo descarta como
 * `slug_no_consultable`, y el arreglo es ARREGLAR EL KV. Esa distincion es la razon de que el
 * resultado tenga tres estados y no `number | undefined`.
 *
 * SIN CACHE. Un alta o una baja del operador vale DESDE EL MAIL SIGUIENTE. Guardar el resultado
 * (una variable de modulo, un `Map`) reintroduciria la copia en memoria que esta story borra, y con
 * ella el "slug borrado que sigue resolviendo". Hay un test de propiedad que lo afirma.
 *
 * SIN REINTENTO. Un solo intento, coherente con ADR-001: un mail que no se pudo resolver se descarta
 * con su motivo y queda en la casilla, reconstruible desde el log. Reintentar dentro del tick
 * multiplicaria el timeout del cliente (15 s) por cada mail bajo una caida del KV.
 *
 * NUNCA LANZA. El `get()` va dentro del `try`, incluso uno que lance sincronicamente: el tick no
 * envuelve la llamada, y un throw aca cortaria el lote entero.
 */

/** El resultado de la consulta del slug, con sus TRES estados distinguibles por el typechecker. */
export type TicketLookupResult =
  /** El slug esta cargado: esta es la unica forma que trae un `projectId`. */
  | { readonly found: true; readonly projectId: number }
  /** Se pudo consultar y no esta (o nunca va a estar). Degrada a `slug_no_mapeado`. */
  | { readonly found: false; readonly consultable: true }
  /** NO se pudo consultar. Degrada a `slug_no_consultable`. */
  | { readonly found: false; readonly consultable: false };

export interface LookupTicketOptions {
  /** El espacio que `openKvSpace()` abrio en el arranque. NO se abre ninguna conexion nueva. */
  readonly space: KvSpace;
  /** El slug YA en minusculas (lo normaliza `routeMail()`, invariante 4). */
  readonly slug: string;
  readonly logger: Logger;
}

/** UN `get`, UN intento, sin cache. NUNCA lanza. */
export async function lookupTicket({ space, slug, logger }: LookupTicketOptions): Promise<TicketLookupResult> {
  if (!isStorableSlug(slug)) return { found: false, consultable: true };

  let entry: KVEntry | undefined;
  try {
    entry = await space.get(ticketKey(slug));
  } catch (error) {
    // Contexto PLANO de un nivel y mensaje estatico (convencion `logging`). El `slug` es el dato
    // que permite reconstruir los mails descartados desde la casilla (REQ-008, Riesgo 3).
    logger.warn(
      { slug, errorClass: errorClassOf(error) },
      'no se pudo consultar el Mapa de Tickets; el mail se descarta como slug_no_consultable',
    );
    return { found: false, consultable: false };
  }

  if (entry === undefined) return { found: false, consultable: true };

  const projectId = parsePositiveId(new TextDecoder().decode(entry.value));
  if (projectId === undefined) {
    // Nombra el slug, NUNCA el valor crudo: no aporta al arreglo y seria volcar contenido del KV al
    // log (invariante 22).
    logger.warn({ slug }, 'una entrada del Mapa de Tickets tiene un projectId invalido y se ignora');
    return { found: false, consultable: true };
  }

  return { found: true, projectId };
}
