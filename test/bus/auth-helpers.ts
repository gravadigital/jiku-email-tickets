import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceAccountKey } from '@gravadigital/jiku/node';
import type { TokenSource } from '@gravadigital/jiku';
import { GenericContainer, Wait } from 'testcontainers';

/**
 * La infraestructura de los tests de rechazo de conexion.
 *
 * # QUE PRUEBA ESTO Y QUE NO
 *
 * El gotcha declarado de la convencion `testing` dice que `Client.fromConnection()` saltea el
 * handshake de auth y por lo tanto no prueba nada sobre Zitadel, el rol ni el prefijo de inbox.
 * Sigue siendo cierto — y este helper lo mejora PARCIALMENTE, no del todo:
 *
 * SI prueba: que un rechazo de credenciales REAL del servidor NATS llegue al conector como el
 * `JikuError` que el `connectError()` del SDK produce, con la cadena de causas que la
 * clasificacion estructural lee. Antes de esto, los nueve tests de clase de error habrian sido
 * mocks afirmando sobre una forma de error inventada.
 *
 * NO prueba, y no puede: el auth-callout, el rol `internal-app`, el claim de roles del token, ni
 * el prefijo de inbox real derivado del `sub`. NADA DE ESO EXISTE EN UN NATS PELADO. Un NATS con
 * `--auth <token>` compara un string y nada mas. La verificacion de esas cuatro cosas solo ocurre
 * contra un despliegue real, y ninguna documentacion de esta story debe afirmar lo contrario.
 *
 * # POR QUE UN CONTENEDOR PROPIO
 *
 * La convencion exige UN NATS compartido por suite, arrancado en `globalSetup`, y prohibe un
 * contenedor por archivo. Esta es la excepcion, con su razon escrita: el compartido NO PUEDE
 * tener `--auth` sin romper los tests de S-001, que se conectan a el sin credenciales. La regla
 * existe para evitar N contenedores simultaneos; UNO mas, acotado al `beforeAll`/`afterAll` de un
 * solo archivo, no es lo que prohibe.
 */

/**
 * El token que el contenedor acepta.
 *
 * Un literal y no un valor aleatorio: hace los tests legibles y no hay nada que proteger en un
 * contenedor efimero que vive lo que dura un archivo de test.
 */
export const RIGHT_TOKEN = 'the-right-token';

/** Un token que el contenedor rechaza, para el camino de fallo. */
export const WRONG_TOKEN = 'the-wrong-token';

/** El `sub` que los dobles de identidad declaran. */
export const TEST_SUBJECT = 'machine-user-abc';

/** Un puerto libre del host, preguntandoselo al SO en vez de adivinarlo. */
async function freeHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export interface AuthenticatedNats {
  /** La URL del contenedor, ya con el puerto mapeado. */
  readonly url: string;
  /** El token que este servidor acepta. */
  readonly token: string;
  /** Reinicia el servidor, para ejercitar un reconnect real. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Levanta un NATS que exige un token de autenticacion.
 *
 * `--auth` hace que el servidor rechace con `Authorization Violation` cualquier conexion que no
 * presente exactamente ese token — que es la clase de rechazo que el `connectError()` del SDK
 * traduce, y por lo tanto la que el conector tiene que clasificar.
 */
export async function startAuthenticatedNats(token: string = RIGHT_TOKEN): Promise<AuthenticatedNats> {
  // El puerto del HOST se fija en vez de dejar que Docker elija uno.
  //
  // VERIFICADO, y es la razon por la que el test de reconnect existe y funciona: `restart()` de
  // testcontainers levanta el contenedor con un mapeo de puerto NUEVO (32892 -> 32893). El cliente
  // NATS sigue reintentando contra el endpoint con el que se conecto, asi que con un puerto
  // efimero el reconnect NO PUEDE ocurrir jamas: el cliente reintenta para siempre contra un
  // puerto que ya no existe, y el test expira sin haber probado nada. Con el puerto fijo el
  // endpoint sobrevive al reinicio y la reconexion ocurre en segundos.
  //
  // El puerto se pide al SO —bind en 0 y se lee cual toco— en vez de hardcodear uno: un literal
  // colisionaria con cualquier otra cosa que lo tuviera tomado en la maquina del desarrollador.
  const hostPort = await freeHostPort();

  const image = new GenericContainer('nats:2.10-alpine')
    .withExposedPorts({ container: 4222, host: hostPort })
    .withCommand(['--auth', token])
    .withWaitStrategy(Wait.forLogMessage('Server is ready'));

  const start = async (): Promise<Awaited<ReturnType<GenericContainer['start']>>> => {
    try {
      return await image.start();
    } catch (cause) {
      // Sin este envoltorio, un Docker ausente degrada en un error de socket que no nombra la
      // precondicion: se diagnostica como "el test cuelga" en lugar de "falta Docker". Es el
      // mismo envoltorio que usa test/global-setup.ts, por la misma razon.
      throw new Error(
        'No se pudo levantar el contenedor NATS con auth de los tests de rechazo. Docker es una ' +
          'precondicion de los tests de este servicio: verifica que el daemon este corriendo.',
        { cause },
      );
    }
  };

  let container = await start();

  return {
    get url(): string {
      return `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
    },
    token,
    // El contenedor se reemplaza en vez de reiniciarse en el lugar: `restart()` de testcontainers
    // conserva el mapeo de puertos, que es lo que hace que el cliente NATS reconecte al MISMO
    // endpoint. Eso es exactamente lo que TS-21 necesita observar.
    restart: async (): Promise<void> => {
      await container.restart();
    },
    stop: async (): Promise<void> => {
      await container.stop();
    },
  };
}

/**
 * Un `TokenSource` de test.
 *
 * Es un DOBLE EN EL BORDE, no un mock de codigo propio: `TokenSource` es la interfaz que el SDK
 * define y por la que el conector le entrega su identidad. Doblarla es exactamente lo que la
 * convencion permite; doblar `connectToBus()` seria lo que prohibe.
 *
 * Existe porque el `ServiceUser` real NO SIRVE para los tests de conexion: su `token()` llama a
 * Zitadel de verdad (verificado: contra el issuer real devuelve
 * `OAuthError: zitadel: invalid_request: assertion invalid`). Los tests de identidad —TS-1 a
 * TS-5— si usan el `ServiceUser` real, porque lo que afirman no necesita red.
 */
export function fakeTokenSource(token: string, subject: string = TEST_SUBJECT): TokenSource {
  return {
    token: () => Promise.resolve(token),
    currentToken: () => token,
    subject: () => Promise.resolve(subject),
    expiresAt: () => undefined,
  };
}

/**
 * Un `TokenSource` cuyo token ROTA, con un contador de cuantas veces se lo pidieron.
 *
 * Es lo que permite afirmar que un refresh —o un reconnect— vuelve a pedir el token por el getter
 * sincronico en vez de quedarse con el string congelado del primer connect. Sin el contador, TS-13
 * pasaria sin verificar que el token efectivamente se releyo.
 */
export function rotatingTokenSource(
  tokens: readonly string[],
  subject: string = TEST_SUBJECT,
): TokenSource & { currentTokenCalls: () => number; rotate: () => void } {
  let index = 0;
  let calls = 0;

  return {
    token: () => Promise.resolve(tokens[index] ?? ''),
    currentToken: () => {
      calls += 1;
      return tokens[index] ?? '';
    },
    subject: () => Promise.resolve(subject),
    expiresAt: () => undefined,
    currentTokenCalls: () => calls,
    rotate: () => {
      index = Math.min(index + 1, tokens.length - 1);
    },
  };
}

/** Un `TokenSource` que falla al pedir el token, como un Zitadel inalcanzable. */
export function failingTokenSource(reason: string, subject: string = TEST_SUBJECT): TokenSource {
  return {
    token: () => Promise.reject(new Error(reason)),
    currentToken: () => '',
    subject: () => Promise.resolve(subject),
    expiresAt: () => undefined,
  };
}

/** Los archivos temporales que el helper escribio, para limpiarlos al final. */
const temporaryDirectories: string[] = [];

/**
 * Escribe un JSON de `ServiceAccountKey` con una private key RSA REAL y devuelve su ruta.
 *
 * La key tiene que ser real: `ServiceUser` valida en el CONSTRUCTOR y llama a `createPrivateKey`,
 * asi que un fixture con `key: 'fake'` no falla como "key invalida" sino con
 * `ERR_OSSL_UNSUPPORTED` — que es un modo de fallo distinto del que el test quiere ejercitar. El
 * formato es `pkcs1`/`pem`, el mismo `-----BEGIN RSA PRIVATE KEY-----` que entrega Zitadel.
 *
 * `overrides` acepta `null` como valor para BORRAR un campo, que es como se producen las variantes
 * invalidas sin escribir el JSON a mano en cada test.
 */
export async function generateServiceAccountKeyFile(
  overrides: Partial<Record<keyof ServiceAccountKey, string | null>> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jiku-key-'));
  temporaryDirectories.push(directory);

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

  const key: Record<string, string> = {
    type: 'serviceaccount',
    keyId: 'key-1',
    userId: TEST_SUBJECT,
    key: pem,
  };

  for (const [field, value] of Object.entries(overrides)) {
    if (value === null) {
      delete key[field];
    } else {
      key[field] = value;
    }
  }

  const path = join(directory, 'machine-user.json');
  await writeFile(path, JSON.stringify(key), 'utf8');
  return path;
}

/** Escribe un archivo con el contenido crudo que se le pase, para los fixtures no-JSON. */
export async function writeRawKeyFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jiku-key-'));
  temporaryDirectories.push(directory);

  const path = join(directory, 'machine-user.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

/** Borra los temporales que este helper creo. Se invoca desde el `afterAll` del archivo. */
export async function cleanupKeyFiles(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}
