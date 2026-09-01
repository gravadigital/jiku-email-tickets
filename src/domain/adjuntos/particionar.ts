import { extname } from 'node:path';

import type { AdjuntosConfig } from '#config/index.js';
import type { MailAttachment } from '#domain/ingesta/types.js';

import type { AdjuntoParticionado, AdjuntoRechazado, ParticionResult, ReglaRechazo } from './types.js';

/** Fallback cuando ni `filename` ni `mimeType` alcanzan para derivar una extension conocida. */
const FALLBACK_EXTENSION = '.bin';

/**
 * Mapa `mimeType -> extension`, acotado a los MIME de la lista blanca por default mas
 * `application/octet-stream`. Es una decision de diseno tecnico de esta story (no la fija
 * REQ-004): sirve unicamente para generar un nombre cuando falta `filename` (CA-3), nunca para
 * inferir el MIME de un adjunto que si trae nombre.
 */
const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'application/zip': '.zip',
  'application/octet-stream': FALLBACK_EXTENSION,
};

/** Resuelve el `mimeType` efectivo: el declarado, o `application/octet-stream` si falta (CA-4). */
function resolveMimeType(declared: string): string {
  return declared === '' ? 'application/octet-stream' : declared;
}

/**
 * Resuelve el `filename` efectivo: el declarado, o uno generado a partir de la posicion
 * (1-indexed) y la extension que corresponde al `mimeType` ya resuelto (CA-3).
 */
function resolveFilename(declared: string, index: number, effectiveMimeType: string): string {
  if (declared !== '') return declared;

  const extension = EXTENSION_BY_MIME_TYPE[effectiveMimeType] ?? FALLBACK_EXTENSION;
  return `adjunto-${String(index + 1)}${extension}`;
}

/**
 * Evalua las tres reglas de la politica local mas el rechazo incondicional de 0 bytes, sobre un
 * adjunto cuyo nombre y MIME ya se resolvieron.
 *
 * Orden de evaluacion, no intercambiable (AC-7 de Task 3, CA-2 de la story): **tamano cero
 * (incondicional) -> extension -> MIME -> tamano maximo**. La regla que falla primero es la unica
 * que se anota -- un adjunto que falla dos reglas a la vez anota solo la que se evalua antes.
 */
function evaluarRegla(
  filename: string,
  mimeType: string,
  contentLength: number,
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes'>,
): ReglaRechazo | undefined {
  // CA-2: 0 bytes se rechaza SIEMPRE, antes de tocar extension o MIME.
  if (contentLength === 0) return 'tamano_cero';

  // Un `filename` SIN punto (`extname` devuelve '') no tiene extension contra la cual comparar la
  // lista blanca -- no es "una extension invalida", es la ausencia de la señal que esta regla
  // evalua. Se deja pasar la regla de extension en ese caso puntual y se apoya en la regla de MIME
  // como el filtro real: TS-7 (CA-4) confirma este comportamiento con `filename: 'datos'` (sin
  // mimeType declarado) -- se rechaza por `mime` (`application/octet-stream` no pasa la lista
  // blanca), no por `extension`. Con un `filename` que SI trae extension, la regla se aplica
  // normalmente (TS-3).
  const extension = extname(filename).toLowerCase();
  if (extension !== '' && !config.allowedExtensions.includes(extension)) return 'extension';

  if (!config.allowedMimeTypes.includes(mimeType)) return 'mime';

  // CA-1: el tamano se evalua sobre content.length (el Buffer real), nunca sobre `size` declarado
  // -- ese valor ni siquiera llega a esta funcion.
  if (contentLength >= config.maxSizeBytes) return 'tamano';

  return undefined;
}

/**
 * Particiona los adjuntos de un mail en aceptados o rechazados por la politica local de tres
 * reglas (extension, MIME, tamano real en memoria), mas el rechazo incondicional de 0 bytes.
 *
 * Funcion PURA: no publica nada, no loguea nada, nunca lanza hacia su llamador -- un error
 * inesperado al evaluar un adjunto individual se captura y se traduce a `regla: 'error_interno'`,
 * sin abortar el procesamiento del resto (aislamiento de fallos, Manejo de errores del Diseno
 * Tecnico de la story). Mismo criterio que `routeMail()` (`src/domain/ruteo/route-mail.ts`).
 *
 * Recibe `Pick<AdjuntosConfig, ...>` y no `AdjuntosConfig` completo -- mismo criterio que
 * `routeMail()` con `RuteoConfig`: no acoplarse a la config entera.
 */
export function particionar(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes'>,
): ParticionResult<AdjuntoParticionado> {
  const aceptados: AdjuntoParticionado[] = [];
  const rechazados: AdjuntoRechazado[] = [];

  attachments.forEach((attachment, index) => {
    try {
      const mimeType = resolveMimeType(attachment.mimeType);
      const filename = resolveFilename(attachment.filename, index, mimeType);
      const regla = evaluarRegla(filename, mimeType, attachment.content.length, config);

      if (regla !== undefined) {
        rechazados.push({ nombre: filename, mime: mimeType, regla });
        return;
      }

      aceptados.push({ filename, mimeType, content: attachment.content });
    } catch {
      // Un adjunto individual que lanza (por ejemplo, al leer una propiedad) no puede resolver ni
      // su nombre ni su MIME de forma confiable -- se anota con los valores crudos disponibles,
      // sin propagar la excepcion (invariante 13, aislamiento de fallos).
      rechazados.push({
        nombre: safeAccess(() => attachment.filename) ?? 'desconocido',
        mime: safeAccess(() => attachment.mimeType) ?? 'application/octet-stream',
        regla: 'error_interno',
      });
    }
  });

  return { aceptados, rechazados };
}

/** Lee un valor que puede lanzar, devolviendo `undefined` en vez de propagar la excepcion. */
function safeAccess<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
