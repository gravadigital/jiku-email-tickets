import type { AdjuntosConfig } from '#config/index.js';
import type { MailAttachment } from '#domain/ingesta/types.js';

import { aplicarTope } from './tope.js';
import { deduplicar } from './dedup.js';
import { particionar } from './particionar.js';
import type { AdjuntoAceptado, AdjuntoRechazado, ParticionResult } from './types.js';

/**
 * Compone las tres etapas del pipeline de adjuntos en el orden exacto exigido por CA-13 de S-017:
 * **particion -> dedup -> tope**, y es el UNICO orden que produce los tres resultados correctos.
 *
 * - Particion primero: un mail con dos `.exe` identicos y ningun otro adjunto produce DOS
 *   entradas de rechazo (una por archivo, cada una por la politica) -- deduplicar antes
 *   produciria una tercera entrada o un aviso de "duplicado rechazado" que no corresponde, porque
 *   ninguno de los dos llego a ser aceptado.
 * - Dedup antes que tope: la misma captura repetida 12 veces se acepta una sola vez tras el dedup,
 *   y el tope nunca llega a rechazar nada por exceso.
 *
 * Los `rechazados` de las tres etapas se acumulan en un unico array final, en el orden en que cada
 * etapa los produjo (particion, despues dedup, despues tope).
 *
 * No hay barrel file (`index.ts`) para este modulo -- mismo precedente que `ruteo` y
 * `publicacion`, que usan imports directos a cada archivo en vez de un punto de entrada unico.
 *
 * Funcion PURA, igual que las tres que compone: no publica `files.request-upload`, no hace ningun
 * `PUT`, no compone ninguna descripcion y no loguea nada (CA-14; esas responsabilidades son de
 * S-018, S-019, S-020 y S-021 respectivamente).
 */
export function procesarAdjuntos(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes'>,
): ParticionResult<AdjuntoAceptado> {
  const particionado = particionar(attachments, config);
  const deduplicado = deduplicar(particionado.aceptados);
  const topeado = aplicarTope(deduplicado.aceptados);

  const rechazados: AdjuntoRechazado[] = [
    ...particionado.rechazados,
    ...deduplicado.rechazados,
    ...topeado.rechazados,
  ];

  return { aceptados: topeado.aceptados, rechazados };
}
