/**
 * La superficie publica del modulo del KV.
 *
 * Lo que sale de aca es lo que el arranque y el tick consumen desde REQ-008: la apertura del
 * Espacio KV (`openKvSpace()`), la consulta del Mapa de Tickets (`lookupTicket()`), las operaciones
 * del Mapa de Hilos y las claves. Lo que NO sale es nada que permita crear un bucket — el conector
 * no crea buckets, y no tener el verbo a mano es parte de que eso se sostenga.
 */
export { KvSpaceUnavailableError, diagnoseKvFailure, type KvDiagnosis } from './errors.js';
export {
  THREADS_KEY_PREFIX,
  TICKETS_KEY_PREFIX,
  isStorableSlug,
  sha256hex,
  threadKey,
  ticketKey,
} from './keys.js';
export { parsePositiveId } from './parse.js';
export { openKvSpace, type KvSpace, type OpenKvSpaceOptions } from './space.js';
export {
  lookupThread,
  recordThreadEntry,
  type LookupThreadOptions,
  type RecordThreadEntryOptions,
  type ThreadLookupResult,
} from './threads.js';
export { lookupTicket, type LookupTicketOptions, type TicketLookupResult } from './tickets.js';
