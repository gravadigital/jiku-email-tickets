import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

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
  it('starts dist/index.js with the subpath import resolved', async () => {
    const { stdout, stderr } = await execFileAsync('node', ['dist/index.js'], {
      cwd: PROJECT_ROOT,
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('jiku-mail-connector');
  }, 30_000);
});
