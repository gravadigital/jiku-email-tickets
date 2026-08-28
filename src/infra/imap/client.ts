import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { ImapConnectError, diagnoseImapConnectFailure } from '#infra/imap/errors.js';

/**
 * El adaptador IMAP: una conexion TLS incondicional, sin logging interno de `imapflow`, ligada al
 * lock fijo de `INBOX`. Sigue el patron estructural de `infra/bus/connection.ts` — recibe `config`
 * y `logger` por parametro, nunca lee `process.env`, y traduce cualquier fallo del cliente externo
 * a una `AppError` propia con diagnostico estructural.
 *
 * `imapflow` se importa UNICAMENTE en este archivo (y en `errors.ts`, que no lo importa) — hay un
 * test de escaneo de fuente (`test/ingesta/mail-source-boundary.test.ts`) que lo afirma (CA-11).
 */

/**
 * La casilla que el conector procesa. Constante del modulo, NUNCA una variable de entorno: no
 * existe ningun `IMAP_MAILBOX` que la sustituya (CA-6).
 */
export const INBOX = 'INBOX';

/**
 * Lo minimo de la superficie de `ImapFlow` que este adaptador necesita, para poder doblarla en
 * tests sin depender de la clase concreta importada del paquete.
 *
 * Nombres y formas verificados contra `imapflow@1.7.6` (`node_modules/imapflow/lib/imap-flow.d.ts`,
 * Tarea 1): `download(range, part?, options?)` devuelve `{ meta, content: Readable }` — el
 * resultado es un STREAM, nunca un Buffer directo, asi que `fetch()` lo consume entero antes de
 * resolver. `search(query, options)` con `{ uid: true }` devuelve UIDs (sin esa opcion devuelve
 * numeros de secuencia, que no es lo que esta story necesita). `messageFlagsAdd(range, flags,
 * options)` con `{ uid: true }` interpreta `range` como UID, no como secuencia.
 */
export interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ path: string; release(): void }>;
  search(query: { seen: boolean }, options: { uid: boolean }): Promise<number[] | false>;
  download(
    range: number,
    part?: string,
    options?: { uid?: boolean },
  ): Promise<{ content: NodeJS.ReadableStream }>;
  messageFlagsAdd(range: number, flags: string[], options: { uid: boolean }): Promise<boolean>;
}

/**
 * La fabrica de clientes, inyectable para tests (nunca se mockea el modulo `imapflow`).
 *
 * Una FUNCION y no una clase `new`-able: mismo criterio que `createLogger(config, destination,
 * transportTarget)` en `shared/logger.ts` — un parametro de fabrica se dobla en tests con un
 * `vi.fn()` comun, sin tener que replicar la semantica de constructor del doble.
 */
export type ImapFlowCtor = (options: Record<string, unknown>) => ImapFlowLike;

/** La fabrica real: instancia el `ImapFlow` de `imapflow`. */
const realImapFlowCtor: ImapFlowCtor = (options) => new ImapFlow(options as unknown as ImapFlowOptions);

export interface WithMailSourceOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** SOLO para tests: el default es el `ImapFlow` real. */
  readonly imapFlowCtor?: ImapFlowCtor;
}

/** Lee un stream completo a un `Buffer` unico. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Construye el `MailSource` ligado a un cliente ya conectado y con el lock de INBOX tomado. */
function buildMailSource(client: ImapFlowLike): MailSource {
  return {
    async searchUnseen(): Promise<number[]> {
      // { uid: true } es lo que hace que `search()` devuelva UIDs y no numeros de secuencia —
      // sin esa opcion, imapflow devuelve la posicion del mensaje en la casilla, que cambia con
      // cada expunge y no sirve para `fetch`/`markSeen` de otra invocacion.
      const result = await client.search({ seen: false }, { uid: true });
      const uids = result === false ? [] : result;

      // imapflow no garantiza el orden de `search()`: se ordena explicitamente, UID descendente
      // (mas nuevo primero) — por UID, no por el header `Date`, que es dato del cliente.
      //
      // Se devuelve el TOTAL, sin ningun `.slice()`: el recorte al cap es del tick (S-010), no de
      // este adaptador (CA-3).
      return [...uids].sort((a, b) => b - a);
    },

    async fetch(uid: number): Promise<RawMessage> {
      // No se envuelve el fallo: si la descarga falla, PROPAGA tal cual — el llamador (el tick)
      // decide saltear ese UID sin marcarlo.
      const downloaded = await client.download(uid, undefined, { uid: true });
      const source = await streamToBuffer(downloaded.content);
      return { uid, source };
    },

    async markSeen(uid: number): Promise<void> {
      // Un solo UID por invocacion, con { uid: true } para que se interprete como UID y no como
      // numero de secuencia. Ninguna variante en lote: ADR-001 exige que el marcado sea de a uno.
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    },
  };
}

/**
 * Abre una conexion IMAP, ejecuta `callback` con el `MailSource` resultante, y cierra la conexion
 * y el lock SIEMPRE, con exito o con fallo.
 *
 * Se abre y cierra UNA vez por invocacion — no una vez por operacion del `MailSource` — porque
 * `searchUnseen()`, `fetch()` y `markSeen()` comparten el mismo cliente y el mismo lock durante
 * todo un tick (Flow Context -> Paso 2 a 5 del flujo `ingesta-y-normalizacion-del-mail`).
 */
export async function withMailSource<T>(
  { config, logger, imapFlowCtor = realImapFlowCtor }: WithMailSourceOptions,
  callback: (source: MailSource) => Promise<T>,
): Promise<T> {
  const client = imapFlowCtor({
    host: config.imap.host,
    port: config.imap.port,
    // INCONDICIONAL: no hay opcion de texto plano, nunca desde config ni desde una variable
    // (CA-4).
    secure: true,
    auth: { user: config.imap.user, pass: config.imap.password },
    // INCONDICIONAL: el default de imapflow emite el trafico crudo, que incluye el LOGIN
    // (CA-5, ADR-006).
    logger: false,
  });

  try {
    await client.connect();
  } catch (cause) {
    // El diagnostico se calcula por estructura (ver diagnoseImapConnectFailure()), nunca por el
    // texto del error del cliente — asi el mensaje y los campos de ImapConnectError nunca
    // contienen la contrasena ni el usuario (CA-10).
    throw new ImapConnectError(diagnoseImapConnectFailure(cause), cause);
    // No se le informa nada mas al logger aca: el propio ImapConnectError es lo que el llamador
    // logueara, y su `message`/`details` ya estan libres del secreto (verificado por TS-17, TS-19).
  }

  const lock = await client.getMailboxLock(INBOX);
  try {
    logger.debug({ diagnosis: 'imap_lock_tomado' }, 'lock de INBOX tomado');
    return await callback(buildMailSource(client));
  } finally {
    // El cierre corre SIEMPRE, con exito o con fallo de cualquier operacion posterior: ninguna
    // conexion ni ningun lock quedan colgados (CA-12).
    lock.release();
    await client.logout();
  }
}
