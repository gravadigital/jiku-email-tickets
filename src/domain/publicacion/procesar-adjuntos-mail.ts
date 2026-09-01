import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { AdjuntosConfig } from '#config/index.js';
import { procesarAdjuntos } from '#domain/adjuntos/procesar.js';
import type { AdjuntoAceptado, AdjuntoRechazado } from '#domain/adjuntos/types.js';
import type { MailAttachment } from '#domain/ingesta/types.js';
import { requestFileUpload as requestFileUploadReal } from '#domain/publicacion/upload-file.js';
import { uploadFileContent as uploadFileContentReal } from '#domain/publicacion/upload-byte.js';

/**
 * El orquestador central de la story: la pieza NUEVA que conecta S-017 (particion/dedup/tope),
 * S-018 (permiso de subida) y S-019 (el `PUT`) para UN mail completo. Ninguna de las tres sabe
 * nada de las otras ni del ciclo completo -- esta funcion es la que las conecta.
 *
 * Responsabilidad exclusiva (ver Story Plan -> Task 3):
 * - Aislamiento de fallos por adjunto (CA-6, RF-34): un `try/catch` alrededor de TODO el
 *   procesamiento de un adjunto individual, para capturar cualquier error de programacion
 *   inesperado sin abortar el `for`.
 * - Preservar el orden "par por archivo" (CA-2): `requestFileUpload()` seguido INMEDIATAMENTE de
 *   `uploadFileContent()`, antes de pasar al siguiente adjunto -- nunca pedir todos los permisos
 *   primero.
 * - No reponer excedentes cuando un `PUT` falla (CA-5): el tope ya lo aplico `aplicarTope()`
 *   (dentro de `procesarAdjuntos()`), esta funcion NO vuelve a tocar los rechazados por
 *   `tope_excedido` para intentar subir uno en lugar de un fallido.
 * - Traducir cada `AdjuntoRechazado` y cada variante `rechazado`/`fallido` a un texto de aviso
 *   concreto, nombrando el archivo (RF-31).
 * - Distinguir en el LOG (no en la descripcion) un rechazo local (`info`) de un rechazo de `core`
 *   (`warn` + `code`, ya emitido por `requestFileUpload()`) -- CA-12, RF-40. El rechazo local
 *   (`particionar()`/`deduplicar()`/`aplicarTope()`) no logueaba nada todavia (S-017 es puro):
 *   ESTA funcion es quien logea por primera vez cada `AdjuntoRechazado`, con nivel `info`.
 *
 * NUNCA lanza para un resultado de negocio (rechazo, fallo de archivo) -- siempre devuelve. La
 * unica forma de que algo escape hacia el llamador es un bug de programacion fuera del alcance de
 * los `try/catch` de esta funcion (no deberia ocurrir con la implementacion correcta).
 *
 * NO importa `componerDescripcion()`: devuelve las piezas crudas (`avisosDeRechazo`,
 * `avisosDeFallo`, `placeholders`, `fileIds`) -- quien compone la descripcion final con el
 * `cuerpoBase` es el llamador (Task 4), para mantener esta funcion enfocada exclusivamente en el
 * ciclo de vida del adjunto, no en el ensamblado del texto final.
 */

/** El resultado del procesamiento completo de los adjuntos de UN mail. */
export interface ProcesamientoAdjuntosResultado {
  /** Los `fileId` de los adjuntos subidos con exito, EN EL ORDEN en que se subieron. */
  readonly fileIds: number[];
  /** Un texto por cada adjunto rechazado (local o de `core`), nombrando el archivo. */
  readonly avisosDeRechazo: string[];
  /** Un texto por cada adjunto cuyo permiso o `PUT` fallo, nombrando el archivo. */
  readonly avisosDeFallo: string[];
  /** Un placeholder por cada adjunto subido con exito, en el MISMO orden que `fileIds`. */
  readonly placeholders: string[];
}

export interface ProcesarAdjuntosDelMailDeps {
  /** El cliente conectado. El mismo que ya usa `publishRequirementFromMail()`. */
  readonly client: Client;
  readonly logger: Logger;
  /**
   * Inyectables SOLO para tests -- mismo patron que `Normalize` en `tick.ts` (S-016): el default
   * es la implementacion real (S-018), y los tests inyectan un doble que lanza deliberadamente
   * una excepcion arbitraria para ejercitar el `try/catch` de programacion de esta funcion (CA-6,
   * RF-34, TS-10), algo que la implementacion real nunca hace por diseno (siempre resuelve un
   * `UploadResultado` tipado, nunca lanza para un resultado de negocio).
   */
  readonly requestFileUpload?: typeof requestFileUploadReal;
  /** Igual que `requestFileUpload`, para `uploadFileContent()` (S-019). */
  readonly uploadFileContent?: typeof uploadFileContentReal;
}

/**
 * Arma el aviso de rechazo de un `AdjuntoRechazado` de la politica local (particion/dedup/tope), y
 * loguea `info`: es el funcionamiento esperado del filtro local (RF-6, RF-40), nunca `warn` -- ese
 * nivel es exclusivo del rechazo de `core` via `requestFileUpload()` (CA-12).
 *
 * Mismo shape de campos (`nombre`, `mime`, mas el campo especifico -- `regla` en vez de `code`)
 * que usa `requestFileUpload()` para su rechazo `warn`, por consistencia de lectura entre ambos
 * niveles.
 */
function avisarRechazoLocal(rechazo: AdjuntoRechazado, logger: Logger): string {
  logger.info(
    { nombre: rechazo.nombre, mime: rechazo.mime, regla: rechazo.regla },
    'adjunto rechazado por la politica local',
  );

  return `No se pudo adjuntar ${rechazo.nombre}: no cumple la politica de archivos permitidos.`;
}

/** El placeholder de un adjunto subido, segun su MIME declarado (RF-30: "los `image/*`"). */
function placeholderPara(adjunto: Pick<AdjuntoAceptado, 'mimeType'>, fileId: number): string {
  return adjunto.mimeType.startsWith('image/') ? `![attach:${String(fileId)}]` : `[attach:${String(fileId)}]`;
}

/**
 * Procesa UN adjunto ya aceptado por la politica local: permiso de subida + `PUT` inmediato si el
 * permiso fue concedido. Devuelve la pieza a acumular en el resultado final del mail.
 *
 * El `try/catch` que envuelve TODO este procesamiento vive en el llamador (`procesarAdjuntosDelMail`),
 * no aca -- es lo que permite que una excepcion de PROGRAMACION inesperada (ej. una excepcion
 * calculando algo, no contemplada por `UploadResultado`/`PutResultado`) se capture en un solo punto,
 * comun a toda la iteracion de UN adjunto (CA-6, RF-34).
 */
async function procesarUnoAceptado(
  adjunto: AdjuntoAceptado,
  config: Pick<AdjuntosConfig, 'putTimeoutMs'>,
  { client, logger, requestFileUpload = requestFileUploadReal, uploadFileContent = uploadFileContentReal }: ProcesarAdjuntosDelMailDeps,
): Promise<
  | { readonly resultado: 'subido'; readonly fileId: number; readonly placeholder: string }
  | { readonly resultado: 'rechazado'; readonly aviso: string }
  | { readonly resultado: 'fallido'; readonly aviso: string }
> {
  // Permiso de subida. `requestFileUpload()` ya logueo internamente su propio rechazo (`warn` +
  // `code`) o fallo (`error`) -- esta funcion NO vuelve a loguearlos (evita la linea duplicada).
  const permiso = await requestFileUpload(
    { filename: adjunto.filename, mimeType: adjunto.mimeType, content: adjunto.content, checksum: adjunto.checksum },
    { client, logger },
  );

  if (permiso.tipo === 'rechazado') {
    // Rechazo de NEGOCIO de `core` (el archivo paso el filtro local pero `core` lo rechaza): mismo
    // bloque de la descripcion que un rechazo local (CA-12), pero el log warn+code ya lo emitio
    // requestFileUpload() -- aca solo se arma el texto del aviso.
    return {
      resultado: 'rechazado',
      aviso: `No se pudo adjuntar ${permiso.nombre}: ${permiso.codigo === 'file_type_not_allowed' ? 'tipo de archivo no permitido' : 'el archivo excede el tamano permitido'}.`,
    };
  }

  if (permiso.tipo === 'fallido') {
    // Fallo de PUBLICACION del comando (no un rechazo de negocio): aviso de FALLO de subida,
    // bloque distinto del de rechazo. requestFileUpload() ya logueo error internamente.
    return { resultado: 'fallido', aviso: `No se pudo subir ${permiso.nombre}: error al subir el archivo.` };
  }

  // permiso.tipo === 'concedido': el PUT ocurre INMEDIATAMENTE, antes de pasar al siguiente
  // adjunto (CA-2, "par por archivo"). uploadFileContent() ya logueo internamente su propio warn
  // de fallo -- aca solo se arma el texto del aviso.
  const put = await uploadFileContent(
    { filename: adjunto.filename, mimeType: adjunto.mimeType, content: adjunto.content },
    { uploadUrl: permiso.uploadUrl, timeoutMs: config.putTimeoutMs, logger },
  );

  if (put.tipo === 'fallido') {
    return { resultado: 'fallido', aviso: `No se pudo subir ${adjunto.filename}: error al subir el archivo.` };
  }

  return {
    resultado: 'subido',
    fileId: permiso.fileId,
    placeholder: placeholderPara(adjunto, permiso.fileId),
  };
}

/**
 * Procesa el ciclo completo de los adjuntos de UN mail: particion -> dedup -> tope, y para cada
 * aceptado dentro del tope, EN SERIE, permiso de subida + `PUT` inmediato.
 *
 * Se invoca UNA vez por mail, nunca acumula estado entre invocaciones (sin variables de modulo, sin
 * cache) -- respeta que no hay dedup entre mails distintos (RF-9).
 *
 * Ningun array de esta funcion retiene el `content: Buffer` de un adjunto mas alla de lo necesario
 * para el `PUT` de ESE adjunto (CA-11): no se construye ninguna lista de "adjuntos procesados" con
 * su contenido -- el resultado final solo lleva ids, textos y placeholders, nunca un `Buffer`.
 */
export async function procesarAdjuntosDelMail(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes' | 'putTimeoutMs'>,
  deps: ProcesarAdjuntosDelMailDeps,
): Promise<ProcesamientoAdjuntosResultado> {
  const { aceptados, rechazados } = procesarAdjuntos(attachments, config);

  const fileIds: number[] = [];
  const avisosDeRechazo: string[] = [];
  const avisosDeFallo: string[] = [];
  const placeholders: string[] = [];

  // Los rechazos de la politica local (particion/dedup/tope, incluido `tope_excedido` -- RF-13)
  // van primero, en el orden en que `procesarAdjuntos()` los produjo.
  for (const rechazo of rechazados) {
    avisosDeRechazo.push(avisarRechazoLocal(rechazo, deps.logger));
  }

  // EN SERIE, en el orden de `aceptados` (ya filtrado y topeado por procesarAdjuntos()) -- nunca
  // Promise.all/allSettled (CA-2, ADR-001). Nunca se repone un excedente `tope_excedido` con un
  // fallido: el `for` solo itera sobre `aceptados`, que ya excluye los excedentes (CA-5).
  for (const adjunto of aceptados) {
    try {
      const resultado = await procesarUnoAceptado(adjunto, config, deps);

      if (resultado.resultado === 'subido') {
        fileIds.push(resultado.fileId);
        placeholders.push(resultado.placeholder);
      } else if (resultado.resultado === 'rechazado') {
        avisosDeRechazo.push(resultado.aviso);
      } else {
        avisosDeFallo.push(resultado.aviso);
      }
    } catch (cause) {
      // Error de PROGRAMACION inesperado (ej. una excepcion no contemplada por los tipos de
      // retorno de requestFileUpload()/uploadFileContent()) -- se captura, se loguea `error` SIN
      // exponer el contenido del adjunto, se agrega un aviso de FALLO, y el `for` CONTINUA con el
      // siguiente adjunto (CA-6, RF-34). Nunca escapa hacia el llamador.
      deps.logger.error(
        { nombre: adjunto.filename, mime: adjunto.mimeType, err: cause },
        'error inesperado procesando un adjunto',
      );
      avisosDeFallo.push(`No se pudo subir ${adjunto.filename}: error al subir el archivo.`);
    }
  }

  return { fileIds, avisosDeRechazo, avisosDeFallo, placeholders };
}
