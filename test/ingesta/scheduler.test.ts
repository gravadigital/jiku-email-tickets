import { describe, expect, it, vi } from 'vitest';

import { scheduleTick, triggerTick, waitForCurrentTick } from '#domain/ingesta/scheduler.js';

import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-1 a TS-5 y el test adicional de `waitForCurrentTick()` (Tarea 1 del Story Plan de S-011).
 *
 * Ninguno de estos tests dispara `node-cron` ni avanza un reloj real (CA-13): el guard de no
 * solapamiento se invoca directamente via `triggerTick(config, logger, fakeTick)`, con la funcion
 * de tick real (`runIngestaTick`) reemplazada por un doble inyectado — mismo patron que
 * `imapFlowCtor` en `infra/imap/client.ts`.
 */

describe('scheduler: triggerTick — el guard de no solapamiento', () => {
  it('TS-1: deja correr el tick cuando no hay uno en curso', async () => {
    const { logger } = testLoggerWithCapture();
    const fakeTick = vi.fn().mockResolvedValue(undefined);

    await triggerTick(configStub(), logger, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(1);
    expect(fakeTick).toHaveBeenCalledWith(configStub(), logger);
  });

  it('TS-2: un disparo mientras hay un tick en curso se saltea con warn y no se encola', async () => {
    const { logger, capture } = testLoggerWithCapture();
    let resolveFirst!: () => void;
    const fakeTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = triggerTick(configStub(), logger, fakeTick);
    // El segundo disparo llega mientras el primero sigue pendiente.
    await triggerTick(configStub(), logger, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(1); // la segunda invocacion NO llamo al fakeTick

    const warnLine = capture.lines().find((line) => line['level'] === 30 || line['msg'] === 'tick salteado: hay uno en curso');
    expect(warnLine).toMatchObject({ msg: 'tick salteado: hay uno en curso' });

    resolveFirst();
    await first;
  });

  it('TS-3: el indicador se libera cuando el tick termina con exito, y el siguiente disparo corre', async () => {
    const { logger } = testLoggerWithCapture();
    const fakeTick = vi.fn().mockResolvedValue(undefined);

    await triggerTick(configStub(), logger, fakeTick);
    await triggerTick(configStub(), logger, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(2);
  });

  it('TS-4 (el que no se puede omitir): libera el indicador aunque el tick lance', async () => {
    const { logger } = testLoggerWithCapture();
    const failingTick = vi.fn().mockRejectedValue(new Error('tick fallido'));
    const nextTick = vi.fn().mockResolvedValue(undefined);

    await expect(triggerTick(configStub(), logger, failingTick)).resolves.toBeUndefined();
    await triggerTick(configStub(), logger, nextTick);

    expect(nextTick).toHaveBeenCalledTimes(1);
  });

  it('TS-5: el indicador vive en el modulo, no en un objeto pasado por parametro', () => {
    // triggerTick solo recibe config, logger y opcionalmente la funcion de tick inyectable — no
    // hay ningun parametro de tipo cola/semaforo/store representando el estado de solapamiento.
    expect(triggerTick.length).toBeLessThanOrEqual(3);
  });
});

describe('scheduler: waitForCurrentTick()', () => {
  it('resuelve de inmediato cuando no hay ningun tick en curso', async () => {
    await expect(waitForCurrentTick()).resolves.toBeUndefined();
  });

  it('no resuelve hasta que el tick en curso termina', async () => {
    const { logger } = testLoggerWithCapture();
    let resolveTick!: () => void;
    const fakeTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );

    const inFlight = triggerTick(configStub(), logger, fakeTick);

    let waited = false;
    const waiter = waitForCurrentTick().then(() => {
      waited = true;
    });

    // Todavia no deberia haber resuelto: el tick sigue pendiente.
    await Promise.resolve();
    expect(waited).toBe(false);

    resolveTick();
    await inFlight;
    await waiter;

    expect(waited).toBe(true);
  });
});

describe('scheduler: scheduleTick() — las dos ramas de POLL_ENABLED (Tarea 2)', () => {
  it('TS-6: con POLL_ENABLED=true schedula el tick exactamente una vez con la expresion configurada', () => {
    const { logger } = testLoggerWithCapture();
    const config = { ...configStub(), poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 } };
    const fakeScheduledTask = { stop: vi.fn() };
    const cronScheduleFn = vi.fn().mockReturnValue(fakeScheduledTask);

    const task = scheduleTick(config, logger, vi.fn(), cronScheduleFn);

    expect(cronScheduleFn).toHaveBeenCalledTimes(1);
    expect(cronScheduleFn).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    expect(task).toBe(fakeScheduledTask);
  });

  it('TS-7: no hay tick inmediato al arrancar — la funcion de tick inyectada no se invoca al schedular', () => {
    const { logger } = testLoggerWithCapture();
    const config = { ...configStub(), poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 } };
    const runTick = vi.fn().mockResolvedValue(undefined);
    const cronScheduleFn = vi.fn().mockReturnValue({ stop: vi.fn() });

    scheduleTick(config, logger, runTick, cronScheduleFn);

    expect(runTick).not.toHaveBeenCalled();
  });

  it('TS-8: con POLL_ENABLED=false no schedula nada, loguea el mensaje de deshabilitado, y retorna undefined', () => {
    const { logger, capture } = testLoggerWithCapture();
    const config = { ...configStub(), poll: { cron: '*/5 * * * *', enabled: false, maxPerTick: 50 } };
    const cronScheduleFn = vi.fn();

    const task = scheduleTick(config, logger, vi.fn(), cronScheduleFn);

    expect(cronScheduleFn).not.toHaveBeenCalled();
    expect(task).toBeUndefined();
    expect(capture.lines()).toContainEqual(
      expect.objectContaining({ msg: 'poll deshabilitado: no se schedula ningún tick' }),
    );
  });
});

function configStub() {
  return {
    servers: 'nats://localhost:4222',
    instance: 'dev',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: '307f1f77bcf86cd799439011',
    issuer: 'https://id.grava.io',
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'info' as const,
    nodeEnv: 'production' as const,
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      user: 'tickets@ejemplo.com',
      password: 'app-password-de-prueba',
    },
    poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
  };
}
