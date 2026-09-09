import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { IncomingMail } from '#domain/ingesta/types.js';
import { commentReplySchema, commentSchema } from '#domain/publicacion/comment.schema.js';
import { PublishError, diagnosePublishFailure } from '#domain/publicacion/publish-errors.js';

/**
 * La publicacion de `requirements.{id}.comment`: el TERCER punto de escritura del conector, junto a
 * `requirements.new` (`publish-requirement.ts`) y `files.request-upload` (`upload-file.ts`).
 *
 * Es la salida que abre S-027: una respuesta con match en el Mapa de Hilos deja de descartarse y se
 * publica como Comentario PUBLICO sobre el Requisito del hilo.
 *
 * EL MOLDE ES `upload-file.ts`, NO `publish-requirement.ts`, y las dos mitades vienen de lados
 * distintos a proposito:
 *
 * - De `upload-file.ts` sale COMO ARMAR EL CONTEXTO DE ERROR SIN `projectId` (ver abajo).
 * - De `publish-requirement.ts` sale que RELANZA un `PublishError` en vez de devolver un resultado
 *   tipado. La diferencia con `upload-file.ts` es deliberada: `requestFileUpload()` devuelve porque
 *   el orquestador de adjuntos itera un `for` que no puede interrumpirse; el comentario ES LA
 *   OPERACION PRINCIPAL de su rama, igual que el alta, asi que relanza y el tick cuenta `fallidos`
 *   en su `catch`.
 */

/**
 * Las dos mitades del metodo. El `{id}` va interpolado en EL METODO, no en el subject:
 * `client.command()` arma `{instance}.{userId}.jiku-commands.v1.requirements.{id}.comment` a partir
 * de el.
 *
 * INTERPOLAR ACA NO ES ARMAR UN SUBJECT A MANO y no viola ADR-002. Lo prohibido es escribir
 * `jiku-commands.v1` o `_INBOX` en el codigo —eso sigue prohibido y hay un test que lo afirma—; el
 * contrato de `core` se titula, literalmente, `requirements.{id}.comment`, asi que el id en el
 * metodo es su uso previsto.
 *
 * Van como DOS constantes y no como un template suelto en la llamada por el mismo criterio que el
 * `const COMMAND` de las hermanas: el nombre del comando vive declarado en el modulo, no inline.
 */
const COMMAND_PREFIX = 'requirements.';
const COMMAND_SUFFIX = '.comment';

export interface PublishCommentFromMailDeps {
  /** El cliente conectado. El MISMO de S-004: no hay segundo `connect()` (ADR-002). */
  readonly client: Client;
  readonly logger: Logger;
}

/**
 * Publica el comentario sobre el Requisito del hilo.
 *
 * EL TEXTO LLEGA YA COMPUESTO POR PARAMETRO: esta funcion NO importa `description.ts` ni compone
 * nada. Es el mismo reparto que la rama del alta — el tick compone con `componerDescripcion()` (los
 * cuatro bloques en orden fijo, invariante 21) y pasa el resultado.
 *
 * `archivosConAviso` es solo para la linea de exito, igual que en `publishRequirementFromMail()`.
 *
 * No devuelve el `commentId`, y no es un olvido: el `id` de la reply se valida (una reply de exito
 * sin `id` usable es un FALLO, no un exito con hueco) pero NO SE USA NI SE LOGUEA — no aporta
 * ningun diagnostico que el `requirementId` no de ya.
 */
export async function publishCommentFromMail(
  mail: Pick<IncomingMail, 'messageId'>,
  requirementId: number,
  comment: string,
  { client, logger }: PublishCommentFromMailDeps,
  fileIds: readonly number[] = [],
  archivosConAviso = 0,
): Promise<void> {
  // El payload se valida ANTES de publicar, mismo criterio que las dos hermanas: un payload
  // invalido NO se publica. Publicarlo gastaria un round-trip para que `core` conteste algo que el
  // conector ya sabia, y ensuciaria el diagnostico.
  //
  // `visibilityLevel: 'public'` EXPLICITO, y es la decision mas cara de esta funcion si se omite:
  // el default del contrato es `internal`, que es EL OPUESTO del que hace falta — un comentario
  // `internal` NO LO VERIA EL CLIENTE EN OPUS, y `core` responderia `success` igual. Es consistente
  // con el Requisito, que el conector ya crea `public`.
  //
  // `fileIds` con SPREAD CONDICIONAL y COPIA: la clave ausente es la representacion de "cero
  // adjuntos" (nunca `fileIds: []`), y `[...fileIds]` evita mandar la referencia mutable del
  // llamador al schema y de ahi al bus.
  //
  // NI `author` NI `actor`: `core` resuelve el actor del `sub` del subject (ADR-005), y el
  // `.strict()` del schema hace que colar cualquiera de las dos FALLE en vez de removerse en
  // silencio.
  const parsed = commentSchema.safeParse({
    comment,
    visibilityLevel: 'public',
    ...(fileIds.length > 0 ? { fileIds: [...fileIds] } : {}),
  });

  if (!parsed.success) {
    const error = new PublishError('error_de_armado_del_conector', parsed.error);

    logger.error(
      {
        messageId: mail.messageId,
        requirementId,
        diagnosis: error.diagnosis,
        sdkErrorClass: error.sdkErrorClass,
        planoDeEscrituraAbierto: error.planoDeEscrituraAbierto,
      },
      'fallo la publicacion de requirements.comment',
    );

    throw error;
  }

  const payload = parsed.data;
  const method = `${COMMAND_PREFIX}${String(requirementId)}${COMMAND_SUFFIX}`;

  let data: unknown;

  try {
    // DOS ARGUMENTOS, no tres. El tercero (`options`) es donde se bajaria el timeout por accidente,
    // y ADR-006 lo prohibe explicitamente: el efectivo queda en el default del SDK (15000 ms).
    //
    // `await` dentro del `try` y no un `return client.command(...)`: el error tiene que traducirse
    // DONDE OCURRE. Una promesa rechazada sin capturar sale por `unhandledRejection`, FUERA DE PINO
    // y por lo tanto SIN REDACCION — en un servicio cuyo unico borde es el log.
    //
    // Y una sola invocacion por llamada: ni `for`, ni `while`, ni backoff. Sin idempotencia, un
    // reintento publica dos comentarios donde tenia que haber uno (ADR-001).
    data = await client.command(method, payload);
  } catch (cause) {
    // LA TRADUCCION SE REUTILIZA, NO SE REESCRIBE (CA-7): las mismas nueve ramas de
    // `diagnosePublishFailure()`, sin agregar ninguna. Los errores del KV y del comando son del
    // mismo `nats-core` que el SDK ya usa.
    //
    // Que `requirement_not_found` y `file_not_owned` caigan en `core_rechazo_desconocido` NO ES UN
    // DEFECTO y no hay que "arreglarlo" agregando ramas: el catalogo de codigos lo POSEE `core` y
    // lo hace crecer, el propio `.d.ts` del SDK advierte contra el `switch` exhaustivo, y el `code`
    // real viaja igual en el contexto del log — que es lo que ADR-006 exige.
    const error = new PublishError(diagnosePublishFailure(cause), cause);

    // NO se usa `error.logContext(projectId)`: EL COMENTARIO NO TIENE `projectId`. Pasarle uno
    // inventado (el del hilo no se conoce, y `0` o `-1` son mentiras) haria que este log cruce con
    // el de `core` por un dato falso. Es exactamente la decision que `upload-file.ts` ya tomo, con
    // los dos campos de identificacion cambiados: aca son `messageId` y `requirementId`.
    //
    // Y `logContext()` NO se modifica para aceptar un `projectId` opcional: es del alta y del modo
    // de verificacion, y ampliarlo seria tocar codigo que CA-7 pide dejar quieto.
    //
    // El contexto es PLANO de un nivel: `redact.paths` de Pino no tiene comodin profundo, asi que
    // un contexto anidado dejaria un valor sin redactar sin fallar y sin avisar. Y NUNCA lleva el
    // texto del comentario (CA-21) — es contenido del cliente, misma clase que el cuerpo del mail.
    logger.error(
      {
        messageId: mail.messageId,
        requirementId,
        diagnosis: error.diagnosis,
        sdkErrorClass: error.sdkErrorClass,
        planoDeEscrituraAbierto: error.planoDeEscrituraAbierto,
        ...(error.errorCode === undefined ? {} : { code: error.errorCode }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.coreMessage === undefined ? {} : { errorMessage: error.coreMessage }),
      },
      'fallo la publicacion de requirements.comment',
    );

    // RELANZA, no traga: el tick cuenta `fallidos += 1` en su `catch` y sigue con el proximo UID.
    // Y —criticamente— el write al Mapa de Hilos, que va DESPUES en el `try` del tick, nunca se
    // alcanza (CA-10): el bucket no debe apuntar a un comentario que no existe.
    //
    // NOTA sobre el `message` del error: `PublishError` arma "No se pudo publicar requirements.new"
    // en su constructor, que para el comentario es INEXACTO. Se reutiliza tal cual igual, y es una
    // decision, no un descuido: ese `message` es prosa para el operador, mientras el dato accionable
    // viaja en `diagnosis`/`code`/`errorMessage`, y el mensaje del LOG lo pone esta funcion
    // ('fallo la publicacion de requirements.comment'), no el error. Parametrizar el nombre del
    // comando en el constructor tocaria `publish-errors.ts` y sus dos llamadores existentes, que es
    // exactamente el archivo que CA-7 pide dejar quieto.
    throw error;
  }

  // La respuesta SE VALIDA. `command<T>()` devuelve `reply.data` TAL CUAL, sin comprobar que
  // coincida con `T` (verificado en el SDK): el generico es una asercion del llamador, no una
  // garantia. Una respuesta de exito sin `id` usable es un FALLO, no un exito con hueco — y aca
  // importa el doble, porque el write al Mapa de Hilos depende de que este `success` sea real.
  const reply = commentReplySchema.safeParse(data);

  if (!reply.success) {
    const error = new PublishError('respuesta_ilegible', undefined);

    logger.error(
      {
        messageId: mail.messageId,
        requirementId,
        diagnosis: error.diagnosis,
        sdkErrorClass: error.sdkErrorClass,
        planoDeEscrituraAbierto: error.planoDeEscrituraAbierto,
      },
      'fallo la publicacion de requirements.comment',
    );

    throw error;
  }

  // UNA sola linea de exito, con los dos identificadores que permiten encontrar el comentario en
  // Jiku. El `id` de la reply YA SE VALIDO arriba y NO SE LOGUEA: el `requirementId` ya localiza la
  // conversacion, y un `commentId` extra no agrega diagnostico.
  //
  // Y NUNCA el texto (CA-21): ni `comment`, ni un fragmento, ni un largo. Es la primera linea de
  // defensa; `REDACT_PATHS` es la segunda.
  logger.info(
    {
      messageId: mail.messageId,
      requirementId,
      archivosVinculados: fileIds.length,
      archivosConAviso,
    },
    'comentario publicado en Jiku',
  );
}
