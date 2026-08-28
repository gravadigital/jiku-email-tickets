/**
 * Limpieza del asunto: quita los prefijos de respuesta/reenvio.
 *
 * Port del servicio existente (`grava-gestion/mail-integration` v1.0.0, Arq-9). La semantica se
 * conserva exacta: iterativo, sin distinguir mayusculas, y con el espacio que sigue al prefijo. Un
 * asunto que era solo prefijos queda `''`, que es un estado valido (CA-4) y no un descarte.
 */

/** `Re:`, `Fwd:` y `RV:`, sin distinguir mayusculas, con el `:` y el espacio que lo sigue. */
const SUBJECT_PREFIX = /^(re|fwd|rv)\s*:\s*/i;

export function cleanSubject(subject: string): string {
  let cleaned = subject.trim();
  while (SUBJECT_PREFIX.test(cleaned)) {
    cleaned = cleaned.replace(SUBJECT_PREFIX, '').trim();
  }
  return cleaned;
}
