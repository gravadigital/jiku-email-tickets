import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@gravadigital/jiku';
// El cliente NATS y el KV salen del subpath del SDK, nunca de `@nats-io/*` ni de `nats`: no son
// dependencias de este proyecto (ADR-002 / S-023) y el subpath garantiza una sola copia de
// `nats-core` en el arbol. Es la misma regla que sigue `test/bus/helpers.ts`.
import { Kvm, connect, type KV, type NatsConnection } from '@gravadigital/jiku/nats';
import { GenericContainer, Wait } from 'testcontainers';

import { TEST_INSTANCE, TEST_USER_ID } from '../../bus/helpers.js';

/**
 * Un NATS **con JetStream habilitado**, que es infraestructura de test nueva y no negociable.
 *
 * # POR QUE NO SE USA EL CONTENEDOR COMPARTIDO
 *
 * El NATS de `test/global-setup.ts` arranca SIN `-js`, asi que no tiene JetStream y por lo tanto
 * no tiene KV: contra el, `status()` sobre cualquier bucket falla con `JetStreamNotEnabled`. El
 * camino feliz de esta story —los dos buckets existen y se abren— es INEXPRESABLE contra el.
 *
 * Y no se le agrega `-js` al compartido, por dos razones:
 *
 * 1. Cambiaria la infraestructura de TODA la suite en una story que no lo necesita.
 * 2. El bus compartido es, justamente, compartido: los buckets que sembrara un archivo de test
 *    serian visibles para los demas. La contaminacion cruzada seria real, no teorica.
 *
 * El precedente autorizado de levantar un contenedor propio para un escenario que el compartido
 * no puede expresar es `test/bus/auth-helpers.ts`, y este helper copia su forma, incluido el
 * envoltorio que nombra Docker como precondicion.
 *
 * Usa un TAG de imagen distinto del compartido — ver el comentario en `startJetStreamNats()`, que
 * explica por que eso no es una decision de version.
 *
 * # BENEFICIO COLATERAL
 *
 * El contenedor compartido, por NO tener JetStream, es el doble perfecto y gratis del escenario
 * "JetStream deshabilitado" (TS-15). No hay que simular nada para probarlo.
 */
export interface JetStreamNats {
  readonly url: string;
  readonly connection: NatsConnection;
  readonly client: Client;
  /** Crea buckets ANTES de que corra el codigo bajo test. Es el unico lugar que llama a `create()`. */
  readonly seedBucket: (name: string, ttlDays?: number) => Promise<void>;
  /**
   * Abre un bucket ya sembrado y devuelve su handle, para que un test pueda sembrarle entradas y
   * pasarselo al codigo bajo test.
   *
   * Es `open()` y NO `create()`: representa lo mismo que hace el codigo de produccion, y por eso
   * no rompe la propiedad de que el unico `create()` del repo vive en `seedBucket`.
   */
  readonly openBucket: (name: string) => Promise<KV>;
  /**
   * Si `startJetStreamNats()` rechazo en el `beforeAll`, la variable del archivo nunca se asigno:
   * los `afterAll` llaman `nats?.stop()` para que un `TypeError` no tape el error original.
   */
  readonly stop: () => Promise<void>;
}

/** Milisegundos en un dia. Duplicado a proposito: el test no debe importar la constante que verifica. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

async function connectWithRetry(url: string): Promise<NatsConnection> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect({ servers: url });
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
  // queda como estaba: un conteo simple, sin manejo de carreras.
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

  return {
    url,
    connection,
    client,

    // El sembrado usa `create()`, y es el UNICO lugar de todo el repo que puede: el codigo de
    // produccion no crea buckets (CA-3, con un test de propiedad que escanea `src/` para
    // afirmarlo). Aca representa al operador que corrio `nats kv add`.
    seedBucket: async (name: string, ttlDays?: number): Promise<void> => {
      const kvm = new Kvm(connection);
      // El `ttl` de las opciones va en MILISEGUNDOS, igual que el que reporta `status()`.
      await kvm.create(name, ttlDays === undefined ? {} : { ttl: ttlDays * MS_PER_DAY });
    },

    openBucket: async (name: string): Promise<KV> => {
      const kvm = new Kvm(connection);
      return kvm.open(name);
    },

    stop: async (): Promise<void> => {
      // `close()` y no `drain()`: no hay replies en vuelo que preservar, y el contenedor se va
      // igual en la linea siguiente.
      await connection.close();
      await container.stop();
    },
  };
}
