import type { NatsConnection } from '@gravadigital/jiku/nats';
import { GenericContainer, Wait } from 'testcontainers';

import { connectWithRetry, createBucket } from './helpers.js';

/**
 * Un NATS con JetStream y **usuarios con permisos estaticos**, para probar contra un servidor REAL
 * el rechazo de permisos del Espacio KV (S-033, CA-6 caso 3).
 *
 * # QUE PRUEBA ESTO Y QUE NO
 *
 * SI prueba: que cuando el servidor NIEGA un publish del SDK —el `STREAM.INFO` al abrir el
 * espacio, o el `DIRECT.GET` de una clave— el rechazo llega al conector como el
 * `JikuKVPermissionDenied` del SDK, con el `subject` rechazado, y que el conector lo diagnostica
 * como `kv_sin_permisos` (o, en caliente, como `slug_no_consultable`). Hasta S-033 esa ruta solo se
 * habia probado con un `PermissionViolationError` fabricado, ni siquiera en el SDK: su test de
 * integracion corre contra un servidor sin permisos.
 *
 * NO prueba, y no puede: el auth-callout, la plantilla real de `internal-app`, ni el `{{user_id}}`
 * que el callout reemplaza por el `sub` del token. Los permisos de aca son ESTATICOS, escritos en la
 * configuracion del servidor: alcanzan para que el servidor rechace como rechazaria con la plantilla
 * real, pero no dicen nada sobre si la plantilla real tiene los grants. Eso lo verifica U-02 contra
 * el despliegue (Parte 2 de `verificacion-e2e-manual.md`).
 *
 * # POR QUE UN CONTENEDOR PROPIO
 *
 * La convencion `testing` exige UN NATS compartido por suite y prohibe uno por archivo. Esta es la
 * tercera excepcion autorizada, con la misma forma y la misma razon que `test/bus/auth-helpers.ts`
 * (`--auth`) y `test/infra/kv/helpers.ts` (`-js`): el compartido NO PUEDE tener usuarios con
 * permisos sin romper a todos los tests que se conectan a el sin credenciales. Es UNO mas, acotado
 * al `beforeAll`/`afterAll` de un solo archivo (`e2e-permisos.test.ts`), y con el tag
 * `nats:2.11-alpine` para no entrar en el conteo de `test/bus/shared-container.test.ts`.
 *
 * # LOS USUARIOS
 *
 * - `deploy`: sin permisos declarados, o sea todo permitido. Representa al deploy de Jiku: crea
 *   `JIKU_KV` (con `createBucket()` de `helpers.ts`, el unico lugar que crea un bucket).
 * - `sin-grants`: solo su inbox. Le faltan los TRES grants del Espacio KV.
 * - `solo-info`: puede abrir el espacio (`STREAM.INFO`) pero no leer ni escribir claves.
 */

/** Los usuarios del servidor; la password de cada uno es su nombre. */
export type PermissionedUser = 'deploy' | 'sin-grants' | 'solo-info';

const CONFIG_PATH = '/etc/nats/permisos.conf';

/**
 * La configuracion del servidor. Un literal y no un valor generado: es legible, y no hay nada que
 * proteger en un contenedor efimero que vive lo que dura un archivo de test.
 */
const SERVER_CONFIG = `
port: 4222
jetstream { store_dir: "/tmp/js" }
authorization {
  users: [
    { user: "deploy", password: "deploy" }
    { user: "sin-grants", password: "sin-grants",
      permissions: { publish: { allow: ["_INBOX.>"] }, subscribe: { allow: ["_INBOX.>"] } } }
    { user: "solo-info", password: "solo-info",
      permissions: { publish: { allow: ["$JS.API.STREAM.INFO.KV_JIKU_KV", "_INBOX.>"] },
                     subscribe: { allow: ["_INBOX.>"] } } }
  ]
}
`;

export interface PermissionedJetStreamNats {
  readonly url: string;
  /**
   * Una conexion CRUDA como `user`. Quien la abre la cierra (las del archivo se cierran en el
   * `afterAll`, antes del `stop()`).
   */
  readonly connectAs: (user: PermissionedUser) => Promise<NatsConnection>;
  readonly stop: () => Promise<void>;
}

export async function startPermissionedJetStreamNats(): Promise<PermissionedJetStreamNats> {
  const image = new GenericContainer('nats:2.11-alpine')
    .withExposedPorts(4222)
    .withCopyContentToContainer([{ content: SERVER_CONFIG, target: CONFIG_PATH }])
    .withCommand(['-c', CONFIG_PATH])
    .withWaitStrategy(Wait.forLogMessage('Server is ready'));

  let container;
  try {
    container = await image.start();
  } catch (cause) {
    // Mismo envoltorio, y misma razon, que en auth-helpers.ts y helpers.ts: sin el, un Docker
    // ausente degrada en un error de socket que no nombra la precondicion.
    throw new Error(
      'No se pudo levantar el contenedor NATS con permisos de los tests del KV. Docker es una ' +
        'precondicion de los tests de este servicio: verifica que el daemon este corriendo.',
      { cause },
    );
  }

  const url = `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
  const connectAs = (user: PermissionedUser): Promise<NatsConnection> =>
    connectWithRetry(url, { user, pass: user });

  // `JIKU_KV` lo crea el deploy de Jiku, con todos los permisos. La primera conexion reusa el
  // reintento acotado de `connectWithRetry()` (EHOSTUNREACH transitorio en dind).
  try {
    const deploy = await connectAs('deploy');
    try {
      await createBucket(deploy);
    } finally {
      await deploy.close();
    }
  } catch (cause) {
    await container.stop().catch(() => undefined);
    throw new Error(`No se pudo crear JIKU_KV en el NATS con permisos de los tests del KV (${url}).`, {
      cause,
    });
  }

  return {
    url,
    connectAs,
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}
