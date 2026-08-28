import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupKeyFiles, generateServiceAccountKeyFile, writeRawKeyFile } from './bus/auth-helpers.js';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
};

const REQUIRED_VARIABLES = [
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
  'JIKU_VERIFY_PROJECT_ID',
];

/**
 * Entorno explicito para el proceso hijo: solo PATH y HOME mas lo que el caso declara.
 *
 * Este archivo y `src/config/env.ts` son los unicos lugares del repo donde `process.env` puede
 * aparecer legitimamente — aca porque probar el arranque real exige controlar el entorno del hijo.
 * El test estructural de CA-1 escanea `src/`, no `test/`, asi que no hay conflicto. No lo
 * "arregles" moviendolo a un helper que herede el entorno: heredarlo es el bug que evita.
 *
 * HOME va explicito y apunta a un directorio que no existe, para que el `loadConfig()` del SDK no
 * levante el `~/.config/jiku/config.yaml` del desarrollador y cambie el resultado del test.
 */
function BASE_ENV_WITH(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: '/nonexistent-home-for-tests',
    ...extra,
  };
}

/**
 * Ejecuta el `dist/` compilado y devuelve sus dos streams y su exit code.
 *
 * `spawnSync` y no `execFileAsync`: desde S-004 el arranque con un entorno cuyas rutas de
 * secretos no existen sale con codigo != 0 —la key no se puede cargar, que es lo que CA-4 pide—
 * y `execFileAsync` RECHAZA en ese caso, escondiendo los streams justo cuando son lo que hay que
 * afirmar.
 */
function runDist(extra: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['dist/index.js'], {
    cwd: PROJECT_ROOT,
    env: BASE_ENV_WITH(extra),
    encoding: 'utf8',
  });

  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Lo mismo para el SEGUNDO entry point, el del modo de verificacion (S-005).
 *
 * Existe como funcion aparte y no como parametro de `runDist()` para que quede visible que este
 * repo emite DOS ejecutables y que los dos tienen que resolver sus `#` imports en runtime. Un
 * mapeo roto pasa el typecheck y muere al arrancar, y el entry point que casi nunca se corre es
 * exactamente el que se descubriria roto en el peor momento: cuando el operador esta verificando
 * un despliegue nuevo.
 */
function runDistVerify(extra: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['dist/verify.js'], {
    cwd: PROJECT_ROOT,
    env: BASE_ENV_WITH(extra),
    encoding: 'utf8',
  });

  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// El error que este archivo previene es el que pasa el typecheck y falla al arrancar:
// tsc no reescribe los especificadores al emitir, asi que el mapeo `#` tiene que estar
// configurado tambien del lado runtime (package.json#imports).
/**
 * Una key REAL para los casos que tienen que pasar el Paso 3 y fallar en el Paso 5.
 *
 * `ServiceUser` valida la key en el constructor, asi que sin una private key RSA de verdad el
 * arranque cortaria en la key y nunca llegaria a intentar conectar — que es justo lo contrario de
 * lo que el test de "bus inalcanzable" quiere ejercitar.
 */
let VALID_KEY_FILE: string;

/**
 * Un creds LEIBLE, aunque su contenido no sea un creds valido.
 *
 * El SDK lee el archivo del creds ANTES de abrir el socket, asi que una ruta inexistente corta el
 * arranque con `creds_ilegible` sin llegar nunca a la red — correcto, y por eso mismo inutil para
 * el caso que quiere ejercitar el fallo de RED. Lo que hace falta es que el archivo se pueda leer;
 * que su contenido no autentique es irrelevante contra un puerto cerrado.
 */
let READABLE_CREDS: string;

describe('the built dist/ resolves subpath imports at runtime', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
    VALID_KEY_FILE = await generateServiceAccountKeyFile();
    READABLE_CREDS = await writeRawKeyFile('-----BEGIN NATS USER JWT-----\nno-importa\n------END NATS USER JWT------');
  }, 120_000);

  afterAll(async () => {
    await cleanupKeyFiles();
  });

  // Cubre TS-1 (la compilacion pasa limpia) y TS-10 (sin TS2307 sobre el import `#`) a la
  // vez: tsc --noEmit sobre el tsconfig base typechequea src/ y test/ juntos, que es un
  // superconjunto de lo que TS-1 pide. Si se angostara a un solo diagnostico, TS-1 se
  // quedaria sin cobertura.
  it('compiles clean, with the subpath import resolving at typecheck time', async () => {
    await expect(
      execFileAsync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT }),
    ).resolves.toBeDefined();
  }, 120_000);

  // Asegura el arranque limpio, no la ausencia de un codigo de error puntual: un `imports`
  // ausente falla con ERR_PACKAGE_IMPORT_NOT_DEFINED y uno mal apuntado con
  // ERR_MODULE_NOT_FOUND. Las dos regresiones son la misma, y las dos rompen el arranque.
  //
  // Desde S-002 el arranque valida la configuracion, asi que el proceso necesita un entorno
  // completo para llegar a salir con 0. El entorno se pasa EXPLICITO y no se hereda del host: si se
  // heredara, el test pasaria o fallaria segun lo que el desarrollador tenga exportado en su shell,
  // que es el fallo intermitente que la convencion `testing` prohibe.
  it('resolves every subpath import with a complete environment', () => {
    // Desde S-004 el arranque NO sale con 0 con este entorno: las rutas de VALID_ENV son
    // ficticias, asi que la key no existe y el arranque corta ahi (que es exactamente lo que
    // CA-4 pide). Lo que este archivo verifica sigue siendo lo mismo que antes —que el mapeo `#`
    // resuelva en runtime— y para eso alcanza con que el proceso llegue a ejecutar codigo propio
    // en vez de morir en la resolucion de modulos.
    const result = runDist(VALID_ENV);

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
    expect(result.stdout).toContain('configuracion valida');
  }, 30_000);

  it('aborts with a non-zero exit code and the complete list when the environment is incomplete', async () => {
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH({ JIKU_INSTANCE: 'dev' }),
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    for (const name of REQUIRED_VARIABLES) {
      expect(result.stderr).toContain(name);
    }
    // El arranque corta antes de conectar, asi que un mapeo roto no puede disfrazarse de fallo
    // de configuracion.
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
  }, 30_000);

  // TS-18: el arranque emite por el logger, no por process.stdout.write. Vive aca porque este
  // archivo ya ejecuta el dist/ como proceso real, que es la unica forma de verificar que la linea
  // que sale de verdad por stdout es la del logger.
  it('emits the startup line as JSON through the logger, with a static message', () => {
    const { stdout } = runDist({ ...VALID_ENV, NODE_ENV: 'production' });

    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    // Dos lineas desde S-004: la de configuracion y la del fallo de arranque por la key ausente.
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;

    expect(line['msg']).toBe('configuracion valida');
    expect(line['service']).toBe('jiku-mail-connector');
    expect(line['level']).toBe('info');
    expect(line['instance']).toBe('dev');
    expect(line['logLevel']).toBe('info');
    // Estructurado quiere decir consultable: el timeout va como numero, no como el String() que el
    // process.stdout.write de S-002 necesitaba.
    expect(line['timeoutMs']).toBe(15_000);
    expect(typeof line['timeoutMs']).toBe('number');
  }, 30_000);

  it('keeps the four sensitive fields out of the startup line', () => {
    const { stdout } = runDist({ ...VALID_ENV, NODE_ENV: 'production' });

    const first = stdout.split('\n').filter((l) => l.trim() !== '')[0] as string;
    const line = JSON.parse(first) as Record<string, unknown>;

    // Rutas a secretos (donde esta el secreto es informacion sobre el secreto) y topologia del
    // despliegue. ADR-006: una linea de arranque exitoso sin ninguna credencial.
    for (const field of ['credsFile', 'keyFile', 'zitadelProjectId', 'servers']) {
      expect(line, `${field} must stay out of the startup line`).not.toHaveProperty(field);
    }
  }, 30_000);

  // TS-22: el fallo de arranque de S-004 sale con exit != 0 Y por el logger, no por stderr. Vive
  // aca porque este archivo ya ejecuta el dist/ como proceso real, que es la unica forma de
  // verificar el comportamiento del PROCESO —exit code y stream— en lugar del de una funcion.
  it('aborts with a non-zero exit code and a logged diagnosis when the key cannot be read', () => {
    const result = runDist({ ...VALID_ENV, JIKU_KEY_FILE: '/nonexistent/key.json', NODE_ENV: 'production' });

    expect(result.status).not.toBe(0);

    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    const failure = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['level'] === 'fatal');

    // Por el LOGGER, no por stderr: a diferencia del fallo de configuracion —que ocurre antes de
    // que el logger exista— este ocurre despues, y el log estructurado es lo unico que hace
    // diagnosticable un worker que nadie esta mirando.
    expect(failure).toBeDefined();
    expect(failure?.['code']).toBe('BUS_KEY_LOAD_ERROR');
    expect(failure?.['diagnosis']).toBe('key_ilegible');

    // Y no vuelca el contenido de ningun secreto ni la ruta de la key.
    const everything = `${result.stdout}${result.stderr}`;
    expect(everything).not.toContain('BEGIN RSA');
    expect(everything).not.toContain('/nonexistent/key.json');
  }, 30_000);

  it('aborts naming Zitadel when the key is readable but no token can be had', () => {
    // Con una key REAL, el arranque pasa el Paso 3 y muere en el Paso 4 — y esa es la prueba, a
    // nivel de PROCESO, del hallazgo que gobierna todo el diagnostico de esta story: el SDK pide
    // el token ANTES de abrir el socket, deliberadamente. Aca no hay Zitadel alcanzable, asi que
    // el fallo es de token y NUNCA se llega a la red del bus.
    //
    // Corolario para quien lea esto buscando el test del puerto cerrado: no puede existir a nivel
    // de proceso sin un Zitadel vivo, porque el token se pide primero. La rama `bus_inalcanzable`
    // se ejercita en test/bus/connection.test.ts (TS-9 y TS-10), con un token source doblado.
    const result = runDist({
      ...VALID_ENV,
      JIKU_KEY_FILE: VALID_KEY_FILE,
      JIKU_CREDS: READABLE_CREDS,
      JIKU_SERVERS: 'nats://127.0.0.1:1',
      NODE_ENV: 'production',
    });

    expect(result.status).not.toBe(0);

    const failure = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['level'] === 'fatal');

    expect(failure?.['code']).toBe('BUS_CONNECT_ERROR');
    expect(failure?.['diagnosis']).toBe('zitadel_no_entrego_token');

    // `OAuthError` y no `JikuError`: como el conector pide el token el mismo antes de connect(), el
    // error que se loguea es el REAL de Zitadel en vez del envoltorio del SDK. Es una mejora
    // concreta del diagnostico —el operador ve que fallo el intercambio OAuth, no un generico
    // "algo del bus"— y es el efecto observable de por que el token se pide aparte.
    expect(failure?.['sdkErrorClass']).toBe('OAuthError');

    // Y el diagnostico NO se confunde con el rechazo del bus, que tiene otro arreglo.
    expect(failure?.['diagnosis']).not.toBe('rechazo_del_bus_por_subject');
  }, 60_000);

  it('reports an invalid environment on stderr without the logger intervening', async () => {
    // La asimetria es deliberada, no un descuido: el Paso 1 (validacion) falla ANTES de que el
    // logger exista, asi que su reporte sale por stderr directo. Del Paso 2 en adelante se falla
    // con logger.
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH({ JIKU_INSTANCE: 'dev' }),
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('la configuracion es invalida');
    // Sin linea JSON de arranque: el logger no llego a construirse.
    expect(result.stdout.trim()).toBe('');
  }, 30_000);

  // TS-33: el `dist/` del entry point de VERIFICACION arranca y resuelve sus `#` imports.
  //
  // Es el mismo error que este archivo previene para `index.js`, y vale doble aca: `verify` es el
  // entry point que casi nunca se corre, asi que un mapeo roto suyo se descubriria recien cuando un
  // operador esta verificando un despliegue nuevo y necesita que funcione.
  it('resolves every subpath import of the verify entry point at runtime', () => {
    const result = runDistVerify(VALID_ENV);

    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
    // Llego a ejecutar codigo propio: la configuracion valido y el arranque emitio su linea.
    expect(result.stdout).toContain('configuracion valida');
  }, 30_000);

  it('makes the verify entry point fail by CONFIGURATION, not by module resolution', () => {
    // La distincion es la que hace util a este test: un proceso que muere en la resolucion de
    // modulos y uno que muere validando el entorno fallan los dos, y solo el segundo significa que
    // el cableado esta bien.
    const result = spawnSync(process.execPath, ['dist/verify.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH({ JIKU_INSTANCE: 'dev' }),
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('la configuracion es invalida');
    for (const name of REQUIRED_VARIABLES) {
      expect(result.stderr).toContain(name);
    }
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
  }, 30_000);

  it('never publishes anything from the verify entry point without a reachable bus', () => {
    // El modo de verificacion publica UN comando y sale. Sin bus alcanzable tiene que morir en el
    // arranque con codigo != 0 y sin colgarse: es un proceso de vida corta que cierra la conexion en
    // un `finally`, no un worker que queda esperando.
    const result = runDistVerify({
      ...VALID_ENV,
      JIKU_KEY_FILE: VALID_KEY_FILE,
      JIKU_CREDS: READABLE_CREDS,
      JIKU_SERVERS: 'nats://127.0.0.1:1',
      NODE_ENV: 'production',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
  }, 60_000);

  it('never writes a secret path to stdout, where the structured log goes', () => {
    const { stdout } = runDist(VALID_ENV);

    // stdout es el log estructurado, y ahi una ruta a un secreto no entra por ningun camino: ni
    // en la linea de arranque (que la excluye por omision) ni en la de fallo (cuyo contexto NO
    // lleva el mensaje de KeyLoadError, justamente porque nombra la ruta).
    for (const secret of [VALID_ENV.JIKU_CREDS, VALID_ENV.JIKU_KEY_FILE, VALID_ENV.JIKU_PROJECT_ID]) {
      expect(stdout).not.toContain(secret);
    }
  }, 30_000);
});
