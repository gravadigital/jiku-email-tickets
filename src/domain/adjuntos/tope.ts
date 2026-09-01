import { MAX_ATTACHMENTS_PER_REQUIREMENT } from '#config/schema.js';

import type { AdjuntoAceptado, ParticionResult } from './types.js';

/**
 * Aplica el tope fijo de adjuntos por requisito sobre los ya deduplicados.
 *
 * Toma los primeros `MAX_ATTACHMENTS_PER_REQUIREMENT` en el orden de entrada y mueve el resto a
 * `rechazados` con `regla: 'tope_excedido'` (CA-11), sin haber intentado publicar nada para ellos.
 * El orden relativo de los que pasan el tope se conserva exactamente igual al de entrada.
 *
 * El valor se IMPORTA de `#config/schema.js` -- nunca un literal `10` suelto aca, y nunca leido de
 * configuracion/env (CA-12): es el `maxItems` del contrato del bus (ADR-003), no una politica
 * configurable.
 */
export function aplicarTope(
  aceptados: readonly AdjuntoAceptado[],
): ParticionResult<AdjuntoAceptado> {
  const dentroDelTope = aceptados.slice(0, MAX_ATTACHMENTS_PER_REQUIREMENT);
  const excedentes = aceptados.slice(MAX_ATTACHMENTS_PER_REQUIREMENT);

  return {
    aceptados: dentroDelTope,
    rechazados: excedentes.map((adjunto) => ({
      nombre: adjunto.filename,
      mime: adjunto.mimeType,
      regla: 'tope_excedido',
    })),
  };
}
