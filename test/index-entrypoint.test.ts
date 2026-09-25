import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = 'test/fixtures/scheduler-process-harness.mjs';

/**
 * TS-6, TS-7, TS-8, TS-10, TS-11, TS-12 (Tareas 2 y 3 del Story Plan de S-011): las propiedades
 * observables del proceso REAL —schedular, quedar vivo, apagarse ordenadamente— que solo se
 * pueden afirmar contra un proceso de sistema operativo real, no invocando funciones en el mismo
 * proceso de test (CA-4, CA-13 lo exige para el reloj del cron, no para el proceso en si).
 *
 * El arnes (`test/fixtures/scheduler-process-harness.mjs`) reproduce el patron de `src/index.ts`
 * usando el codigo REAL compilado en `dist/` (`scheduleTick`, `createShutdownHandler`,
 * `closeBus`), pero sustituye `runStartup()` por una conexion directa al NATS del contenedor con
 * un `TokenSource` doblado — el mismo bypass de Zitadel que ya usa `test/bus/connection.test.ts`
 * para sus tests unitarios (`Client.fromConnection`/`creds: null`). Zitadel no es alcanzable en
 * este entorno (ver nota de `test/publicacion/verify-entry-point.test.ts`), asi que un proceso que
 * pasara por `runStartup()` real jamas llegaria a "conectado al bus".
 *
 * `src/index.ts` en si queda cubierto por `TS-16` (verificacion de contenido) y por el hecho de
 * que el arnes importa exactamente las mismas funciones que `main()` compone.
 */

function harnessConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    servers: inject('natsUrl'),
    instance: 'test',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: '307f1f77bcf86cd799439011',
    issuer: 'https://id.grava.io',
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'info',
    nodeEnv: 'production',
    imap: {
      host: 'imap.example.invalid',
      port: 993,
      user: 'tickets@example.invalid',
      password: 'app-password-de-prueba',
    },
    poll: { cron: '0 0 1 1 *', enabled: true, maxPerTick: 50 }, // una vez al año: no dispara en el test
    ...overrides,
  };
}

function spawnHarness(config: Record<string, unknown>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [HARNESS], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env['PATH'],
      HARNESS_CONFIG: JSON.stringify(config),
      HARNESS_TOKEN: 'harness-token',
    },
  });
}

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`timeout esperando ${pattern} en stdout. Recibido:\n${buffer}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

beforeAll(async () => {
  await execFileAsync('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
}, 180_000);

describe('el arnes de proceso real, con POLL_ENABLED=false', () => {
  it('TS-8/TS-10: no schedula nada, loguea el mensaje de deshabilitado, y el proceso queda vivo', async () => {
    const child = spawnHarness(harnessConfig({ poll: { cron: '0 0 1 1 *', enabled: false, maxPerTick: 50 } }));

    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    try {
      await waitForStdout(child, /poll deshabilitado: no se schedula ningún tick/);

      // CA-4: se afirma la PROPIEDAD (el proceso sigue vivo), no el mecanismo que la produce.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(exited).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});

describe('el arnes de proceso real, con POLL_ENABLED=true', () => {
  it('TS-6/TS-7: schedula el tick (cron largo) y ningun tick corre antes del primer disparo', async () => {
    const child = spawnHarness(harnessConfig());

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    try {
      await waitForStdout(child, /conectado al bus/);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(exited).toBe(false);
      expect(stdout).not.toContain('tick completado'); // ningun tick corrio
      expect(stdout).not.toContain('poll deshabilitado');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  it('TS-11: SIGTERM detiene el proceso ordenadamente y sale con codigo 0', async () => {
    const child = spawnHarness(harnessConfig());

    // No alcanza con "conectado al bus": se loguea antes de registrar los handlers de señal.
    await waitForStdout(child, /harness listo: handlers de señal registrados/);

    child.kill('SIGTERM');
    const code = await waitForExit(child);

    expect(code).toBe(0);
  }, 30_000);

  it('TS-12: SIGINT produce el mismo apagado ordenado, saliendo con codigo 0', async () => {
    const child = spawnHarness(harnessConfig());

    await waitForStdout(child, /harness listo: handlers de señal registrados/);

    child.kill('SIGINT');
    const code = await waitForExit(child);

    expect(code).toBe(0);
  }, 30_000);
});

describe('src/index.ts', () => {
  function sourceOf(file: string): string {
    return readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  }

  it('TS-16: la nota diferida sobre manejo de senales ya no aparece, y las senales si estan cableadas', () => {
    const source = sourceOf('index.ts');

    expect(source.toLowerCase()).not.toContain('agregarlo ahora seria codigo sin ningun criterio');
    expect(source).toContain('SIGTERM');
    expect(source).toContain('SIGINT');
  });
});
