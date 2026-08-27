import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

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

// El error que este archivo previene es el que pasa el typecheck y falla al arrancar:
// tsc no reescribe los especificadores al emitir, asi que el mapeo `#` tiene que estar
// configurado tambien del lado runtime (package.json#imports).
describe('the built dist/ resolves subpath imports at runtime', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
  }, 120_000);

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
  it('starts dist/index.js with the subpath import resolved', async () => {
    const { stdout, stderr } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH(VALID_ENV),
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('jiku-mail-connector');
  }, 30_000);

  it('exits zero with a complete environment, resolving every subpath import', async () => {
    const { stdout, stderr } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH(VALID_ENV),
    });

    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
    expect(stdout).toContain('configuracion valida');
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
  it('emits the startup line as JSON through the logger, with a static message', async () => {
    const { stdout } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH({ ...VALID_ENV, NODE_ENV: 'production' }),
    });

    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);

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

  it('keeps the four sensitive fields out of the startup line', async () => {
    const { stdout } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH({ ...VALID_ENV, NODE_ENV: 'production' }),
    });

    const line = JSON.parse(stdout.trim()) as Record<string, unknown>;

    // Rutas a secretos (donde esta el secreto es informacion sobre el secreto) y topologia del
    // despliegue. ADR-006: una linea de arranque exitoso sin ninguna credencial.
    for (const field of ['credsFile', 'keyFile', 'zitadelProjectId', 'servers']) {
      expect(line, `${field} must stay out of the startup line`).not.toHaveProperty(field);
    }
  }, 30_000);

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

  it('never writes a secret path to either stream on a successful start', async () => {
    const { stdout, stderr } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: BASE_ENV_WITH(VALID_ENV),
    });

    for (const secret of [VALID_ENV.JIKU_CREDS, VALID_ENV.JIKU_KEY_FILE, VALID_ENV.JIKU_PROJECT_ID]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  }, 30_000);
});
