import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@gravadigital/jiku';
// El cliente NATS crudo sale del subpath del SDK, nunca de `@nats-io/*` ni de `nats`: no son
// dependencias de este proyecto (ADR-002) y el subpath garantiza una sola copia de `nats-core` en
// el arbol. Es la misma regla que sigue `test/bus/helpers.ts`. Desde S-032 el subpath ya no trae
// ningun KV: el bucket se crea con la API de JetStream, igual que lo hace el SDK en sus tests.
import { connect, type ConnectionOptions, type NatsConnection } from '@gravadigital/jiku/nats';
import { GenericContainer, Wait } from 'testcontainers';

import type { KvSpace } from '#infra/kv/space.js';

import { TEST_INSTANCE, TEST_USER_ID } from '../../bus/helpers.js';

/**
 * Un NATS **con JetStream habilitado** y el bucket `JIKU_KV` creado, que es infraestructura de test
 * no negociable.
 *
 * # POR QUE NO SE USA EL CONTENEDOR COMPARTIDO
 *
 * El NATS de `test/global-setup.ts` arranca SIN `-js`, asi que no tiene JetStream y por lo tanto
 * no tiene KV: contra el, `client.kv()` rechaza con `JikuNoBucket`. El camino feliz —el espacio se
 * abre, se escribe y se lee— es INEXPRESABLE contra el.
 *
 * Y no se le agrega `-js` al compartido, por dos razones:
 *
 * 1. Cambiaria la infraestructura de TODA la suite.
 * 2. El bus compartido es, justamente, compartido: las entradas que sembrara un archivo de test
 *    serian visibles para los demas. La contaminacion cruzada seria real, no teorica.
 *
 * El precedente autorizado de levantar un contenedor propio para un escenario que el compartido
 * no puede expresar es `test/bus/auth-helpers.ts`, y este helper copia su forma, incluido el
 * envoltorio que nombra Docker como precondicion.
 *
 * Usa un TAG de imagen distinto del compartido — ver el comentario en `startJetStreamNats()`, que
 * explica por que eso no es una decision de version.
 *
 * # POR QUE LA CONFIGURACION DEL STREAM ES LA DEL SDK
 *
 * `JIKU_KV` lo crea el deploy de Jiku, nunca el conector. Aca lo crea el test, representando a ese
 * deploy, con la MISMA configuracion que usa `jiku-ts/test/integration/kv.test.ts` (la que produce
 * `nats kv add JIKU_KV --history 1`, con los limites fijados): `allow_direct: true`, que el SDK
 * exige para leer, y SIN `max_age`, porque la precondicion de despliegue es un bucket sin TTL
 * (REQ-008: los hilos no expiran). Copiarla del SDK y no inventarla es lo que hace que lo que pasa
 * aca pase tambien contra el bucket real.
 *
 * # POR QUE UN ESPACIO FRESCO POR IDENTIDAD Y NO UN BUCKET POR TEST
 *
 * Con dos buckets propios, cada test creaba el suyo. Con el Espacio KV el bucket es UNO y fijo
 * (`JIKU_KV`), y lo que aisla es el prefijo `{instance}.{userId}.` que agrega el SDK: un test que
 * pide `spaceFor('tk-1')` no ve ninguna entrada de `spaceFor('tk-2')`. Es el mismo aislamiento que
 * da en produccion, y el `KV` del SDK no lista claves, asi que no hay otra forma de empezar limpio.
 *
 * # BENEFICIO COLATERAL
 *
 * El contenedor compartido, por NO tener JetStream, es el doble perfecto y gratis del escenario
 * "JetStream apagado". No hay que simular nada para probarlo.
 */
export interface JetStreamNats {
  readonly url: string;
  /** La conexion CRUDA, de `@gravadigital/jiku/nats`. */
  readonly connection: NatsConnection;
  /** `Client.fromConnection(connection, { instance: TEST_INSTANCE, userId: TEST_USER_ID })`. */
  readonly client: Client;
  /**
   * Crea `JIKU_KV` (`$JS.API.STREAM.CREATE.KV_JIKU_KV`). Es el UNICO lugar del repo que crea un
   * bucket: el codigo de produccion no lo hace (un test de propiedad escanea `src/` para
   * afirmarlo). Aca representa al deploy de Jiku. `overrides` existe para los escenarios de un
   * bucket mal configurado (`{ allow_direct: false }`).
   */
  readonly createBucket: (overrides?: Record<string, unknown>) => Promise<void>;
  /** Borra `JIKU_KV`, para los escenarios que arrancan sin el bucket. Quien lo usa lo recrea. */
  readonly deleteBucket: () => Promise<void>;
  /** Si `JIKU_KV` existe: `false` cuando JetStream contesta "stream not found" (`err_code 10059`). */
  readonly bucketExists: () => Promise<boolean>;
  /**
   * El `config` del stream `KV_JIKU_KV` (`STREAM.INFO`), para afirmar que el conector NO arreglo un
   * bucket mal configurado (S-033: `allow_direct === false` despues de un arranque fallido).
   */
  readonly bucketConfig: () => Promise<Record<string, unknown>>;
  /**
   * Cada subject del stream que matchea `filter` (por defecto, todas las claves de `JIKU_KV`) con la
   * secuencia de su ULTIMO mensaje. Es como el lado del test lee "todas las claves que escribio" un
   * conector, que el `KV` del SDK no puede listar (S-033, CA-3). Con `max_msgs_per_subject: 1` la
   * cantidad por subject siempre es 1, asi que "esta clave no cambio" se afirma por la SECUENCIA.
   */
  readonly lastSequences: (filter?: string) => Promise<Map<string, number>>;
  /**
   * Un espacio FRESCO de otra identidad sobre el mismo bucket: `client.kv()` de un
   * `Client.fromConnection(connection, { instance, userId })` nuevo. El `userId` tiene que ser un
   * segmento valido de clave (`[A-Za-z0-9\-/_=]+`), p. ej. `tick-t1`.
   */
  readonly spaceFor: (userId: string, instance?: string) => Promise<KvSpace>;
  /**
   * Si `startJetStreamNats()` rechazo en el `beforeAll`, la variable del archivo nunca se asigno:
   * los `afterAll` llaman `nats?.stop()` para que un `TypeError` no tape el error original.
   */
  readonly stop: () => Promise<void>;
}

/**
 * La configuracion del stream de `JIKU_KV`, copiada de `jiku-ts/test/integration/kv.test.ts`, con
 * `max_msg_size: -1` y SIN `max_age` (sin TTL, como exige la precondicion de despliegue).
 */
export const JIKU_KV_STREAM = {
  name: 'KV_JIKU_KV',
  subjects: ['$KV.JIKU_KV.>'],
  storage: 'memory',
  retention: 'limits',
  discard: 'new',
  max_msgs_per_subject: 1,
  max_msg_size: -1,
  max_bytes: -1,
  allow_rollup_hdrs: true,
  deny_delete: true,
  allow_direct: true,
  num_replicas: 1,
} as const;

/** El `err_code` de JetStream para "stream not found". */
const STREAM_NOT_FOUND = 10059;

/**
 * Errores de socket que se reintentan en la PRIMERA conexion al contenedor recien levantado.
 *
 * En CI el puerto mapeado se alcanza a traves de `docker:dind`, y un contenedor nuevo puede
 * responder `EHOSTUNREACH` al primer connect aunque ya haya logueado `Server is ready`: dind 27
 * reutiliza las IPs de los contenedores que se fueron sin anunciar la nueva por ARP, y la entrada
 * vieja del cache de vecinos rechaza el primer intento. El mismo helper conecta bien en los demas
 * archivos de la misma corrida, asi que es transitorio — pero el cliente NATS, sin
 * `waitOnFirstConnect`, hace un solo intento y el `beforeAll` entero cae.
 *
 * No es un sleep para esperar una condicion: la readiness ya la resolvio `Wait.forLogMessage`.
 * Es un reintento acotado del socket, y cualquier otro error sale en el primer intento.
 */
const TRANSIENT_CONNECT_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED']);
const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1_000;

/**
 * `@nats-io/transport-node` deja pasar el error de socket crudo, salvo `ECONNREFUSED`, que lo
 * envuelve en un `ConnectionError` con el original como `cause`.
 */
function socketCode(err: unknown): unknown {
  const { code, cause } = (err ?? {}) as { code?: unknown; cause?: { code?: unknown } };
  return code ?? cause?.code;
}

/**
 * La PRIMERA conexion a un contenedor recien levantado, con el reintento acotado de arriba.
 * Exportada para los otros helpers que levantan su propio NATS (`permission-helpers.ts`), que
 * pasan `user`/`pass` en `options`.
 */
export async function connectWithRetry(
  url: string,
  options: Omit<ConnectionOptions, 'servers'> = {},
): Promise<NatsConnection> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect({ ...options, servers: url });
    } catch (err) {
      const code = socketCode(err);
      const transient = typeof code === 'string' && TRANSIENT_CONNECT_CODES.has(code);
      if (!transient || attempt === CONNECT_ATTEMPTS) {
        throw err;
      }
      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
}

interface JetStreamApiReply {
  readonly error?: { readonly code?: number; readonly err_code?: number; readonly description?: string };
  readonly config?: Record<string, unknown>;
  readonly state?: { readonly subjects?: Record<string, number> };
  readonly message?: { readonly seq?: number };
}

/** Un request a la API de JetStream, con la respuesta ya parseada. */
async function jetStreamApi(
  connection: NatsConnection,
  subject: string,
  body: string,
): Promise<JetStreamApiReply> {
  const reply = await connection.request(subject, body);
  return JSON.parse(reply.string()) as JetStreamApiReply;
}

/**
 * Lo mismo, pero una respuesta con `error` es un fallo del HELPER y no un estado a afirmar: un
 * `createBucket` que JetStream rechazo en silencio dejaria a todo el archivo probando contra un
 * bucket que no existe, y el sintoma seria un `bucket_no_usable` inexplicable lejos de la causa.
 */
async function jetStreamApiOk(
  connection: NatsConnection,
  subject: string,
  body: string,
): Promise<JetStreamApiReply> {
  const reply = await jetStreamApi(connection, subject, body);
  if (reply.error !== undefined) {
    throw new Error(`La API de JetStream rechazo ${subject}: ${JSON.stringify(reply.error)}`);
  }
  return reply;
}

/**
 * Crea `JIKU_KV` sobre `connection`, con la configuracion del SDK. Es el UNICO lugar del repo que
 * crea un bucket (lo afirman `preservacion-req-005.test.ts` TS-39 y `source-properties.test.ts`
 * TS-82): `startJetStreamNats()` lo usa sobre su conexion, y `permission-helpers.ts` sobre la del
 * usuario `deploy` de su servidor con permisos. Los dos representan al deploy de Jiku.
 */
export const createBucket = async (
  connection: NatsConnection,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await jetStreamApiOk(
    connection,
    '$JS.API.STREAM.CREATE.KV_JIKU_KV',
    JSON.stringify({ ...JIKU_KV_STREAM, ...overrides }),
  );
};

/** `STREAM.INFO` con `subjects_filter`, y `STREAM.MSG.GET` con `last_by_subj` por cada subject. */
async function lastSequencesOn(connection: NatsConnection, filter: string): Promise<Map<string, number>> {
  const info = await jetStreamApiOk(
    connection,
    '$JS.API.STREAM.INFO.KV_JIKU_KV',
    JSON.stringify({ subjects_filter: filter }),
  );
  const sequences = new Map<string, number>();
  for (const subject of Object.keys(info.state?.subjects ?? {})) {
    const reply = await jetStreamApiOk(
      connection,
      '$JS.API.STREAM.MSG.GET.KV_JIKU_KV',
      JSON.stringify({ last_by_subj: subject }),
    );
    const seq = reply.message?.seq;
    if (typeof seq !== 'number') {
      throw new Error(`STREAM.MSG.GET no devolvio la secuencia de ${subject}: ${JSON.stringify(reply)}`);
    }
    sequences.set(subject, seq);
  }
  return sequences;
}

export async function startJetStreamNats(): Promise<JetStreamNats> {
  // El TAG es DISTINTO del `nats:2.10-alpine` del contenedor compartido a proposito, y no es una
  // decision de version: `test/bus/shared-container.test.ts` afirma que el compartido es el UNICO
  // contenedor NATS de la suite, y lo cuenta con `docker ps --filter ancestor=nats:2.10-alpine`.
  // Con el mismo tag, este contenedor entraria en ese conteo y ese test fallaria — o habria que
  // ensenarle a distinguirlos por el flag del comando, y ahi el conteo se vuelve una CARRERA:
  // los contenedores de este archivo nacen y mueren mientras esa suite corre, porque los archivos
  // corren en workers paralelos, asi que el total observado depende del instante en que se mire.
  //
  // Un tag distinto hace que el filtro `ancestor=` del test compartido no lo vea, y esa suite
  // queda como estaba: un conteo simple, sin manejo de carreras. Ademas el direct get del Espacio
  // KV lleva la clave en el subject, y eso exige un NATS 2.10+ (ADR-007).
  const image = new GenericContainer('nats:2.11-alpine')
    .withExposedPorts(4222)
    // `-js` habilita JetStream, y sin JetStream no hay KV. El compartido arranca sin este flag.
    .withCommand(['-js'])
    .withWaitStrategy(Wait.forLogMessage('Server is ready'));

  let container;
  try {
    container = await image.start();
  } catch (cause) {
    // Sin este envoltorio, un Docker ausente degrada en un error de socket que no nombra la
    // precondicion: se diagnostica como "el test cuelga" en vez de "falta Docker". Mismo
    // envoltorio, y misma razon, que en auth-helpers.ts y global-setup.ts.
    throw new Error(
      'No se pudo levantar el contenedor NATS con JetStream de los tests del KV. Docker es una ' +
        'precondicion de los tests de este servicio: verifica que el daemon este corriendo.',
      { cause },
    );
  }

  const url = `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
  let connection: NatsConnection;
  try {
    connection = await connectWithRetry(url);
  } catch (cause) {
    // El `afterAll` no puede detener este contenedor: `stop()` nunca llego a devolverse. Si el
    // stop tambien falla se descarta, porque el error que hay que leer es el de la conexion.
    await container.stop().catch(() => undefined);
    throw new Error(`No se pudo conectar al NATS con JetStream de los tests del KV (${url}).`, {
      cause,
    });
  }
  const client = Client.fromConnection(connection, {
    instance: TEST_INSTANCE,
    userId: TEST_USER_ID,
  });

  try {
    await createBucket(connection);
  } catch (cause) {
    await connection.close().catch(() => undefined);
    await container.stop().catch(() => undefined);
    throw new Error('No se pudo crear JIKU_KV en el NATS con JetStream de los tests del KV.', { cause });
  }

  return {
    url,
    connection,
    client,
    createBucket: (overrides?: Record<string, unknown>) => createBucket(connection, overrides),

    deleteBucket: async (): Promise<void> => {
      await jetStreamApiOk(connection, '$JS.API.STREAM.DELETE.KV_JIKU_KV', '');
    },

    bucketExists: async (): Promise<boolean> => {
      const reply = await jetStreamApi(connection, '$JS.API.STREAM.INFO.KV_JIKU_KV', '');
      if (reply.error === undefined) return true;
      if (reply.error.err_code === STREAM_NOT_FOUND) return false;
      throw new Error(`La API de JetStream rechazo STREAM.INFO: ${JSON.stringify(reply.error)}`);
    },

    bucketConfig: async (): Promise<Record<string, unknown>> => {
      const reply = await jetStreamApiOk(connection, '$JS.API.STREAM.INFO.KV_JIKU_KV', '');
      return reply.config ?? {};
    },

    lastSequences: (filter: string = '$KV.JIKU_KV.>') => lastSequencesOn(connection, filter),

    spaceFor: async (userId: string, instance: string = TEST_INSTANCE): Promise<KvSpace> => {
      return Client.fromConnection(connection, { instance, userId }).kv();
    },

    stop: async (): Promise<void> => {
      // `close()` y no `drain()`: no hay replies en vuelo que preservar, y el contenedor se va
      // igual en la linea siguiente.
      await connection.close();
      await container.stop();
    },
  };
}
