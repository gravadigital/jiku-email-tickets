import type { Client } from '@gravadigital/jiku';
import { describe, expect, it, vi } from 'vitest';

import { scheduleTick, triggerTick, waitForCurrentTick } from '#domain/ingesta/scheduler.js';

import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-1 a TS-5 y el test adicional de `waitForCurrentTick()` (Tarea 1 del Story Plan de S-011).
 *
 * Ninguno de estos tests dispara `node-cron` ni avanza un reloj real (CA-13): el guard de no
 * solapamiento se invoca directamente via `triggerTick(config, logger, client, fakeTick)`, con la
 * funcion de tick real (`runIngestaTick`) reemplazada por un doble inyectado — mismo patron que
 * `imapFlowCtor` en `infra/imap/client.ts`.
 *
 * `client` es un STUB minimo (S-015): estos tests son sobre el guard de no solapamiento, no sobre
 * publicacion — `fakeTick` nunca lo usa de verdad, asi que no hace falta el bus real.
 */

const FAKE_CLIENT = {} as unknown as Client;

describe('scheduler: triggerTick — el guard de no solapamiento', () => {
  it('TS-1: deja correr el tick cuando no hay uno en curso', async () => {
    const { logger } = testLoggerWithCapture();
    const fakeTick = vi.fn().mockResolvedValue(undefined);

    await triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(1);
    expect(fakeTick).toHaveBeenCalledWith(configStub(), logger, FAKE_CLIENT);
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

    const first = triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);
    // El segundo disparo llega mientras el primero sigue pendiente.
    await triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(1); // la segunda invocacion NO llamo al fakeTick

    const warnLine = capture.lines().find((line) => line['level'] === 30 || line['msg'] === 'tick salteado: hay uno en curso');
    expect(warnLine).toMatchObject({ msg: 'tick salteado: hay uno en curso' });

    resolveFirst();
    await first;
  });

  it('TS-3: el indicador se libera cuando el tick termina con exito, y el siguiente disparo corre', async () => {
    const { logger } = testLoggerWithCapture();
    const fakeTick = vi.fn().mockResolvedValue(undefined);

    await triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);
    await triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);

    expect(fakeTick).toHaveBeenCalledTimes(2);
  });

  it('TS-4 (el que no se puede omitir): libera el indicador aunque el tick lance', async () => {
    const { logger } = testLoggerWithCapture();
    const failingTick = vi.fn().mockRejectedValue(new Error('tick fallido'));
    const nextTick = vi.fn().mockResolvedValue(undefined);

    await expect(triggerTick(configStub(), logger, FAKE_CLIENT, failingTick)).resolves.toBeUndefined();
    await triggerTick(configStub(), logger, FAKE_CLIENT, nextTick);

    expect(nextTick).toHaveBeenCalledTimes(1);
  });

  it('TS-5: el indicador vive en el modulo, no en un objeto pasado por parametro', () => {
    // triggerTick solo recibe config, logger, el client y opcionalmente la funcion de tick
    // inyectable — no hay ningun parametro de tipo cola/semaforo/store representando el estado de
    // solapamiento.
    expect(triggerTick.length).toBeLessThanOrEqual(4);
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

    const inFlight = triggerTick(configStub(), logger, FAKE_CLIENT, fakeTick);

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

    const task = scheduleTick(config, logger, FAKE_CLIENT, vi.fn(), cronScheduleFn);

    expect(cronScheduleFn).toHaveBeenCalledTimes(1);
    expect(cronScheduleFn).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    expect(task).toBe(fakeScheduledTask);
  });

  // Defensa complementaria de S-016 CA-8, junto con `test/publicacion/verify-entry-point.test.ts`
  // (que afirma la mitad estructural: `index.ts`/`startup.ts` no importan `#domain/publicacion/`
  // ni hacen `.command(`). ESTE test es el que impide "que cada reinicio deje basura permanente"
  // (Riesgo 1 de REQ-003) ahora que existe un camino de codigo real de `index.ts` a `publicacion`
  // via el tick (S-014/S-015): si `scheduleTick()` alguna vez disparara un tick inmediato al
  // arrancar, cada reinicio del proceso republicaria altas para los mails ya `\Unseen` en ese
  // instante. Nombrado explicitamente para que nadie lo elimine por "redundante".
  it('TS-7: no hay tick inmediato al arrancar — la funcion de tick inyectada no se invoca al schedular', () => {
    const { logger } = testLoggerWithCapture();
    const config = { ...configStub(), poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 } };
    const runTick = vi.fn().mockResolvedValue(undefined);
    const cronScheduleFn = vi.fn().mockReturnValue({ stop: vi.fn() });

    scheduleTick(config, logger, FAKE_CLIENT, runTick, cronScheduleFn);

    expect(runTick).not.toHaveBeenCalled();
  });

  it('TS-8: con POLL_ENABLED=false no schedula nada, loguea el mensaje de deshabilitado, y retorna undefined', () => {
    const { logger, capture } = testLoggerWithCapture();
    const config = { ...configStub(), poll: { cron: '*/5 * * * *', enabled: false, maxPerTick: 50 } };
    const cronScheduleFn = vi.fn();

    const task = scheduleTick(config, logger, FAKE_CLIENT, vi.fn(), cronScheduleFn);

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
    ruteo: {
      ticketMap: new Map([['alfa', 42]]),
      subaddressPrefix: 'tickets',
      placeholderTitle: 'Ticket recibido por mail',
      placeholderBody: '(mail sin contenido)',
    },
    adjuntos: {
      allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
      maxSizeBytes: 10_485_760,
      putTimeoutMs: 30_000,
    },
    kv: {
      ticketsBucket: 'TICKETS',
      threadsBucket: 'MAIL_THREADS',
      threadsTtlDays: 90,
      watchRetryMs: 30_000,
    },
  };
}
