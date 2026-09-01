import type { Logger } from 'pino';

import type { AdjuntoAceptado } from '#domain/adjuntos/types.js';

/**
 * El cliente del `PUT` HTTPS: la mitad del contrato de ADR-003 que faltaba. S-018
 * (`upload-file.ts`) ya resolvio el permiso (`files.request-upload` -> `fileId` + `uploadUrl`);
 * esta funcion resuelve el segundo plano -- el byte -- tal como el ADR lo separa explicitamente
 * ("La escritura de un adjunto queda entonces en dos planos separados: el permiso y el byte").
 *
 * DIFERENCIA DELIBERADA con el resto de `publicacion/`: esta funcion NUNCA toca el bus. Su unica
 * I/O es un `fetch` HTTPS directo a la `uploadUrl` prefirmada por `core` -- sin `client.command()`,
 * sin `Client` del SDK, sin credenciales de storage propias. La unica autorizacion es la firma que
 * `core` ya incluyo en la URL (CA-1).
 */

/** El resultado tipado de una subida: llego el byte o no, sin distinguir la causa del fallo. */
export type PutResultado =
  | { readonly tipo: 'subido' }
  | { readonly tipo: 'fallido' };

export interface UploadFileContentDeps {
  /** La URL prefirmada por `core`, recibida de `files.request-upload` (`tipo: 'concedido'`). */
  readonly uploadUrl: string;
  /** El timeout del PUT en ms -- SIEMPRE `config.adjuntos.putTimeoutMs`, nunca un literal aca. */
  readonly timeoutMs: number;
  readonly logger: Logger;
}

/**
 * Sube el byte de UN adjunto ya aceptado, directo al storage S3-compatible.
 *
 * Recibe `Pick<AdjuntoAceptado, ...>`, no el tipo completo -- mismo criterio de `Pick` que
 * `requestFileUpload()`. `filename` viaja SOLO para el contexto del log de fallo (`nombre`): no
 * participa del `PUT` en si (ni URL, ni headers, ni body).
 *
 * Aridad de exactamente 2 parametros (CA-8): la funcion no orquesta ningun bucle, recibe un
 * adjunto singular y devuelve un resultado para ESE adjunto. La orquestacion en serie de todos los
 * adjuntos de un mail la hace S-021.
 *
 * NUNCA lanza para un resultado de negocio (exito o fallo del PUT) -- siempre devuelve un valor
 * tipado, mismo criterio que `UploadResultado` de S-018. El `try/catch` envuelve TODA la
 * construccion del `RequestInit` y la invocacion de `fetch`, no solo el `await fetch(...)`: asi un
 * error inesperado del propio codigo del conector armando la llamada (CA-7) comparte el mismo
 * bloque `catch` -- y por lo tanto el mismo resultado y el mismo log -- que un error de red o de
 * timeout (CA-4), sin bifurcar por causa y sin codigo duplicado.
 */
export async function uploadFileContent(
  adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'content'>,
  { uploadUrl, timeoutMs, logger }: UploadFileContentDeps,
): Promise<PutResultado> {
  try {
    // Sin ningun header de autorizacion propio, sin ninguna otra clave en el RequestInit: la unica
    // autorizacion es la firma que `core` ya incluyo en la `uploadUrl` (CA-1). `fetch` y
    // `AbortSignal.timeout` son nativos de Node >= 18 -- el piso del servicio es 22.12, asi que no
    // hace falta ningun import ni dependencia npm nueva.
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: adjunto.content,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Cualquier 2xx es exito, SIN inspeccionar el cuerpo (CA-3): ni `response.json()`, ni
    // `response.text()`, ni ningun otro metodo de lectura del body -- leerlo "por las dudas"
    // violaria CA-3 y ademas consumiria el stream innecesariamente. Un no-2xx (incluida una URL
    // expirada, tipicamente 403) cae en el mismo resultado que un error de red o de timeout: CA-4
    // exige tratamiento identico, sin una rama que distinga la causa.
    if (response.ok) {
      return { tipo: 'subido' };
    }

    // No se loguea el status ni ningun dato de la response aca: el unico log del camino de fallo es
    // el bloque comun de abajo, para que las tres causas (red, timeout, no-2xx) pasen por el MISMO
    // punto de log, con el MISMO contenido.
    logger.warn({ nombre: adjunto.filename, mime: adjunto.mimeType }, 'fallo el PUT del adjunto al storage');

    return { tipo: 'fallido' };
  } catch {
    // Cubre TRES causas distintas con el mismo resultado y el mismo log, deliberadamente sin
    // bifurcar (CA-4): un error de red (`TypeError` de `fetch`), un timeout real
    // (`AbortSignal.timeout()` dispara y `fetch` rechaza con `AbortError`/`DOMException`), y
    // cualquier excepcion inesperada del propio codigo del conector armando el `RequestInit` (CA-7)
    // -- el `try` empieza ANTES de la invocacion de `fetch`, asi que un fallo de armado cae en el
    // mismo `catch`. Nunca se relanza: es un resultado de negocio, no un bug de programacion.
    logger.warn({ nombre: adjunto.filename, mime: adjunto.mimeType }, 'fallo el PUT del adjunto al storage');

    return { tipo: 'fallido' };
  }
}
