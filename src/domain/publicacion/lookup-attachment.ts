import type { Client, Collection } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { AdjuntoAceptado } from '#domain/adjuntos/types.js';
import { codeOf, diagnosePublishFailure } from '#domain/publicacion/publish-errors.js';

/**
 * LA CONSULTA DE REUSO DE ADJUNTOS CONTRA EL HILO (S-029).
 *
 * Es el CUARTO archivo de contrato de `publicacion` —junto a `upload-file.ts`
 * (`files.request-upload`), `publish-requirement.ts` (`requirements.new`) y `publish-comment.ts`
 * (`requirements.{id}.comment`)— pero el PRIMERO DE LECTURA, y por eso importa mas de lo que su
 * tamaño sugiere.
 *
 * ==== LA DEROGACION PARCIAL DE ADR-003, Y SU ALCANCE EXACTO ====
 *
 * ADR-003 declara: "El conector MUST NOT publicar en el plano de consultas (`jiku-queries.*`) ni
 * suscribirse a subjects de otros servicios". Esta story deroga LA PRIMERA MITAD, y solo eso:
 *
 *   - DEROGADO: publicar en `jiku-queries.*`, para UN recurso (`attachments.list`), desde UN
 *     archivo (este). Ningun otro recurso ni operacion del plano de lectura queda habilitado, y
 *     `test/publicacion/source-properties.test.ts` lo mantiene ejecutable: `client.query(`,
 *     `client.get(`, `client.iterate(`, `client.all(` y `client.count(` siguen prohibidos en TODO
 *     `src/`, incluido este archivo.
 *   - INTACTO: no suscribirse a subjects de otros servicios. `client.list()` es un request/reply
 *     sobre el INBOX PROPIO, no una suscripcion. Esta story no agrega ninguna.
 *
 * LA REESCRITURA DEL TEXTO DE ADR-003 ES DE S-030, no de esta story. Hasta entonces el test de
 * propiedad es la version ejecutable de la regla, y el codigo tiene razon sobre el documento.
 *
 * ==== POR QUE SE PUDO, Y NO SE PUDO ANTES ====
 *
 * Hasta S-027 la respuesta a "este byte ya esta vinculado aca?" costaba N+1 consultas, y el
 * comentario de `tick.ts` lo registraba como costo aceptado. Lo que cambio: `core` expuso
 * `checksum` como FILTRABLE e INCLUIBLE en `attachments.list` (su REQ-014), con esta nota verbatim
 * en el contrato — "Es FILTRABLE para que un consumidor pueda deduplicar contra los vinculos ya
 * existentes en UNA consulta, combinandolo con `uploadedBy`". No se esta estirando el contrato: se
 * lo esta usando como fue diseñado.
 *
 * ==== SU CONTRATO ES EL DE `requestFileUpload()`, NO EL DE `publishCommentFromMail()` ====
 *
 * Vive dentro del `for` de adjuntos de `procesarAdjuntosDelMail()`, que NO PUEDE INTERRUMPIRSE.
 * Asi que agota sus fallos internamente y devuelve una union de DOS variantes SIN NINGUNA DE
 * ERROR. Relanzar haria que el `try/catch` de programacion del orquestador contara como FALLIDO un
 * adjunto que se subio bien — un aviso mentiroso al cliente.
 */

/** El recurso del plano de lectura. El SDK deriva `attachments.list` y el subject completo. */
const RESOURCE = 'attachments';

/**
 * El `entityType` del contrato. Es uno de los cinco valores del enum del recurso
 * (`[project, requirement, requirement_comment, task, task_comment]`), declarado como constante
 * por el mismo criterio que el `const COMMAND` de las hermanas: el nombre del contrato vive
 * declarado en el modulo, no inline en la llamada.
 */
const ENTITY_TYPE = 'requirement';

/**
 * El tipo de la fila que se pide. `fileId` porque es lo unico que se necesita; `checksum` porque
 * `include: ['checksum']` lo trae y hace la fila AUTOVERIFICABLE en un test, en vez de confiar en
 * que el filtro se aplico. `id` vuelve siempre, pedido o no.
 */
interface AttachmentRow {
  readonly id: number;
  readonly fileId: number;
  readonly checksum: string;
}

/**
 * DOS variantes y NINGUNA de error, y es EL contrato de esta funcion.
 *
 * Es el mismo criterio de `UploadResultado` y `PutResultado`, y por la misma razon: el `for` de
 * `procesarAdjuntosDelMail()` NO PUEDE INTERRUMPIRSE. Relanzar haria que el `try/catch` de
 * programacion del orquestador contara como FALLIDO un adjunto que se subio bien — un aviso
 * mentiroso al cliente.
 *
 * Y la degradacion NO TIENE VARIANTE PROPIA a proposito: un fallo de la consulta devuelve
 * `sin_match`, la MISMA forma que "pregunte y no hay". El llamador no puede distinguirlos, y eso
 * es deliberado — no tiene nada distinto que hacer con cada uno.
 */
export type LookupAttachmentResultado =
  | { readonly tipo: 'reusado'; readonly fileId: number }
  | { readonly tipo: 'sin_match' };

export interface LookupAttachmentDeps {
  /** El cliente conectado. El MISMO de S-004: no hay segundo `connect()` (ADR-002). */
  readonly client: Client;
  readonly logger: Logger;
}

export interface LookupAttachmentOptions {
  /**
   * NO recibe el byte, y es una decision, no un olvido (CA-17): el `checksum` YA viene calculado
   * por `deduplicar()`, que es el UNICO lugar donde se hashea. Recibir el byte invitaria a
   * recalcularlo y crearia una segunda fuente de verdad del hash.
   */
  readonly adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'checksum'>;
  /** El `requirementId` que devolvio `lookupThread()`. Es el `entityId` de la consulta. */
  readonly requirementId: number;
}

/**
 * Pregunta a `attachments.list` si el `checksum` de un adjunto aceptado ya esta vinculado al
 * Requisito del hilo POR EL PROPIO CONECTOR, y devuelve el `fileId` existente para reusarlo.
 *
 * NUNCA LANZA. Para ninguna entrada y para ningun fallo del bus.
 */
export async function lookupAttachmentByChecksum(
  { adjunto, requirementId }: LookupAttachmentOptions,
  { client, logger }: LookupAttachmentDeps,
): Promise<LookupAttachmentResultado> {
  // El tipo se declara ACA y no como parametro generico de `client.list<AttachmentRow>(...)`, y
  // no es una preferencia estetica: el test de propiedad de ADR-003 busca el literal
  // `client.list(` para afirmar que ESTE es el unico archivo autorizado a tocar el plano de
  // lectura, y un `<AttachmentRow>` entre el nombre y el parentesis lo haria invisible al escaneo
  // — el test pasaria en verde sin ver la unica llamada que tiene que vigilar.
  let page: Collection<AttachmentRow>;

  try {
    // DOS ARGUMENTOS, no tres — mismo criterio que las tres hermanas: el tercero (`options`) es
    // donde se bajaria el timeout por accidente, y ADR-006 lo prohibe. El efectivo queda en el
    // del cliente, el mismo de los tres comandos.
    //
    // LOS CUATRO FILTROS SON OBLIGATORIOS Y POR RAZONES DISTINTAS. No se "simplifica" ninguno:
    //
    // - `entityType` + `entityId` acotan AL REQUISITO DEL HILO. Son los que impiden el cruce
    //   entre proyectos (CA-8) — y NO `uploadedBy`: el conector sube TODO con la misma identidad,
    //   asi que sin `entityId` el match seria GLOBAL, y un archivo de un cliente se reusaria en
    //   el requisito de otro.
    // - `checksum` es la pregunta misma: "este byte, ya esta vinculado aca?".
    // - `uploadedBy` garantiza que el `fileId` reusado sea SIEMPRE vinculable, sin riesgo de
    //   `file_not_owned` — que descartaria la escritura ENTERA del comentario (CA-3).
    //
    // `include: ['checksum']` va aunque el checksum viaje ya en el `filter`, y NO es redundante:
    // `include` decide QUE VUELVE, `filter` decide QUE FILAS. Hace la fila autoverificable.
    //
    // `limit: 1` porque cualquier match sirve: todos los candidatos son byte-identicos y todos
    // son del caller. NO SE PAGINA y no se consulta la ausencia de cursor — no hay segunda
    // pagina que pedir (CA-16). `count` NO se manda: solo importa si hay al menos uno, y eso lo
    // dice `items.length`.
    page = await client.list(RESOURCE, {
      filter: {
        entityType: ENTITY_TYPE,
        entityId: requirementId,
        checksum: adjunto.checksum,
        // `client.userId` es el `sub` del caller, NUNCA un valor del entorno ni de un parametro
        // (hay un test de propiedad que prohibe declarar el user-id por entorno). Y `uploadedBy`
        // NO es una de las claves de identidad que el plano de lectura rechaza: es el nombre de
        // una COLUMNA FILTRABLE del recurso, no una afirmacion sobre quien pregunta. Quien
        // pregunta lo dice el subject, y solo el subject.
        uploadedBy: client.userId,
      },
      include: ['checksum'],
      fields: ['fileId'],
      limit: 1,
    });
  } catch (cause) {
    // LA DEGRADACION. Los seis codigos del contrato, mas el `JikuError` generico que lanza
    // `client.list()` cuando la respuesta no es una coleccion, mas cualquier clase del SDK: TODOS
    // caen aca y TODOS devuelven `sin_match`. La consecuencia asumida es el duplicado que ya
    // existe hoy — nunca un adjunto ni un ticket perdido.
    //
    // `diagnosePublishFailure()` REUSADA SIN AGREGARLE NI UNA RAMA (CA-6). `query_timeout` es un
    // codigo nuevo para este conector y cae, correctamente, en `core_rechazo_desconocido`: el
    // catalogo de codigos es de `core` y crece, y un codigo desconocido es un resultado NORMAL,
    // no un caso residual.
    const diagnosis = diagnosePublishFailure(cause);
    const code = codeOf(cause);

    // `warn` y NO `error`: el resultado del mail es CORRECTO (el adjunto llega, el comentario se
    // publica). Un `error` diria que algo se perdio; un `info` esconderia que una optimizacion
    // dejo de funcionar.
    //
    // Contexto PLANO, de un solo nivel: la redaccion de S-003 no tiene comodin profundo, asi que
    // un contexto anidado dejaria un secreto en claro sin fallar ni avisar. Y ningun campo se
    // llama `key`: `REDACT_PATHS` lo redactaria en silencio y sin avisar.
    //
    // El `checksum` SI va (CA-14): es un hash, no el byte, y es el dato que cruza este log con el
    // de `core`. Lo que NO va: el byte del adjunto, el cuerpo del mail, el texto del comentario.
    logger.warn(
      {
        checksum: adjunto.checksum,
        requirementId,
        diagnosis,
        // `cause.constructor.name` y NO un `instanceof` por clase: es lo que ya hace
        // `PublishError`, y por la razon documentada alli — sirve para el log y NO DEPENDE de la
        // identidad de constructor entre copias del paquete.
        sdkErrorClass: cause instanceof Error ? cause.constructor.name : typeof cause,
        resultado: 'consulta_fallida',
        // Spread condicional: `codeOf()` devuelve `undefined` cuando no hubo reply de `core`
        // (`JikuTimeout`, `JikuNoEndpoint`, el `JikuError` de forma), y una clave con `undefined`
        // en el contexto es ruido que sugiere que el dato existe y esta vacio.
        ...(code === undefined ? {} : { code }),
      },
      'fallo la consulta de reuso de adjuntos',
    );

    return { tipo: 'sin_match' };
  }

  // UN `list` NUNCA CONTESTA UN `*_not_found`: la ausencia de match es un `success` con la
  // coleccion vacia, NO un error. Por eso este camino no loguea `warn`.
  //
  // Las CUATRO situaciones que producen `items: []` llegan todas por aca, indistinguibles a
  // proposito: el archivo nunca estuvo en este Requisito; lo subio otro actor (`uploadedBy`);
  // esta en otro Requisito (`entityId`); o su vinculo se borro / su archivo no esta retenido —
  // las DOS EXCLUSIONES PERMANENTES del predicado fijo del recurso, que NO SE PUEDEN
  // SOBRESCRIBIR desde el payload. El conector no puede reusar un vinculo borrado NI
  // EQUIVOCANDOSE (CA-10).
  //
  // `page.items[0]` con guarda `=== undefined`, y NO `page.items.length > 0`:
  // `noUncheckedIndexedAccess` esta activo, asi que el indice devuelve `T | undefined` y el
  // compilador exige la guarda. Es el mismo patron que ya usa `respondTo()` con `sequence.at(-1)`.
  const primero = page.items[0];

  if (primero === undefined) {
    logger.info(
      { checksum: adjunto.checksum, requirementId, resultado: 'sin_match' },
      'sin reuso: el adjunto no esta vinculado al requisito del hilo',
    );

    return { tipo: 'sin_match' };
  }

  logger.info(
    { checksum: adjunto.checksum, requirementId, fileId: primero.fileId, resultado: 'reusado' },
    'adjunto reusado del hilo',
  );

  return { tipo: 'reusado', fileId: primero.fileId };
}
