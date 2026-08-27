import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, inject, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function runningNatsContainerIds(): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--filter',
    'ancestor=nats:2.10-alpine',
    '--format',
    '{{.ID}}',
  ]);

  return stdout.split('\n').filter((line) => line.trim() !== '');
}

// TS-15: la disciplina del contenedor compartido solo se prueba entre archivos distintos, no
// entre dos it() del mismo archivo. Este archivo corre en un worker separado de
// `nats-url.test.ts` y le pregunta a Docker cuantos contenedores NATS hay realmente: si algun
// archivo levantara el suyo, habria mas de uno y el id dejaria de coincidir con el inyectado.
describe('the single shared NATS container', () => {
  it('is the only NATS container running for the whole suite', async () => {
    const ids = await runningNatsContainerIds();

    expect(ids).toHaveLength(1);
  }, 30_000);

  it('is the very container the global setup provided to every file', async () => {
    const [runningId] = await runningNatsContainerIds();
    const injectedId = inject('natsContainerId');

    // `docker ps` acorta el id a 12 caracteres; el del SDK de testcontainers es completo.
    expect(injectedId.startsWith(String(runningId))).toBe(true);
  }, 30_000);

  it('serves the same url this file and every other file received', () => {
    expect(inject('natsUrl')).toMatch(/^nats:\/\/.+:\d+$/);
  });
});
