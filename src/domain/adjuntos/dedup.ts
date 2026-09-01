import { createHash } from 'node:crypto';

import type { AdjuntoAceptado, AdjuntoParticionado, ParticionResult } from './types.js';

/**
 * Deduplica los adjuntos que ya pasaron la particion, por checksum sha256 del contenido.
 *
 * Funcion PURA: recorre `particionados` en el orden del mail, calcula el checksum de cada uno con
 * `node:crypto` (CA-6), y descarta silenciosamente el segundo y siguientes de cada checksum
 * repetido (CA-7) -- el descarte NO produce ninguna entrada de rechazo, ningun log ni ningun
 * aviso: es el unico estado terminal silencioso del ciclo de vida del Adjunto del Mail. El nombre
 * del duplicado descartado no se anota en ningun lado (CA-8), y el `mimeType` declarado no
 * participa en la comparacion -- el checksum es sobre el byte (CA-9).
 *
 * El `Set<string>` de checksums vistos tiene alcance UNICAMENTE la invocacion actual -- no hay
 * ninguna variable de modulo, cache ni estado que sobreviva entre llamadas (CA-10, ADR-001): cada
 * mail se deduplica con su propio conjunto, nunca contra otro mail.
 *
 * `O(n)` sobre los adjuntos, con un `Set`, sin comparaciones cuadraticas (Performance del Diseno
 * Tecnico de la story).
 *
 * Un error inesperado calculando el checksum de un adjunto individual se captura y produce una
 * entrada `{ nombre, mime, regla: 'error_interno' }` en `rechazados`, sin abortar el resto
 * (aislamiento de fallos).
 */
export function deduplicar(
  particionados: readonly AdjuntoParticionado[],
): ParticionResult<AdjuntoAceptado> {
  const vistos = new Set<string>();
  const aceptados: AdjuntoAceptado[] = [];
  const rechazados: ParticionResult['rechazados'] = [];

  for (const adjunto of particionados) {
    let checksum: string;
    try {
      // El checksum se calcula UNA VEZ por adjunto, antes de comparar -- nunca se recalcula para
      // cada comparacion.
      checksum = createHash('sha256').update(adjunto.content).digest('hex');
    } catch {
      rechazados.push({ nombre: adjunto.filename, mime: adjunto.mimeType, regla: 'error_interno' });
      continue;
    }

    if (vistos.has(checksum)) continue;

    vistos.add(checksum);
    aceptados.push({ ...adjunto, checksum });
  }

  return { aceptados, rechazados };
}
