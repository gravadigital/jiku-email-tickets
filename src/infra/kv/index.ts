/**
 * La superficie publica del modulo del KV.
 *
 * Lo que sale de aca es lo que el arranque y las stories siguientes consumen: la apertura de los
 * dos buckets (S-024), el watch del Mapa de Tickets (S-025), y en su momento las operaciones del
 * Mapa de Hilos (S-026). Lo que NO sale es nada que permita crear un bucket — el conector no crea
 * buckets, y no tener el verbo a mano es parte de que eso se sostenga.
 */
export {
  KvBucketMissingError,
  diagnoseKvFailure,
  isValidBucketName,
  type KvDiagnosis,
} from './errors.js';
export { openKvStores, type KvStores, type OpenKvStoresOptions } from './stores.js';
export {
  startTicketMapWatch,
  type StartTicketMapWatchOptions,
  type TicketMapWatch,
} from './ticket-map.js';
