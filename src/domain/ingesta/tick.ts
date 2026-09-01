import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';
import { MissingMessageIdError } from '#domain/ingesta/errors.js';
import { normalize as normalizeMail } from '#domain/ingesta/normalize.js';
import type { MailSource } from '#domain/ingesta/ports.js';
import { componerDescripcion } from '#domain/publicacion/description.js';
import { resolveCuerpoBase } from '#domain/publicacion/mail-payload.js';
import { procesarAdjuntosDelMail } from '#domain/publicacion/procesar-adjuntos-mail.js';
import { PublishError } from '#domain/publicacion/publish-errors.js';
import { publishRequirementFromMail } from '#domain/publicacion/publish-requirement.js';
import { routeMail } from '#domain/ruteo/route-mail.js';
import { type ImapFlowCtor, withMailSource } from '#infra/imap/client.js';

/**
 * El tick: toma los mails `\Unseen` mas nuevos hasta el cap, los marca `\Seen` de a uno apenas se
 * descargan, aisla el fallo de un mail del resto del lote, y emite los cinco contadores tambien
 * cuando el tick falla.
 *
 * Es la composicion de `MailSource` (S-009) y `normalize()` (S-008) — ninguno de los dos conoce
 * cap, orden, marcado de a uno ni aislamiento de fallos: esas reglas viven ACA, deliberadamente
 * aisladas de sus insumos (ver Story Plan -> Service Architecture).
 */

/**
 * Los cinco contadores que el tick emite en una unica linea, siempre — con exito o con fallo.
 *
 * `creados` cuenta las altas que `publishRequirementFromMail()` (S-015) confirma con exito;
 * `fallidos` cuenta tanto un alta que esa funcion relanza como (desde S-010) un fallo de parseo
 * generico (`no_parseable`). `descartados` cuenta los cinco motivos reales (S-014): los tres que
 * decide `routeMail()` (`es_respuesta`, `sin_slug`, `slug_no_mapeado`) mas `sin_message_id` (via
 * `MissingMessageIdError`, distinguido por CLASE en el `catch` de `normalize()`, nunca por texto —
 * ADR-002).
 */
export interface TickCounters {
  ingestados: number;
  parseados: number;
  creados: number;
  descartados: number;
  fallidos: number;
}

/**
 * El tipo de `normalize()`, inyectable SOLO para tests.
 *
 * `mailparser` es tolerante con bytes invalidos (no lanza, produce `messageId: undefined`, que ya
 * es el camino de `MissingMessageIdError`) — no existe un fixture `.eml` real que fuerce un fallo
 * de parseo distinto. Para poder testear ese camino (CA-5, CA-7: "un mensaje descargado que no se
 * parsea") sin mockear el modulo `mailparser`, esta funcion se recibe por parametro con el mismo
 * patron que `imapFlowCtor` en `infra/imap/client.ts`: el default es la implementacion real, y los
 * tests inyectan un doble que lanza deliberadamente.
 */
export type Normalize = typeof normalizeMail;

/**
 * Extrae el `messageId` de un error de `normalize()`, si el error lo expone.
 *
 * `MissingMessageIdError` no tiene uno (el mail no lo tiene: no hay nada que extraer). Cualquier
 * otro fallo de parseo tampoco garantiza haber llegado a leer el header antes de romperse — en
 * ambos casos esta funcion devuelve `undefined`, que Pino omite del contexto sin loguear un
 * placeholder inventado.
 */
function extractMessageIdIfAny(): string | undefined {
  return undefined;
}

/**
 * El loop del tick: cap, orden, marcado de a uno, aislamiento de fallos y contadores.
 *
 * Recibe el `MailSource` YA ABIERTO (no lo construye: eso es responsabilidad de `withMailSource`,
 * invocado desde `runIngestaTick`) y `config`/`logger` por parametro — nunca `getLogger()` ni un
 * adaptador instanciado directamente, para poder inyectar dobles en tests sin tocar singletons.
 *
 * Si `mailSource.searchUnseen()` lanza (p. ej. `withMailSource` dejo pasar un fallo de conexion a
 * mitad, o la busqueda misma falla), esta funcion NO se traga el error: el `finally` emite la
 * linea de metricas igual (Riesgo 4, CA-11) y el error se propaga hacia `runIngestaTick`, que es
 * quien lo loguea `error` sin credenciales.
 */
export async function runTick(
  mailSource: MailSource,
  config: AppConfig,
  logger: Logger,
  client: Client,
  normalize: Normalize = normalizeMail,
): Promise<void> {
  const counters: TickCounters = {
    ingestados: 0,
    parseados: 0,
    creados: 0,
    descartados: 0,
    fallidos: 0,
  };
  // ^ FUERA del try: es lo que permite que el finally emita la linea de metricas aunque algo de
  // abajo lance (Riesgo 4). Nunca mover esta declaracion dentro del try.

  try {
    const uids = await mailSource.searchUnseen(); // total sin recortar, UID descendente (S-009)
    const total = uids.length;
    const batch = uids.slice(0, config.poll.maxPerTick);

    if (total > batch.length) {
      logger.warn({ diferidos: total - batch.length }, 'mails diferidos por el cap');
    }

    // SECUENCIAL a proposito (ADR-001, CA-3): un uid a la vez, nunca Promise.all/allSettled sobre
    // el batch. El orden es el que ya trae `batch` (UID descendente, sin reordenar).
    for (const uid of batch) {
      counters.ingestados += 1; // antes del fetch: cuenta intentos, no solo exitos (TS-12)

      let raw;
      try {
        raw = await mailSource.fetch(uid);
      } catch {
        logger.warn({ uid }, 'no se pudo descargar el mensaje');
        continue; // NO se marca \Seen: el proximo tick lo reintenta (CA-6)
      }

      // De a uno, INMEDIATAMENTE tras la descarga exitosa, antes de normalizar (CA-8, ADR-001).
      await mailSource.markSeen(uid);

      try {
        const mail = await normalize(raw.source, logger);
        counters.parseados += 1;

        // El punto donde S-014 cablea `ingesta` + `ruteo`: `routeMail()` es sincrona y pura (nunca
        // lanza, nunca loguea — Integration Points de la Story Plan), el tick decide que hacer con
        // el resultado. NO se reimplementa su orden de evaluacion (CA-2): el tick solo reporta lo
        // que el ruteo ya decidio.
        const route = routeMail(mail, config.ruteo);

        if (!route.ok) {
          // Una sola linea `warn` agrupable por los cinco motivos (CA-3): mismo literal
          // `'mail descartado'` que ya emite `normalize()` para `sin_message_id`. El `slug` viaja
          // SOLO cuando esta presente en el resultado (unicamente `slug_no_mapeado` lo lleva,
          // Integration Points) — nunca `slug: undefined` a mano (CA-4). NO se emite tambien la
          // linea `'mail procesado'` para este mail: CA-3 exige UNA sola linea por descarte, y
          // "normalizado" seria enganoso para un mail que en definitiva se descarta.
          logger.warn(
            {
              messageId: mail.messageId,
              motivo: route.motivo,
              ...(route.slug !== undefined ? { slug: route.slug } : {}),
            },
            'mail descartado',
          );
          counters.descartados += 1;
          // El mail (y el `RouteResult`) se descartan aca: no se acumulan en ningun array del tick
          // (CA-11, CA-16). No publica, no responde, no mueve de carpeta, no persiste (CA-6) — el
          // alcance de esta story termina en el reporte del descarte.
        } else {
          // El procesamiento COMPLETO de adjuntos (S-021) corre ACA, dentro de la MISMA iteracion
          // del mail, ANTES del armado del payload (CA-1). `procesarAdjuntosDelMail()` NUNCA lanza
          // para un resultado de negocio (rechazo, fallo de archivo) -- siempre devuelve, asi que
          // esta invocacion no necesita su propio try/catch: el unico try/catch de esta rama seguia
          // siendo el de la publicacion de abajo. `mail.attachments` es el UNICO punto de esta
          // iteracion que retiene los `Buffer` de los adjuntos, y deja de tener referencias vivas en
          // cuanto termina esta iteracion del `for` (CA-11, S-016).
          const adjuntos = await procesarAdjuntosDelMail(mail.attachments, config.adjuntos, {
            client,
            logger,
          });

          // El cuerpoBase es EXACTAMENTE el mismo calculo que `buildRequirementPayload()` ya hacia
          // internamente (recortar -> placeholder si vacio) -- `resolveCuerpoBase()` es la funcion
          // compartida que evita duplicar esa logica en dos lugares (Task 4). La description final
          // compuesta (S-020) SIEMPRE tiene al menos el cuerpoBase, nunca queda vacia.
          const cuerpoBase = resolveCuerpoBase(mail.body, config.ruteo);
          const description = componerDescripcion({
            cuerpoBase,
            avisosDeRechazo: adjuntos.avisosDeRechazo,
            avisosDeFallo: adjuntos.avisosDeFallo,
            placeholders: adjuntos.placeholders,
          });

          // El alta ocurre DENTRO de esta misma iteracion, antes de pasar al siguiente UID — nunca
          // se acumula un array de mails ruteados para publicar al final (CA-22 de S-015). Un
          // `try/catch` propio, anidado en el de normalizacion/ruteo, distingue un fallo de
          // PUBLICACION (`fallidos`) de un fallo de NORMALIZACION (`descartados`/`fallidos` de
          // arriba): son ejes distintos y no deben confundirse.
          try {
            await publishRequirementFromMail(
              mail,
              route.projectId,
              config.ruteo,
              { client, logger },
              adjuntos.fileIds,
              description,
              adjuntos.avisosDeRechazo.length + adjuntos.avisosDeFallo.length,
            );
            counters.creados += 1;
            // `publishRequirementFromMail()` ya logueo `'requisito creado en Jiku'` con los tres
            // identificadores mas los dos conteos de archivos (CA-9, CA-14) — no se emite una
            // segunda linea `'mail procesado'` aca: seria una linea de resultado duplicada para el
            // mismo mail. Ningun fallo de archivo (rechazo o fallo de subida) cambia este camino:
            // el requisito se crea igual, con sus avisos ya en la description (CA-6, CA-7).
          } catch (cause) {
            // `publishRequirementFromMail()` ya logueo el fallo con su propio `catch` interno
            // (Tarea 3, criterio 5) — este `catch` NO vuelve a loguear el error, solo cuenta y
            // continua con el siguiente UID (CA-18): sin reintento, sin abortar el lote.
            if (!(cause instanceof PublishError)) throw cause;
            counters.fallidos += 1;
          }
        }
      } catch (cause) {
        // Distincion por CLASE, nunca por texto del mensaje (ADR-002, CA-9): `MissingMessageIdError`
        // es un DESCARTE (la clase ya existe desde S-008, precisamente para esto), no un fallo de
        // parseo. Cualquier otro error es `no_parseable`: eso si es "lo que salio mal" (CA-10).
        if (cause instanceof MissingMessageIdError) {
          counters.descartados += 1;
          // `normalize()` ya emitio su propio warn con `motivo: 'sin_message_id'` para este caso
          // puntual (S-008) — no se re-loguea el mismo descarte con otro mensaje (CA-3), solo se
          // cuenta.
        } else {
          counters.fallidos += 1;
          logger.warn(
            { uid, messageId: extractMessageIdIfAny() },
            'mail no se pudo normalizar',
          );
        }
        // Queda \Seen en ambos casos. No hay compensacion de ningun tipo (CA-7, CA-13).
      }
    }
  } finally {
    logger.info(
      {
        ingestados: counters.ingestados,
        parseados: counters.parseados,
        creados: counters.creados,
        descartados: counters.descartados,
        fallidos: counters.fallidos,
      },
      'tick completado',
    );
  }
}

/**
 * El punto de entrada del modulo `ingesta`: abre la conexion IMAP, ejecuta el tick, y garantiza
 * que la linea de metricas se emite incluso si la conexion nunca llego a abrirse.
 *
 * Compone `withMailSource()` (S-009) con `runTick()` (arriba). Hay DOS `finally` distintos y
 * correctos, cada uno con su responsabilidad (Story Plan -> Integration Points):
 *
 * 1. El de `withMailSource`: cierra el lock de INBOX y el logout de IMAP.
 * 2. El de `runTick`: emite la linea de metricas cuando el callback SI llego a correr.
 *
 * Si `withMailSource` lanza ANTES de invocar el callback, `runTick` nunca corrio y su propio
 * `finally` nunca emitio nada — por eso esta funcion tiene su PROPIO `catch` que arma un
 * `TickCounters` en cero y emite la linea el mismo, ademas de loguear el fallo con `error` sin la
 * password ni el usuario (ya garantizado: ninguna clase de error de este servicio los expone en
 * `message`/`details`).
 *
 * **Como se distingue "el callback corrio" de "nunca corrio":** NO por el tipo de excepcion (un
 * chequeo `instanceof ImapConnectError` seria incompleto — `withMailSource` puede fallar ANTES del
 * callback por mas de una razon; hoy es solo `connect()`, pero un fallo de `getMailboxLock()`
 * tambien ocurre antes de invocar el callback y no lanza `ImapConnectError`). En cambio, se marca
 * una bandera de closure `tickBodyStarted` justo antes de invocar `runTick()` dentro del callback:
 * es verdadera si y soLO si el callback efectivamente arranco, sin importar que excepcion haya
 * escapado despues.
 *
 * Nunca relanza de forma que mate el proceso: el error se loguea y la funcion retorna
 * normalmente. El worker sigue vivo y reintenta en el proximo disparo del cron (CA-9) — el guard
 * de no-solapamiento y el propio `node-cron` son de S-011, fuera de esta story.
 */
export async function runIngestaTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  imapFlowCtor?: ImapFlowCtor,
): Promise<void> {
  let tickBodyStarted = false;

  try {
    await withMailSource({ config, logger, imapFlowCtor }, (mailSource) => {
      tickBodyStarted = true;
      return runTick(mailSource, config, logger, client);
    });
  } catch (err) {
    // El error puede ser un fallo de `withMailSource` ANTES de invocar el callback (`connect()`
    // o `getMailboxLock()`: ver CA-9, CA-10) o un error que escapo de DENTRO de `runTick`
    // (`searchUnseen()`/`markSeen()` fallando a mitad de camino: ver CA-12). En ambos casos el
    // tick fallo completo, el worker sigue vivo, y NUNCA se loguean credenciales — `err` va como
    // objeto de contexto y ninguna clase de error de este servicio expone la password ni el
    // usuario en `message`/`details`.
    logger.error({ err }, 'el tick fallo');

    // Si el callback SI llego a arrancar, el finally de runTick() ya emitio la linea de metricas
    // con los contadores parciales (CA-11): no volver a emitirla aca duplicaria la linea. Si en
    // cambio el fallo fue en withMailSource ANTES de invocar el callback, runTick nunca corrio y
    // esta es la UNICA emision — con los cinco contadores en cero, porque nada se llego a
    // procesar.
    if (!tickBodyStarted) {
      logger.info(
        { ingestados: 0, parseados: 0, creados: 0, descartados: 0, fallidos: 0 },
        'tick completado',
      );
    }
  }
}
