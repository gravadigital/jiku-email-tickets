import { ErrorCode, type Client, JikuFailure, isCode } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { AdjuntoAceptado } from '#domain/adjuntos/types.js';
import { fileUploadReplySchema } from '#domain/publicacion/files.schema.js';
import type { UploadResultado } from '#domain/publicacion/files.types.js';
import { parseFileUploadRequest } from '#domain/publicacion/files.types.js';
import { PublishError, diagnosePublishFailure } from '#domain/publicacion/publish-errors.js';

/**
 * La publicacion de `files.request-upload`: el segundo punto de escritura del conector (junto a
 * `requirements.new` en `publish-requirement.ts`).
 *
 * Arma y valida el payload desde UN `AdjuntoAceptado`, publica el comando con `client.command()`
 * (mismo cliente ya conectado, sin segundo `connect()`), y traduce la respuesta a un
 * `UploadResultado` tipado. Es el UNICO archivo donde se agrega la rama que distingue el
 * `failure` de negocio (`file_type_not_allowed`/`file_too_large`) ANTES de
 * `diagnosePublishFailure()` -- esa funcion no se toca (CA-6).
 *
 * DIFERENCIA DELIBERADA con `publish-requirement.ts`: esta funcion NUNCA lanza para un rechazo o
 * un fallo de publicacion, SIEMPRE devuelve. CA-8 y la tabla de Manejo de Errores de REQ-004 piden
 * "se saltea con aviso... y el procesamiento continua", y quien orquesta el bucle de adjuntos
 * (S-021) necesita un valor que inspeccionar por archivo, no una excepcion que interrumpiria el
 * `for` si no se envolviera en un try/catch por iteracion.
 */

/** El nombre del comando. El SDK arma el subject completo a partir de esto. */
const COMMAND = 'files.request-upload';

export interface RequestFileUploadDeps {
  /** El cliente conectado. El mismo de `publish-requirement.ts`, de `connectToBus()` (S-004). */
  readonly client: Client;
  readonly logger: Logger;
}

/**
 * Pide a `core` el permiso de subida para UN adjunto ya aceptado por la politica local (S-017).
 *
 * Recibe `Pick<AdjuntoAceptado, ...>`, no el tipo completo -- mismo criterio de `Pick` que
 * `routeMail()`/`buildRequirementPayload()`. La firma NO acepta una lista ni un parametro de
 * orden: se invoca una vez por adjunto, en serie -- no orquesta el tick ni itera (CA-9). Eso lo
 * hace S-021.
 */
export async function requestFileUpload(
  adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'content' | 'checksum'>,
  { client, logger }: RequestFileUploadDeps,
): Promise<UploadResultado> {
  // El payload se valida ANTES de publicar, igual que `publishVerificationRequirement()`: un
  // payload invalido NO se publica. `fileSize` sale de `content.length` -- NUNCA de un `size`
  // declarado, que ni siquiera existe en `AdjuntoAceptado` (S-017 ya lo descarto). `checksum` ya
  // llega calculado por S-017: esta funcion no llama `node:crypto`, solo lo transporta.
  const payload = parseFileUploadRequest({
    fileName: adjunto.filename,
    mimeType: adjunto.mimeType,
    fileSize: adjunto.content.length,
    checksum: adjunto.checksum,
  });

  let data: unknown;

  try {
    // DOS ARGUMENTOS, no tres -- mismo criterio que `publish-requirement.ts`: el tercero
    // (`options`) es donde se bajaria el timeout por accidente, y ADR-006 lo prohibe
    // explicitamente. El efectivo queda en el default del SDK (15000 ms), distinto del timeout de
    // 30000 ms del `PUT` posterior (S-019).
    data = await client.command(COMMAND, payload);
  } catch (cause) {
    // La rama que distingue el rechazo de NEGOCIO de `core` (el archivo paso el filtro local pero
    // `core` lo rechaza) de cualquier OTRO fallo de publicacion. Tiene que evaluarse ANTES de
    // `diagnosePublishFailure()`, para que un codigo de archivo nunca caiga en
    // `'core_rechazo_desconocido'` -- esa funcion no tiene ninguna rama nueva (CA-6), asi que la
    // distincion vive ACA, no ahi.
    //
    // `isCode()` dentro de `instanceof JikuFailure`, nunca comparando strings a mano (ADR-002):
    // mismo estilo que `diagnosePublishFailure()` evalua sus propios `isCode()`.
    if (
      cause instanceof JikuFailure &&
      (isCode(cause, ErrorCode.FileTypeNotAllowed) || isCode(cause, ErrorCode.FileTooLarge))
    ) {
      const codigo = isCode(cause, ErrorCode.FileTypeNotAllowed)
        ? ErrorCode.FileTypeNotAllowed
        : ErrorCode.FileTooLarge;

      // `warn`, no `info`: nivel NUEVO respecto del rechazo puramente local de S-017 (que no
      // logueaba nada). Es el unico sintoma de que la politica local esta desalineada con la de
      // `core` (CA-5). Nunca la `uploadUrl` -- no la hay en este caso, pero tampoco ningun otro
      // campo del adjunto que no sea nombre/MIME.
      logger.warn(
        { code: codigo, nombre: adjunto.filename, mime: adjunto.mimeType },
        'core rechazo el adjunto por politica de archivos',
      );

      return { tipo: 'rechazado', codigo, nombre: adjunto.filename, mime: adjunto.mimeType };
    }

    // Cualquier OTRO fallo: las 9 ramas de `diagnosePublishFailure()` de S-005, reutilizada SIN
    // MODIFICAR (CA-6).
    const error = new PublishError(diagnosePublishFailure(cause), cause);

    // `files.request-upload` NO tiene `projectId` -- el permiso de subida se pide antes de saber a
    // que requisito se va a vincular, a diferencia de `requirements.new`. Por eso el contexto de
    // log de ESTA funcion se arma a mano a partir de los campos publicos de `PublishError`, en vez
    // de reutilizar `logContext(projectId)` con un `projectId` inventado que no aplica aca.
    logger.error(
      {
        diagnosis: error.diagnosis,
        sdkErrorClass: error.sdkErrorClass,
        planoDeEscrituraAbierto: error.planoDeEscrituraAbierto,
        ...(error.errorCode === undefined ? {} : { code: error.errorCode }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.coreMessage === undefined ? {} : { errorMessage: error.coreMessage }),
        nombre: adjunto.filename,
        mime: adjunto.mimeType,
      },
      'fallo la publicacion de files.request-upload',
    );

    return {
      tipo: 'fallido',
      diagnosis: error.diagnosis,
      nombre: adjunto.filename,
      mime: adjunto.mimeType,
    };
  }

  // La respuesta SE VALIDA. `command<T>()` devuelve `reply.data` tal cual, sin comprobar que
  // coincida con `T` -- mismo hallazgo verificado que motiva la validacion en
  // `publish-requirement.ts`. Una respuesta de exito sin `id`/`uploadUrl` usables es un
  // FALLO, no un exito parcial (CA-3).
  const reply = fileUploadReplySchema.safeParse(data);

  if (!reply.success) {
    logger.error(
      { diagnosis: 'respuesta_ilegible', nombre: adjunto.filename, mime: adjunto.mimeType },
      'fallo la publicacion de files.request-upload',
    );

    return {
      tipo: 'fallido',
      diagnosis: 'respuesta_ilegible',
      nombre: adjunto.filename,
      mime: adjunto.mimeType,
    };
  }

  // NUNCA se loguea el exito de ESTA funcion: `fileId` solo es informativo hasta que S-021 lo
  // vincule con un requisito, y `uploadUrl` es una credencial de escritura de corta duracion que
  // NUNCA se loguea en ningun caso (RF-23, RF-39 de REQ-004).
  //
  // `id` es el nombre del contrato del bus; `fileId` es el del resultado del conector, el mismo que
  // usa `requirements.new` en su `fileIds` para vincular este archivo.
  return { tipo: 'concedido', fileId: reply.data.id, uploadUrl: reply.data.uploadUrl };
}
