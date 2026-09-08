import type { Client } from '@gravadigital/jiku';
import { type KV, Kvm } from '@gravadigital/jiku/nats';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';
import { KvBucketMissingError, diagnoseKvFailure, isValidBucketName } from '#infra/kv/errors.js';

/**
 * Los dos buckets del KV, abiertos y VERIFICADOS sobre la conexion unica del proceso.
 *
 * El modulo no lee `process.env` y no llama a `getLogger()`: la configuracion y el logger llegan
 * por parametro, igual que en `src/infra/bus/connection.ts`. Eso es lo que permite que los tests
 * le inyecten un logger de captura sin tocar el singleton del proceso.
 *
 * ---
 *
 * HALLAZGO 1, y es el que hace que esta story funcione de verdad:
 * **`open()` NO falla si el bucket no existe.**
 *
 * El docstring de `Kvm.open()` dice *"If the KV doesn't exist, this API will fail on accessing the
 * KV"*, y es facil leerlo como "`open()` lanza". No lanza. Verificado en el paquete instalado:
 *
 * - `Kvm.open()` (`lib/kv.js:158-160`) fija `opts.bindOnly = true` y delega en `#maybeCreate()`.
 * - `#maybeCreate()` con `bindOnly` (`lib/kv.js:167-169`) llama a `Bucket.bind()`.
 * - `Bucket.bind()` (`lib/kv.js:228-246`) valida el nombre, construye el objeto y calcula los
 *   prefijos — y **NUNCA llama a `streams.info`**. No hace ninguna consulta que pueda decir si el
 *   stream existe.
 *
 * O sea que el fallo esta DIFERIDO al primer acceso real ("will fail ON ACCESSING"), y un
 * `openKvStores()` que solo llamara a `open()` resolveria feliz contra un despliegue sin buckets.
 * El sintoma seria exactamente el que esta story existe para evitar: un conector arrancado y
 * aparentemente sano que descarta todos los mails sin decir por que.
 *
 * Por eso, sobre cada bucket se llama a **`status()`**, que si consulta (`lib/kv.js:812`:
 * `await this.jsm.streams.info(bn)`). Ese es el fail-fast.
 *
 * NO BORRAR el `status()` pensando que es redundante despues de un `open()`. Es la verificacion
 * entera.
 *
 * ---
 *
 * HALLAZGO 2: `status().ttl` viene en MILISEGUNDOS, y `0` significa "sin TTL".
 *
 * Es `millis(si.config.max_age)` (`lib/kv.js:835-837`), asi que un bucket creado con `--ttl=90d`
 * reporta `7776000000` y uno sin TTL reporta `0`. La configuracion, en cambio, esta en DIAS
 * (`KV_THREADS_TTL_DAYS`), que es la unidad en la que el operador crea el bucket. De ahi la
 * conversion explicita con `MS_PER_DAY`.
 */

export interface KvStores {
  /** El Mapa de Tickets: `slug -> projectId`. Lo administra un humano. Lo consume S-025. */
  readonly tickets: KV;
  /** El Mapa de Hilos: `sha256(Message-Id) -> requirementId`. Lo escribe el conector. S-026. */
  readonly threads: KV;
}

export interface OpenKvStoresOptions {
  readonly client: Client;
  readonly config: AppConfig;
  readonly logger: Logger;
}

/** Milisegundos en un dia, para convertir el TTL configurado al que reporta `status()`. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Un bucket verificado, con el status que lo verifico.
 *
 * El `status` se devuelve junto al handle en vez de volver a pedirlo despues: es una consulta al
 * servidor (`streams.info`), y la comparacion del TTL necesita exactamente el dato que la
 * verificacion ya trajo. Pedirlo dos veces serian dos round-trips para la misma respuesta.
 */
interface VerifiedBucket {
  readonly handle: KV;
  /** El TTL del bucket en MILISEGUNDOS, tal como lo reporta `status()`. `0` = sin TTL. */
  readonly ttlMs: number;
}

/**
 * Abre un bucket y VERIFICA que existe.
 *
 * Devuelve el handle, o lanza un `KvBucketMissingError` que NOMBRA este bucket. El nombre del
 * bucket en el error es lo que convierte el fallo en accionable: con dos buckets, un "falta un
 * bucket" no dice donde esta el arreglo.
 */
async function openAndVerify(kvm: Kvm, bucket: string): Promise<VerifiedBucket> {
  // La validacion del nombre va ANTES de cualquier I/O, para que el diagnostico sea POSITIVO en
  // vez de depender de reconocer el `Error` plano que lanza `validateBucket()` de la libreria
  // (ver el comentario de VALID_BUCKET_RE en errors.ts).
  if (!isValidBucketName(bucket)) {
    throw new KvBucketMissingError({
      diagnosis: 'nombre_de_bucket_invalido',
      bucket,
      operation: 'validate',
      cause: undefined,
    });
  }

  let handle: KV;
  try {
    handle = await kvm.open(bucket);
  } catch (error) {
    // `open()` casi nunca lanza (Hallazgo 1), pero puede: si el servidor no soporta KV,
    // `#maybeCreate()` rechaza antes de bindear. Se traduce igual, con su propia `operation`, para
    // que el log diga en cual de los dos pasos fallo.
    throw new KvBucketMissingError({
      diagnosis: diagnoseKvFailure(error),
      bucket,
      operation: 'open',
      cause: error,
    });
  }

  try {
    // ESTA es la verificacion. Ver el Hallazgo 1 en la cabecera del modulo antes de tocarla.
    const status = await handle.status();
    return { handle, ttlMs: status.ttl };
  } catch (error) {
    throw new KvBucketMissingError({
      diagnosis: diagnoseKvFailure(error),
      bucket,
      operation: 'status',
      cause: error,
    });
  }
}

/**
 * Compara el TTL real del bucket de hilos contra el configurado, y avisa si difieren.
 *
 * Un `warn` y NO un fallo, porque un TTL distinto del esperado no rompe nada: solo cambia la
 * ventana en la que una respuesta a un hilo viejo sigue ruteando. Una entrada expirada degrada a
 * `hilo_desconocido`, que es una falla SEGURA (el mail se descarta con un motivo propio, no se
 * pierde en silencio ni crea un requisito duplicado).
 *
 * Y el conector NO lo fija, deliberadamente (CA-8): `open()` no modifica limites, y fijarlo
 * exigiria el permiso de creacion/actualizacion de streams que la decision de no crear buckets
 * existe para evitar. Lo fija el operador: `nats kv add MAIL_THREADS --ttl=90d`.
 */
function warnOnTtlMismatch(
  actualTtlMs: number,
  bucket: string,
  expectedTtlDays: number,
  logger: Logger,
): void {
  const expectedTtlMs = expectedTtlDays * MS_PER_DAY;

  if (actualTtlMs === expectedTtlMs) return;

  // Contexto PLANO de un nivel (convencion `logging`): la redaccion no tiene comodin profundo.
  // Los dos valores van en su unidad nombrada en el campo, para que quien lea el log no tenga que
  // adivinar si `90` son dias o milisegundos.
  logger.warn(
    { bucket, expectedTtlDays, actualTtlMs },
    'el TTL del bucket de hilos no coincide con el configurado; el conector no lo fija',
  );
}

/**
 * Abre los dos buckets del KV sobre la conexion UNICA del proceso y verifica que existen.
 *
 * El `Kvm` se construye sobre **`client.connection`** — la `NatsConnection` cruda que el SDK
 * expone — y no sobre una conexion nueva. ADR-002 (una conexion por proceso) se mantiene intacta:
 * conectar cuesta un round-trip a Zitadel mas el handshake del auth-callout, y el KV no paga
 * ninguno de los dos porque viaja por el socket que ya esta abierto y ya esta autorizado como esta
 * identidad.
 *
 * El orden es SECUENCIAL y no un `Promise.all`, y no es un descuido: el de slugs se verifica
 * primero y se corta ahi. Sin el Mapa de Tickets no se puede rutear NADA, mientras que sin el de
 * hilos solo degradan las respuestas — no son equivalentes, y el error tiene que nombrar UN bucket
 * para que el operador sepa cual crear. Con `Promise.all` los dos fallarian a la vez y el
 * diagnostico se volveria ambiguo.
 *
 * NUNCA llama a `kvm.create()`. Un typo en el nombre del bucket crearia un bucket vacio en
 * silencio, y el sintoma seria un conector que descarta todo sin decir por que — mucho peor que un
 * arranque que falla nombrando el bucket que falta. Hay un test de propiedad que escanea `src/`
 * para afirmar que no hay ningun `create()`.
 */
export async function openKvStores({
  client,
  config,
  logger,
}: OpenKvStoresOptions): Promise<KvStores> {
  // La conexion que ya existe, no una nueva. Este es el punto entero de ADR-002 en esta story.
  const kvm = new Kvm(client.connection);

  const tickets = await openAndVerify(kvm, config.kv.ticketsBucket);
  const threads = await openAndVerify(kvm, config.kv.threadsBucket);

  // El TTL se compara SOLO en el del bucket de hilos. El de slugs es configuracion que un humano
  // administra y no tiene por que expirar: cualquier TTL que tenga es irrelevante y no se compara
  // contra nada (CA-13). Por eso `tickets.ttlMs` no se lee en ninguna parte.
  warnOnTtlMismatch(threads.ttlMs, config.kv.threadsBucket, config.kv.threadsTtlDays, logger);

  logger.info(
    { ticketsBucket: config.kv.ticketsBucket, threadsBucket: config.kv.threadsBucket },
    'buckets del KV abiertos y verificados',
  );

  return { tickets: tickets.handle, threads: threads.handle };
}
