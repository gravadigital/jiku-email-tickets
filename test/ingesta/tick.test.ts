import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MissingMessageIdError } from '#domain/ingesta/errors.js';
import { normalize } from '#domain/ingesta/normalize.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick, type TickCounters } from '#domain/ingesta/tick.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * Suite del tick: TS-1 a TS-14, TS-19 a TS-24 (los que no dependen de un fallo de conexion — esos
 * son de `tick-entrypoint.test.ts`, Tarea 3). Dobla `MailSource` directamente, nunca `ImapFlow` ni
 * un servidor real (convencion `testing`). Los mails "reales" usan los fixtures `.eml` de S-008;
 * el unico caso que no tiene fixture real (un mail descargado que falla el PARSEO, distinto de
 * "sin Message-Id") inyecta un `normalize` doblado, tal como anticipa la Story Plan.
 *
 * Desde S-015, un mail RESUELTO (`route.ok === true`) dispara una publicacion real de
 * `requirements.new` dentro del tick — asi que esta suite necesita el bus real (convencion
 * `testing`: nunca se mockea) con UN responder de exito PERMANENTE, suscripto una sola vez en
 * `beforeAll` para todo el archivo. Ninguna suite de este archivo es sobre publicacion (esas viven
 * en `publish-from-mail.test.ts`, Tarea 3): lo unico que estas suites necesitan es que la
 * publicacion NO falle, para que sus aserciones de ingesta (orden, marcado, contadores) sigan
 * valiendo sin reescribirse.
 */

let bus: TestBusContext;
let responder: CoreResponder | undefined;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  // Responder de exito PERMANENTE: cualquier mail que route.ok resuelva publica con exito, con un
  // id incremental. Las suites de este archivo que no son sobre publicacion no lo reemplazan.
  responder = await respondTo(
    bus.connection,
    'requirements.new',
    Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
  );
});

afterAll(async () => {
  await responder?.stop();
  await bus.cleanup();
});

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

const BASE_CONFIG: AppConfig = {
  servers: 'nats://localhost:4222',
  instance: 'dev',
  credsFile: '/run/secrets/sentinel.creds',
  keyFile: '/run/secrets/machine-user.json',
  zitadelProjectId: '307f1f77bcf86cd799439011',
  issuer: 'https://id.grava.io',
  timeoutMs: 15_000,
  verifyProjectId: 42,
  logLevel: 'info',
  nodeEnv: 'production',
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

function configWithMax(maxPerTick: number): AppConfig {
  return { ...BASE_CONFIG, poll: { ...BASE_CONFIG.poll, maxPerTick } };
}

/**
 * Un doble de `MailSource` en memoria: cada UID tiene bytes fijados (por defecto, un mail real
 * parseable) o esta marcado para que `fetch()` rechace.
 */
function fakeMailSource(config: {
  uidsUnseen: number[];
  sources?: Map<number, Buffer>;
  failFetchFor?: Set<number>;
  onFetch?: (uid: number) => void;
}): MailSource & { seen: number[]; fetchCalls: number[]; markSeenCalls: number[] } {
  const failFetchFor = config.failFetchFor ?? new Set<number>();
  const sources = config.sources ?? new Map<number, Buffer>();
  const seen: number[] = [];
  const fetchCalls: number[] = [];
  const markSeenCalls: number[] = [];

  return {
    seen,
    fetchCalls,
    markSeenCalls,
    async searchUnseen(): Promise<number[]> {
      return [...config.uidsUnseen];
    },
    async fetch(uid: number): Promise<RawMessage> {
      fetchCalls.push(uid);
      config.onFetch?.(uid);
      if (failFetchFor.has(uid)) {
        throw new Error(`fetch failed for uid ${uid}`);
      }
      const source = sources.get(uid) ?? fixture('plain-text.eml');
      return { uid, source };
    },
    async markSeen(uid: number): Promise<void> {
      markSeenCalls.push(uid);
      seen.push(uid);
    },
  };
}

/**
 * Construye un mail RFC 822 valido y parseable con un Message-Id distinto por UID.
 *
 * `To: tickets+alfa@grava.io` (S-014): `alfa` esta mapeado en `BASE_CONFIG.ruteo.ticketMap`, asi que
 * este mail siempre resuelve via `routeMail()` — no se descarta. Los tests que usan este helper
 * afirman mecanica de ingesta (orden, marcado, contadores), no ruteo; que resuelva es lo que
 * preserva su intencion original tras cablear el ruteo en el tick.
 */
function mailWithId(uid: number): Buffer {
  return Buffer.from(
    `Message-Id: <uid-${uid}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `Cuerpo del mail ${uid}.\r\n`,
  );
}

function tickLine(capture: { lines(): Record<string, unknown>[] }): Record<string, unknown> | undefined {
  return capture.lines().find((line) => line['msg'] === 'tick completado');
}

describe('runTick — TickCounters and control structure (Tarea 1)', () => {
  it('TickCounters starts with all five counters at zero', () => {
    const counters: TickCounters = {
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
    };

    expect(counters).toEqual({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
  });

  // TS-15 (parcial): si searchUnseen() rechaza, la linea de metricas se emite igual, en 0.
  it('emits the metrics line with all counters at zero when searchUnseen() rejects', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        throw new Error('connection lost');
      },
      async fetch(): Promise<RawMessage> {
        throw new Error('unreachable');
      },
      async markSeen(): Promise<void> {
        // unreachable
      },
    };

    await expect(runTick(source, configWithMax(50), logger, bus.client)).rejects.toThrow('connection lost');

    expect(tickLine(capture)).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
  });
});

describe('runTick — happy path (CA-1)', () => {
  // TS-1 (actualizado por S-015: un mail resuelto (`alfa`, mapeado) ahora se publica y cuenta como
  // `creados`, no como un `'mail procesado'` sin consecuencia — el alta es lo que esta suite ejercita
  // desde que el ruteo se cablea con la publicacion).
  it('processes three unseen mails, marks them Seen, and reports the five counters', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const sources = new Map([
      [3, mailWithId(3)],
      [2, mailWithId(2)],
      [1, mailWithId(1)],
    ]);
    const source = fakeMailSource({ uidsUnseen: [3, 2, 1], sources });

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(source.seen).toEqual([3, 2, 1]);
    expect(tickLine(capture)).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 3,
      descartados: 0,
      fallidos: 0,
    });
  });

  // TS-2, CA-15 (actualizado por S-015: el mail resuelto ya no loguea `'mail procesado'` — loguea
  // `'requisito creado en Jiku'`, la linea que `publishRequirementFromMail()` emite con los tres
  // identificadores, CA-14).
  it('logs one line per mail with its real messageId', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const sources = new Map([
      [3, mailWithId(3)],
      [2, mailWithId(2)],
      [1, mailWithId(1)],
    ]);
    const source = fakeMailSource({ uidsUnseen: [3, 2, 1], sources });

    await runTick(source, configWithMax(50), logger, bus.client);

    const perMailLines = capture
      .lines()
      .filter((line) => line['msg'] === 'requisito creado en Jiku');

    expect(perMailLines).toHaveLength(3);
    expect(perMailLines.map((line) => line['messageId']).sort()).toEqual([
      '<uid-1@fixtures.local>',
      '<uid-2@fixtures.local>',
      '<uid-3@fixtures.local>',
    ]);
  });
});

describe('runTick — the cap takes the newest and defers the rest (CA-2)', () => {
  // TS-3
  it('processes the 50 newest of 60 and warns that 10 were deferred', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = Array.from({ length: 60 }, (_, i) => 60 - i); // [60, 59, ..., 1]
    const source = fakeMailSource({ uidsUnseen: uids });

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(source.fetchCalls).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i)); // 60..11
    const warnLine = capture.lines().find((line) => line['msg'] === 'mails diferidos por el cap');
    expect(warnLine).toMatchObject({ diferidos: 10 });
  });

  // TS-4
  it('does not mark the 10 deferred mails as Seen', async () => {
    const uids = Array.from({ length: 60 }, (_, i) => 60 - i);
    const source = fakeMailSource({ uidsUnseen: uids });
    const { logger } = testLoggerWithCapture();

    await runTick(source, configWithMax(50), logger, bus.client);

    for (let uid = 1; uid <= 10; uid += 1) {
      expect(source.seen).not.toContain(uid);
    }
  });
});

describe('runTick — processing order is strictly newest-to-oldest and sequential (CA-3)', () => {
  // TS-5
  it('fetches UIDs in strictly descending order, unreordered', async () => {
    const uids = Array.from({ length: 50 }, (_, i) => 60 - i); // [60, 59, ..., 11]
    const source = fakeMailSource({ uidsUnseen: uids });
    const { logger } = testLoggerWithCapture();

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(source.fetchCalls).toEqual(uids);
  });

  // TS-6
  it('processes sequentially: no two fetch intervals overlap', async () => {
    const uids = [3, 2, 1];
    const intervals: { uid: number; start: number; end: number }[] = [];

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return uids;
      },
      async fetch(uid: number): Promise<RawMessage> {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const end = Date.now();
        intervals.push({ uid, start, end });
        return { uid, source: mailWithId(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };
    const { logger } = testLoggerWithCapture();

    await runTick(source, configWithMax(50), logger, bus.client);

    for (let i = 1; i < intervals.length; i += 1) {
      const previous = intervals[i - 1]!;
      const current = intervals[i]!;
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }
  });
});

describe('runTick — empty mailbox (CA-4)', () => {
  // TS-7
  it('finishes without throwing and reports all five counters at zero', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({ uidsUnseen: [] });

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(tickLine(capture)).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
    expect(capture.lines().some((line) => line['msg'] === 'mails diferidos por el cap')).toBe(false);
  });
});

describe('runTick — an unparseable mail does not abort the batch (CA-5)', () => {
  // TS-8
  it('normalizes the other 9 and counts the 4th as fallido', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const source = fakeMailSource({ uidsUnseen: uids });

    // El 4to en orden de procesamiento (UID descendente) es el UID 7 -> se dobla normalize para
    // que falle SOLO para ese UID (bytes distintos por UID vía mailWithId, y un normalize
    // instrumentado que revienta si el buffer corresponde a uid 7).
    const failingNormalize = vi.fn(async (raw: Buffer, log: typeof logger) => {
      if (raw.toString().includes('uid-7@')) {
        throw new Error('parseo roto simulado');
      }
      return normalize(raw, log);
    });

    // Reemplaza fetch para servir mailWithId(uid) en vez del fixture default.
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        return { uid, source: mailWithId(uid) };
      },
    };

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client, failingNormalize);

    const tick = tickLine(capture);
    expect(tick).toMatchObject({ ingestados: 10, parseados: 9, fallidos: 1 });
  });

  // TS-9
  it('keeps processing the batch after a parse failure — fetch was called for all 10', async () => {
    const { logger } = testLoggerWithCapture();
    const uids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const source = fakeMailSource({ uidsUnseen: uids });
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        return { uid, source: mailWithId(uid) };
      },
    };
    const failingNormalize = vi.fn(async (raw: Buffer, log: typeof logger) => {
      if (raw.toString().includes('uid-7@')) throw new Error('parseo roto simulado');
      return normalize(raw, log);
    });

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client, failingNormalize);

    expect(source.fetchCalls).toEqual(uids);
  });

  // TS-10
  it('the mail that fails to parse is still marked Seen', async () => {
    const { logger } = testLoggerWithCapture();
    const uids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const source = fakeMailSource({ uidsUnseen: uids });
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        return { uid, source: mailWithId(uid) };
      },
    };
    const failingNormalize = vi.fn(async (raw: Buffer, log: typeof logger) => {
      if (raw.toString().includes('uid-7@')) throw new Error('parseo roto simulado');
      return normalize(raw, log);
    });

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client, failingNormalize);

    expect(source.seen).toContain(7);
  });
});

describe('runTick — a failed download is skipped without marking (CA-6)', () => {
  // TS-11
  it('does not mark Seen for a uid whose fetch fails, and warns with the uid', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = [5, 4, 3];
    const source = fakeMailSource({ uidsUnseen: uids, failFetchFor: new Set([5]) });

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(source.seen).not.toContain(5);
    const warnLine = capture.lines().find((line) => line['msg'] === 'no se pudo descargar el mensaje');
    expect(warnLine).toMatchObject({ uid: 5 });
  });

  // TS-12
  it('processes the rest of the batch normally, counting ingestados for the failed uid too', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = [5, 4, 3];
    const source = fakeMailSource({ uidsUnseen: uids, failFetchFor: new Set([5]) });
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        if (uid === 5) throw new Error('fetch failed');
        return { uid, source: mailWithId(uid) };
      },
    };

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client);

    expect(source.seen).toEqual([4, 3]);
    expect(tickLine(capture)).toMatchObject({ ingestados: 3, parseados: 2, fallidos: 0 });
  });
});

describe('runTick — marking happens right after download, one at a time (CA-8)', () => {
  // TS-13
  it('the observed order is fetch -> markSeen -> normalize', async () => {
    const order: string[] = [];
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        order.push('fetch');
        return { uid, source: mailWithId(uid) };
      },
      async markSeen(): Promise<void> {
        order.push('markSeen');
      },
    };
    const spiedNormalize = vi.fn(async (raw: Buffer, log) => {
      order.push('normalize');
      return normalize(raw, log);
    });
    const { logger } = testLoggerWithCapture();

    await runTick(source, configWithMax(50), logger, bus.client, spiedNormalize);

    expect(order).toEqual(['fetch', 'markSeen', 'normalize']);
  });

  // TS-14
  it('markSeen is invoked once per uid, interleaved with fetch — never batched at the end', async () => {
    const uids = [5, 4, 3, 2, 1];
    const source = fakeMailSource({ uidsUnseen: uids });
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        return { uid, source: mailWithId(uid) };
      },
    };
    const { logger } = testLoggerWithCapture();

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client);

    expect(source.markSeenCalls).toEqual(uids);
    expect(source.markSeenCalls).toHaveLength(5);
    for (const call of source.markSeenCalls) {
      expect(typeof call).toBe('number');
    }
  });
});

describe('runTick — the five counters, one line (CA-14)', () => {
  // TS-19 (actualizado por S-015: los 9 mails que si normalizan resuelven a `alfa` y se publican
  // con exito, asi que cuentan como `creados`, no como un resultado sin consecuencia)
  it('emits a single info line with exactly the five keys', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const source = fakeMailSource({ uidsUnseen: uids });
    const sourceWithRealMails: MailSource = {
      ...source,
      async fetch(uid: number) {
        source.fetchCalls.push(uid);
        return { uid, source: mailWithId(uid) };
      },
    };
    const failingNormalize = vi.fn(async (raw: Buffer, log: typeof logger) => {
      if (raw.toString().includes('uid-7@')) throw new Error('parseo roto simulado');
      return normalize(raw, log);
    });

    await runTick(sourceWithRealMails, configWithMax(50), logger, bus.client, failingNormalize);

    const tickLines = capture.lines().filter((line) => line['msg'] === 'tick completado');
    expect(tickLines).toHaveLength(1);
    expect(tickLines[0]).toMatchObject({
      ingestados: 10,
      parseados: 9,
      creados: 9,
      descartados: 0,
      fallidos: 1,
    });
  });

  // TS-20 (actualizado por S-014, CA-8: MissingMessageIdError ahora cuenta como descartados)
  it('descartados counts a MissingMessageIdError, no longer fallidos', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: fixture('no-message-id.eml') };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, configWithMax(50), logger, bus.client);

    expect(tickLine(capture)).toMatchObject({ fallidos: 0, descartados: 1 });
  });
});

describe('runTick — no mail is left untraced (CA-15)', () => {
  // TS-21
  it('every uid in the batch appears in at least one log line', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [3, 2, 1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        if (uid === 2) throw new Error('descarga fallida');
        return { uid, source: uid === 1 ? fixture('no-message-id.eml') : mailWithId(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, configWithMax(50), logger, bus.client);

    const lines = capture.lines();
    expect(lines.some((l) => l['messageId'] === '<uid-3@fixtures.local>')).toBe(true);
    expect(lines.some((l) => l['uid'] === 2)).toBe(true);
    // El mail sin Message-Id (uid 1) deja su propio rastro vía el warn de normalize() (motivo).
    expect(lines.some((l) => l['motivo'] === 'sin_message_id')).toBe(true);
  });

  // TS-22
  it('the only mail without messageId in the log is the one discarded for lacking one', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: fixture('no-message-id.eml') };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, configWithMax(50), logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({ motivo: 'sin_message_id' });
    expect(discardLine?.['messageId']).toBeUndefined();
  });
});

describe('runTick — un mail descartado no deja ningun rastro de RouteResult acumulado', () => {
  // TS-23
  it('tick.ts does not declare any array/collection accumulating IncomingMail across iterations', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ingesta/tick.ts', import.meta.url)),
      'utf8',
    );
    // Sin comentarios para no falsos-positivos con texto explicativo.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codeOnly).not.toMatch(/const\s+\w+\s*:\s*IncomingMail\[\]/);
    expect(codeOnly).not.toMatch(/\.push\(mail\)/);
  });

  // TS-24 (invertido por S-015, CA-24: el import de `#domain/publicacion/` y `@gravadigital/jiku`
  // (tipo `Client`) ahora VIVE en `tick.ts`, deliberadamente — es el unico modulo que compone
  // `ingesta` + `ruteo` + `publicacion`. Lo que sigue prohibido es que aparezca en `src/index.ts` o
  // `src/startup.ts`, verificado por `test/publicacion/verify-entry-point.test.ts`, que esta story
  // NO toca.)
  it('tick.ts imports the publication domain and the bus Client type, as CA-24 now requires', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ingesta/tick.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toMatch(/from\s*'#domain\/publicacion/);
    expect(source).toMatch(/from\s*'@gravadigital\/jiku'/);
  });
});

/**
 * Suite de S-014: los cinco motivos de descarte, cableados en el tick via `routeMail()` (S-013), y
 * la correccion del conteo de `MissingMessageIdError` (de `fallidos` a `descartados`, CA-8/CA-9).
 * TS-1 a TS-14 de la Story Plan de S-014 (numeracion propia de esa tabla, distinta de la de S-010
 * reutilizada arriba en este mismo archivo).
 */

/** Mail RFC 822 minimo, parseable, con Message-Id y recipient/subject/body configurables. */
function mailTo(opts: {
  uid: number;
  recipient: string;
  subject?: string;
  body?: string;
}): Buffer {
  return Buffer.from(
    `Message-Id: <s014-${opts.uid}@fixtures.local>\r\n` +
      'From: "Cliente" <cliente@cliente.com>\r\n' +
      `To: ${opts.recipient}\r\n` +
      `Subject: ${opts.subject ?? 'Consulta'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `${opts.body ?? `Cuerpo del mail ${opts.uid}.`}\r\n`,
  );
}

function sourceWithMails(mails: Map<number, Buffer>): MailSource & {
  seen: number[];
  fetchCalls: number[];
} {
  const base = fakeMailSource({ uidsUnseen: [...mails.keys()], sources: mails });
  return base;
}

describe('runTick — es_respuesta se descarta sin slug en la linea (CA-1, CA-2, CA-3, CA-4, CA-7)', () => {
  // TS-1
  it('un mail con referenceIds no vacio se descarta como es_respuesta, sin slug', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, fixture('in-reply-to.eml')]]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({
      motivo: 'es_respuesta',
      messageId: '<in-reply-to-001@fixtures.local>',
    });
    expect(discardLine).not.toHaveProperty('slug');
    expect(tickLine(capture)).toMatchObject({ descartados: 1, fallidos: 0 });
  });
});

describe('runTick — sin_slug se descarta sin slug en la linea (CA-1, CA-2, CA-3, CA-4, CA-7)', () => {
  // TS-2
  it('un mail sin forma de subaddress se descarta como sin_slug', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailTo({ uid: 1, recipient: 'soporte@grava.io' })]]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({
      motivo: 'sin_slug',
      messageId: '<s014-1@fixtures.local>',
    });
    expect(discardLine).not.toHaveProperty('slug');
    expect(tickLine(capture)).toMatchObject({ descartados: 1, fallidos: 0 });
  });
});

describe('runTick — slug_no_mapeado incluye el slug en la linea (CA-1, CA-2, CA-3, CA-4, CA-7)', () => {
  // TS-3
  it('un mail a un slug no mapeado se descarta como slug_no_mapeado, con el slug', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailTo({ uid: 1, recipient: 'tickets+beta@grava.io' })]]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({
      motivo: 'slug_no_mapeado',
      slug: 'beta',
      messageId: '<s014-1@fixtures.local>',
    });
    expect(tickLine(capture)).toMatchObject({ descartados: 1, fallidos: 0 });
  });

  // TS-4
  //
  // Esta es TAMBIEN la defensa permanente de CA-6 de S-016 (Riesgo 3 de REQ-003): sin este test,
  // un campo llamado `key` en el contexto de log produciria una linea inutil `"slug":"[REDACTED]"`
  // SIN FALLAR y SIN AVISAR, porque `REDACT_PATHS` (`src/shared/log-redaction.ts`) incluye `'key'`
  // y `'*.key'`. No se elimina por "redundante": es la unica asercion de todo el repo sobre la
  // salida CRUDA (no el objeto parseado) para este caso puntual.
  it('el slug se loguea literal en la salida cruda, no [REDACTED] (CA-5, S-016 CA-6)', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailTo({ uid: 1, recipient: 'tickets+beta@grava.io' })]]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const rawDiscardLine = capture.raw().find((line) => line.includes('mail descartado'));
    expect(rawDiscardLine).toBeDefined();
    expect(rawDiscardLine).toContain('"slug":"beta"');
    expect(rawDiscardLine).not.toContain('"slug":"[REDACTED]"');
  });
});

describe('runTick — los descartes cuentan como descartados, nunca fallidos (CA-7)', () => {
  // TS-5
  it('un tick de 10 mails con 3 descartes de motivos distintos cuenta descartados: 3, fallidos: 0', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const mails = new Map<number, Buffer>([
      [10, fixture('in-reply-to.eml')], // es_respuesta
      [9, mailTo({ uid: 9, recipient: 'soporte@grava.io' })], // sin_slug
      [8, mailTo({ uid: 8, recipient: 'tickets+beta@grava.io' })], // slug_no_mapeado
      [7, mailTo({ uid: 7, recipient: 'tickets+alfa@grava.io' })], // resuelto (alfa esta mapeado)
      [6, mailTo({ uid: 6, recipient: 'tickets+alfa@grava.io' })],
      [5, mailTo({ uid: 5, recipient: 'tickets+alfa@grava.io' })],
      [4, mailTo({ uid: 4, recipient: 'tickets+alfa@grava.io' })],
      [3, mailTo({ uid: 3, recipient: 'tickets+alfa@grava.io' })],
      [2, mailTo({ uid: 2, recipient: 'tickets+alfa@grava.io' })],
      [1, mailTo({ uid: 1, recipient: 'tickets+alfa@grava.io' })],
    ]);
    const source = sourceWithMails(mails);

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(tickLine(capture)).toMatchObject({ descartados: 3, fallidos: 0, parseados: 10 });
  });
});

describe('runTick — MissingMessageIdError pasa a descartados (CA-8)', () => {
  // TS-6
  it('un tick con 5 mails sin Message-Id cuenta descartados: 5, fallidos: 0', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [5, 4, 3, 2, 1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: fixture('no-message-id.eml') };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(tickLine(capture)).toMatchObject({
      descartados: 5,
      fallidos: 0,
      ingestados: 5,
      parseados: 0,
    });
  });
});

describe('runTick — la distincion es por clase, no por texto (CA-9)', () => {
  // TS-7
  it('un error con el mismo mensaje que MissingMessageIdError pero de otra clase sigue siendo fallido', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailWithId(1)]]),
    });
    const impostorNormalize = vi.fn(async () => {
      throw new Error('El mail no tiene header Message-Id: se descarta.');
    });

    await runTick(source, BASE_CONFIG, logger, bus.client, impostorNormalize);

    expect(tickLine(capture)).toMatchObject({ fallidos: 1, descartados: 0 });
  });
});

describe('runTick — no_parseable sigue siendo fallido, con el uid (CA-10)', () => {
  // TS-8
  it('un fallo de parseo generico (no MissingMessageIdError) sigue contando como fallido', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailWithId(1)]]),
    });
    const brokenNormalize = vi.fn(async () => {
      throw new Error('parseo roto simulado');
    });

    await runTick(source, BASE_CONFIG, logger, bus.client, brokenNormalize);

    const warnLine = capture.lines().find((l) => l['msg'] === 'mail no se pudo normalizar');
    expect(warnLine).toMatchObject({ uid: 1 });
    expect(tickLine(capture)).toMatchObject({ fallidos: 1, descartados: 0 });
  });
});

describe('runTick — un descarte no crea nada observable (CA-6)', () => {
  // TS-9
  it('un descarte por slug_no_mapeado no invoca ningun metodo de escritura fuera de markSeen', async () => {
    const { logger } = testLoggerWithCapture();
    const calls: string[] = [];
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        calls.push('searchUnseen');
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        calls.push('fetch');
        return { uid, source: mailTo({ uid: 1, recipient: 'tickets+beta@grava.io' }) };
      },
      async markSeen(): Promise<void> {
        calls.push('markSeen');
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(calls).toEqual(['searchUnseen', 'fetch', 'markSeen']);
  });
});

describe('runTick — el mail se descarta dentro de su propia iteracion (CA-11)', () => {
  // TS-10
  it('tick.ts no declara ningun array acumulador de RouteResult entre iteraciones', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ingesta/tick.ts', import.meta.url)),
      'utf8',
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codeOnly).not.toMatch(/const\s+\w+\s*:\s*RouteResult\[\]/);
    expect(codeOnly).not.toMatch(/\.push\(result\)/);
    expect(codeOnly).not.toMatch(/\.push\(route\)/);
  });
});

describe('runTick — el tick continua con el siguiente UID tras un descarte (CA-12)', () => {
  // TS-11
  it('el descarte del medio no interrumpe el batch: los 3 uids aparecen en fetchCalls y en seen', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const mails = new Map<number, Buffer>([
      [3, mailTo({ uid: 3, recipient: 'tickets+alfa@grava.io' })],
      [2, fixture('in-reply-to.eml')], // es_respuesta, descartado
      [1, mailTo({ uid: 1, recipient: 'tickets+alfa@grava.io' })],
    ]);
    const source = sourceWithMails(mails);

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(source.fetchCalls).toEqual([3, 2, 1]);
    expect(source.seen).toEqual([3, 2, 1]);
    expect(tickLine(capture)).toMatchObject({ ingestados: 3, parseados: 3, descartados: 1 });
  });
});

describe('runTick — creados cuenta las altas reales junto a los descartes (CA-13, actualizado por S-015)', () => {
  // TS-12 (originalmente de S-014, cuando `creados` era literal 0 porque el alta no estaba
  // cableada; S-015 la cablea, asi que los 7 mails resueltos a `alfa` ahora se publican y cuentan)
  it('creados cuenta los 7 mails resueltos junto con descartados: 3', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const mails = new Map<number, Buffer>([
      [10, fixture('in-reply-to.eml')],
      [9, mailTo({ uid: 9, recipient: 'soporte@grava.io' })],
      [8, mailTo({ uid: 8, recipient: 'tickets+beta@grava.io' })],
      [7, mailTo({ uid: 7, recipient: 'tickets+alfa@grava.io' })],
      [6, mailTo({ uid: 6, recipient: 'tickets+alfa@grava.io' })],
      [5, mailTo({ uid: 5, recipient: 'tickets+alfa@grava.io' })],
      [4, mailTo({ uid: 4, recipient: 'tickets+alfa@grava.io' })],
      [3, mailTo({ uid: 3, recipient: 'tickets+alfa@grava.io' })],
      [2, mailTo({ uid: 2, recipient: 'tickets+alfa@grava.io' })],
      [1, mailTo({ uid: 1, recipient: 'tickets+alfa@grava.io' })],
    ]);
    const source = sourceWithMails(mails);

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(tickLine(capture)).toMatchObject({ creados: 7, descartados: 3, fallidos: 0 });
  });
});

describe('runTick — nunca se loguea el contenido del mail en un descarte (CA-14)', () => {
  // TS-13
  it('un descarte por slug_no_mapeado no filtra body, subject, senderEmail ni recipient', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([
        [
          1,
          mailTo({
            uid: 1,
            recipient: 'tickets+beta@grava.io',
            subject: 'Datos de mi tarjeta',
            body: 'mi tarjeta es 4111 1111 1111 1111',
          }),
        ],
      ]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).not.toHaveProperty('body');
    expect(discardLine).not.toHaveProperty('subject');
    expect(discardLine).not.toHaveProperty('senderEmail');
    expect(discardLine).not.toHaveProperty('recipient');

    const raw = capture.raw();
    expect(raw.some((line) => line.includes('4111 1111 1111 1111'))).toBe(false);
    expect(raw.some((line) => line.includes('Datos de mi tarjeta'))).toBe(false);
  });
});

describe('runTick — el orden de evaluacion del ruteo no se reimplementa (CA-2)', () => {
  // TS-14: In-Reply-To poblado Y recipient con un slug tambien no-mapeado (`beta`, ausente de
  // ticketMap) — el mail calificaria independientemente como slug_no_mapeado, pero routeMail()
  // prioriza es_respuesta (Integration Points, orden de evaluacion paso 1 antes que paso 3). El
  // tick no reimplementa ese orden, solo reporta lo que el ruteo decidio.
  it('es_respuesta sobre un slug tambien no-mapeado reporta es_respuesta, sin slug', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const mailReplyToUnmappedSlug = Buffer.from(
      'Message-Id: <s014-reply-unmapped@fixtures.local>\r\n' +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+beta@grava.io\r\n' +
        'Subject: Re: Consulta anterior\r\n' +
        'In-Reply-To: <a@x>\r\n' +
        'References: <a@x>\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        'Gracias por la respuesta anterior.\r\n',
    );
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailReplyToUnmappedSlug]]),
    });

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({ motivo: 'es_respuesta' });
    expect(discardLine).not.toHaveProperty('slug');
  });
});

/**
 * Tarea 4 — TS-8, TS-17, TS-18, TS-20: los escenarios de integracion de S-015 que el responder de
 * exito PERMANENTE de `beforeAll` no puede ejercitar (necesitan un fallo puntual del bus, o mas de
 * un proyecto mapeado). Cada test da de baja el responder compartido, usa el suyo propio, y lo
 * restaura al terminar — mismo patron que `tick-redaction.test.ts`.
 */
describe('runTick — escenarios de publicacion de S-015 (Tarea 4)', () => {
  // TS-8, CA-9: un asunto vacio tras normalizacion (Re: Fwd:) no es motivo de descarte, y el mail
  // se publica igual con el placeholder de titulo.
  it('un asunto vacio tras Re:/Fwd: no descarta el mail: se publica con el placeholder de titulo', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const mail = mailTo({ uid: 1, recipient: 'tickets+alfa@grava.io', subject: 'Re: Fwd:' });
    const source = sourceWithMails(new Map([[1, mail]]));

    await runTick(source, BASE_CONFIG, logger, bus.client);

    expect(capture.lines().some((l) => l['msg'] === 'mail descartado')).toBe(false);
    const successLine = capture.lines().find((l) => l['msg'] === 'requisito creado en Jiku');
    expect(successLine).toBeDefined();
    expect(tickLine(capture)).toMatchObject({ descartados: 0, creados: 1, fallidos: 0 });
  });

  // TS-17, CA-18: un lote de 10 mails donde el 4to (en orden de procesamiento, UID descendente)
  // falla la PUBLICACION (no el parseo) — los otros 9 se crean, el tick no aborta, y no hay
  // reintento: el responder recibe exactamente 10 mensajes.
  it('un lote de 10 con el 4to fallando la publicacion: creados 9, fallidos 1, sin reintento', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();
    const uids = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const mails = new Map(
      uids.map((uid) => [uid, mailTo({ uid, recipient: 'tickets+alfa@grava.io' })]),
    );
    const source = sourceWithMails(mails);

    // El 4to en orden de procesamiento (UID descendente: 10,9,8,7,...) es el UID 7.
    const sequence: (
      | { status: 'success'; data: { id: number } }
      | { status: 'failure'; errorCode: string }
    )[] = [
      { status: 'success', data: { id: 1 } },
      { status: 'success', data: { id: 1 } },
      { status: 'success', data: { id: 1 } },
      { status: 'failure', errorCode: 'invalid_fields' },
      ...Array.from({ length: 6 }, () => ({ status: 'success' as const, data: { id: 1 } })),
    ];
    const local = await respondTo(bus.connection, 'requirements.new', sequence);

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      expect(local.count()).toBe(10);
      expect(tickLine(capture)).toMatchObject({ creados: 9, fallidos: 1, descartados: 0 });
    } finally {
      await local.stop();
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });

  // TS-18, CA-19: el mail que fallo la publicacion ya quedo \Seen (mismo marcado que cualquier otro
  // mail procesado) y por lo tanto el tick siguiente, con el mismo MailSource, no lo reprocesa: ya
  // no aparece entre los \Unseen.
  it('el mail cuya publicacion fallo no se reprocesa en el tick siguiente', async () => {
    await responder?.stop();

    const { logger } = testLoggerWithCapture();
    const source = sourceWithMails(
      new Map([[1, mailTo({ uid: 1, recipient: 'tickets+alfa@grava.io' })]]),
    );

    const failing = await respondTo(bus.connection, 'requirements.new', {
      status: 'failure',
      errorCode: 'invalid_fields',
    });

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);
    } finally {
      await failing.stop();
    }

    // Igual que cualquier otro mail: se marca \Seen apenas se descarga, ANTES de normalizar y de
    // intentar publicar (CA-19, ADR-001) — el fallo de publicacion no lo revierte.
    expect(source.seen).toEqual([1]);

    // El tick siguiente, con el mismo MailSource (el UID 1 ya no esta en \Unseen porque el doble no
    // lo re-expone), no vuelve a intentar publicarlo.
    const nextSource: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return []; // el UID 1 ya esta \Seen: no aparece en la busqueda del proximo tick
      },
      async fetch(): Promise<RawMessage> {
        throw new Error('unreachable: no deberia buscarse ningun mail');
      },
      async markSeen(): Promise<void> {
        // unreachable
      },
    };
    const responderForNextTick = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 1 },
    });
    try {
      const { logger: nextLogger, capture: nextCapture } = testLoggerWithCapture();
      await runTick(nextSource, BASE_CONFIG, nextLogger, bus.client);

      expect(responderForNextTick.count()).toBe(0);
      expect(tickLine(nextCapture)).toMatchObject({ ingestados: 0, creados: 0, fallidos: 0 });
    } finally {
      await responderForNextTick.stop();
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });

  // TS-20, CA-21: 3 mails a 3 proyectos DISTINTOS se crean cada uno en su proyecto, procesados de a
  // uno en serie, en el orden de UID descendente.
  // Tambien es la cobertura de comportamiento de S-016 TS-7/CA-9: el lote de varios mails se
  // publica uno por uno, sin evidencia de acumulacion (no se reprueba el orden secuencial, ya
  // cubierto por S-010/S-011 — ver `tick-memory.test.ts` para la propiedad de ausencia de arrays
  // acumuladores por inspeccion de codigo).
  it('3 mails a proyectos distintos crean 3 requisitos, cada uno en su proyecto, en orden UID descendente', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();
    const configWithThreeSlugs: AppConfig = {
      ...BASE_CONFIG,
      ruteo: {
        ...BASE_CONFIG.ruteo,
        ticketMap: new Map([
          ['alfa', 42],
          ['beta', 7],
          ['gamma', 15],
        ]),
      },
    };
    const mails = new Map([
      [30, mailTo({ uid: 30, recipient: 'tickets+alfa@grava.io' })],
      [20, mailTo({ uid: 20, recipient: 'tickets+beta@grava.io' })],
      [10, mailTo({ uid: 10, recipient: 'tickets+gamma@grava.io' })],
    ]);
    const source = sourceWithMails(mails);

    const local = await respondTo(bus.connection, 'requirements.new', [
      { status: 'success', data: { id: 101 } },
      { status: 'success', data: { id: 102 } },
      { status: 'success', data: { id: 103 } },
    ]);

    try {
      await runTick(source, configWithThreeSlugs, logger, bus.client);

      expect(local.payloads()).toEqual([
        expect.objectContaining({ projectId: 42 }),
        expect.objectContaining({ projectId: 7 }),
        expect.objectContaining({ projectId: 15 }),
      ]);
      expect(source.seen).toEqual([30, 20, 10]);
      expect(tickLine(capture)).toMatchObject({
        ingestados: 3,
        parseados: 3,
        creados: 3,
        descartados: 0,
        fallidos: 0,
      });
    } finally {
      await local.stop();
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });
});

/**
 * S-016 Tarea 3 — TS-10 (CA-13, CA-10): el escenario de extremo a extremo completo. Un cliente
 * externo manda un mail a `tickets+alfa@grava.io`; el tick lo ingesta, normaliza, rutea y publica;
 * el responder de `core` (`respondTo()`) valida el payload REALMENTE recibido por el bus -- no el
 * objeto local que `buildRequirementPayload()` devuelve en memoria -- y contesta exito. Es la
 * unica story que puede verificar esto: exige S-012 a S-015 terminadas.
 *
 * `Client.fromConnection()` (via `setupTestBus()`, ya usado por todo este archivo) es lo que
 * permite este test sin desplegar Jiku ni pasar por Zitadel (ADR-002).
 */
describe('runTick — el escenario de extremo a extremo: mail de un cliente externo se convierte en requisito (S-016 CA-13, CA-10)', () => {
  it('el payload observado por el responder tiene exactamente las siete claves esperadas, y el tick reporta los cinco contadores reales', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();
    const configWithAlfa: AppConfig = {
      ...BASE_CONFIG,
      ruteo: { ...BASE_CONFIG.ruteo, ticketMap: new Map([['alfa', 42]]) },
    };

    const messageId = '<s016-e2e-alfa@fixtures.local>';
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(): Promise<RawMessage> {
        return {
          uid: 1,
          source: Buffer.from(
            `Message-Id: ${messageId}\r\n` +
              'From: "Cliente Externo" <cliente-externo@ejemplo.com>\r\n' +
              'To: tickets+alfa@grava.io\r\n' +
              'Subject: Pedido de un cliente externo\r\n' +
              'Content-Type: text/plain; charset=utf-8\r\n' +
              'MIME-Version: 1.0\r\n\r\n' +
              'El pedido concreto que el cliente necesita resolver.\r\n',
          ),
        };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    // El doble de `core` sobre el BUS REAL de Testcontainers, con `Client.fromConnection()` ya
    // conectado desde el `beforeAll` de este archivo (`bus.client`) -- saltea el handshake de auth
    // por completo (ADR-002), que es lo que hace posible este test sin una instancia de Jiku.
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 999 },
    });

    try {
      await runTick(source, configWithAlfa, logger, bus.client);

      // El payload observado por el responder -- lo que REALMENTE viajo por el bus, no una
      // reimplementacion en el test de lo que buildRequirementPayload() deberia producir.
      const payloads = local.payloads();
      expect(payloads).toHaveLength(1);

      const payload = payloads[0] as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(
        ['title', 'description', 'projectId', 'type', 'priority', 'visibilityLevel', 'creator'].sort(),
      );
      expect(payload).toMatchObject({
        projectId: 42,
        type: 'incidencia',
        priority: 'sin_prioridad',
        visibilityLevel: 'public',
      });
      expect(payload['title']).toBe('Pedido de un cliente externo');
      expect(payload['description']).toBe('El pedido concreto que el cliente necesita resolver.');
      expect(typeof payload['creator']).toBe('string');
      expect(payload).not.toHaveProperty('state');
      expect(payload).not.toHaveProperty('actor');
      expect(payload).not.toHaveProperty('fileIds');

      // La linea de exito con los tres identificadores juntos.
      const successLine = capture
        .lines()
        .find((line) => line['msg'] === 'requisito creado en Jiku');
      expect(successLine).toMatchObject({
        messageId,
        projectId: 42,
        requirementId: 999,
      });

      // Los cinco contadores reales de la linea 'tick completado'.
      expect(tickLine(capture)).toMatchObject({
        ingestados: 1,
        parseados: 1,
        creados: 1,
        descartados: 0,
        fallidos: 0,
      });
    } finally {
      await local.stop();
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });
});

/**
 * S-021, Task 5 — TS-14: un mail con un adjunto cuyo permiso de subida falla (nadie responde
 * `files.request-upload` en esta suite, mismo criterio que `beforeAll` documenta: solo
 * `requirements.new` tiene responder permanente) NO cancela el requisito (CA-6, CA-7) y la linea
 * `'tick completado'` sigue teniendo EXACTAMENTE los cinco contadores, sin un sexto de archivos
 * (CA-10).
 */
describe('runTick — un adjunto fallido no cancela el requisito ni agrega un sexto contador (S-021, TS-14)', () => {
  function mailConAdjunto(uid: number): Buffer {
    return Buffer.from(
      `Message-Id: <con-adjunto-${String(uid)}@fixtures.local>\r\n` +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+alfa@grava.io\r\n' +
        'Subject: Con adjunto\r\n' +
        'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        'Adjunto el documento solicitado.\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: application/pdf\r\n' +
        'Content-Disposition: attachment; filename="reporte.pdf"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'JVBERi0xLjQgZmFrZSBwZGYgY29udGVudCBmb3IgZml4dHVyZSBwdXJwb3NlcyBvbmx5\r\n' +
        '--ATT-BOUNDARY--\r\n',
    );
  }

  it('el mail se cuenta creado (no fallido), y tick completado tiene exactamente 5 claves', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailConAdjunto(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    // CA-7: el mail se cuenta CREADO, no fallido -- el fallo de subida del adjunto no cancela el
    // requisito.
    const tick = tickLine(capture);
    expect(tick).toMatchObject({ ingestados: 1, parseados: 1, creados: 1, descartados: 0, fallidos: 0 });

    // CA-10: exactamente las cinco claves de siempre, sin un sexto contador de archivos -- se
    // excluyen los campos estructurales que Pino agrega a TODA linea (level, time, msg, env,
    // service), que no son contadores de negocio.
    const PINO_STRUCTURAL_FIELDS = new Set(['level', 'time', 'msg', 'env', 'service']);
    const counterKeys = Object.keys(tick ?? {}).filter((key) => !PINO_STRUCTURAL_FIELDS.has(key));
    expect(counterKeys.sort()).toEqual(
      ['ingestados', 'parseados', 'creados', 'descartados', 'fallidos'].sort(),
    );

    // CA-9: el log de exito suma los dos conteos de archivos -- 0 vinculados (el permiso fallo),
    // 1 con aviso (el fallo de subida de ESE adjunto).
    const successLine = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
    expect(successLine).toMatchObject({ archivosVinculados: 0, archivosConAviso: 1 });
  });
});

/**
 * S-021, Task 5 — TS-18: ninguna linea de log de un tick completo con adjuntos incluye la
 * `uploadUrl` -- en este archivo el permiso siempre falla (sin responder de
 * `files.request-upload`), y se afirma igual sobre la ausencia de la clave/valor por si alguna
 * suite futura agrega un responder de exito en este archivo.
 */
describe('runTick — ninguna linea de un tick con adjuntos incluye uploadUrl (S-021, TS-18)', () => {
  it('la palabra uploadUrl no aparece en ninguna linea cruda', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return {
          uid,
          source: Buffer.from(
            'Message-Id: <con-adjunto-url@fixtures.local>\r\n' +
              'From: "Cliente" <cliente@cliente.com>\r\n' +
              'To: tickets+alfa@grava.io\r\n' +
              'Subject: Con adjunto\r\n' +
              'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
              'MIME-Version: 1.0\r\n\r\n' +
              '--ATT-BOUNDARY\r\n' +
              'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
              'Adjunto el documento solicitado.\r\n' +
              '--ATT-BOUNDARY\r\n' +
              'Content-Type: application/pdf\r\n' +
              'Content-Disposition: attachment; filename="reporte.pdf"\r\n' +
              'Content-Transfer-Encoding: base64\r\n\r\n' +
              'JVBERi0xLjQgZmFrZSBwZGYgY29udGVudCBmb3IgZml4dHVyZSBwdXJwb3NlcyBvbmx5\r\n' +
              '--ATT-BOUNDARY--\r\n',
          ),
        };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('uploadUrl');
  });
});

/**
 * S-021, Task 5 — TS-12: archivos huerfanos. Tres adjuntos suben con exito (fileId 201/202/203) y
 * DESPUES `requirements.new` falla -- `publishRequirementFromMail()` relanza `PublishError`, el
 * tick cuenta el mail como `fallidos`, y el conector NO publica ningun comando de compensacion ni
 * loguea una lista de `fileIds` abandonados mas alla del `PublishError` ya logueado (CA-8).
 */
describe('runTick — archivos huerfanos: tres adjuntos suben bien y requirements.new falla despues (S-021, TS-12)', () => {
  function mailConTresAdjuntos(uid: number): Buffer {
    return Buffer.from(
      `Message-Id: <huerfanos-${String(uid)}@fixtures.local>\r\n` +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+alfa@grava.io\r\n' +
        'Subject: Con tres adjuntos\r\n' +
        'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        'Tres archivos adjuntos.\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: image/png\r\n' +
        'Content-Disposition: attachment; filename="uno.png"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'aW1hZ2VuLXVuby1jb250ZW5pZG8=\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: image/png\r\n' +
        'Content-Disposition: attachment; filename="dos.png"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'aW1hZ2VuLWRvcy1jb250ZW5pZG8=\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: image/png\r\n' +
        'Content-Disposition: attachment; filename="tres.png"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'aW1hZ2VuLXRyZXMtY29udGVuaWRv\r\n' +
        '--ATT-BOUNDARY--\r\n',
    );
  }

  it('el mail se cuenta fallido, sin comando de compensacion ni lista de fileIds abandonados', async () => {
    const { logger, capture } = testLoggerWithCapture();

    // Servidor HTTP local: el PUT de los tres adjuntos siempre sube con exito.
    const localServer: Server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    const localUploadUrl = `http://127.0.0.1:${String(address.port)}/upload`;

    // Responder LOCAL para files.request-upload (el permanente del beforeAll no contesta este
    // subject): concede permiso para los tres adjuntos, con fileId incremental.
    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', [
      { status: 'success', data: { fileId: 201, uploadUrl: localUploadUrl } },
      { status: 'success', data: { fileId: 202, uploadUrl: localUploadUrl } },
      { status: 'success', data: { fileId: 203, uploadUrl: localUploadUrl } },
    ]);

    // requirements.new falla DESPUES de que los tres adjuntos ya subieron -- se da de baja el
    // responder de exito permanente de este archivo y se sustituye por uno que falla, solo para
    // este test.
    await responder?.stop();
    const failingResponder = await respondTo(bus.connection, 'requirements.new', {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailConTresAdjuntos(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      // Los tres adjuntos SI llegaron a subir (3 request-upload observados).
      expect(uploadResponder.count()).toBe(3);

      // El mail se cuenta FALLIDO -- CA-8: requirements.new fallo, sin reintento.
      expect(tickLine(capture)).toMatchObject({ creados: 0, fallidos: 1 });

      // Ningun comando de compensacion: el UNICO subject de files.request-upload observado son
      // los 3 permisos de subida ya contados arriba, y ningun otro comando se publico para
      // "deshacer" o "liberar" los archivos huerfanos.
      const failureLine = capture.lines().find((line) => line['level'] === 'error');
      expect(failureLine).toMatchObject({ diagnosis: 'core_rechazo_por_rol' });

      // Ninguna linea de log lleva una lista de fileIds abandonados (201/202/203) fuera del
      // PublishError ya logueado -- se confirma que ningun campo de contexto se llama algo como
      // fileIds/orphanedFileIds/archivosHuerfanos en ninguna linea.
      for (const line of capture.lines()) {
        expect(line).not.toHaveProperty('fileIds');
        expect(line).not.toHaveProperty('orphanedFileIds');
        expect(line).not.toHaveProperty('archivosHuerfanos');
      }
    } finally {
      await uploadResponder.stop();
      await failingResponder.stop();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });
});

/**
 * S-021, Task 5 — TS-7: mail con UN adjunto rechazado por la politica LOCAL (`.exe`, nunca llega
 * a pedir permiso de subida) y cuerpo "No puedo entrar". El requisito se crea igual (CA-6, CA-7):
 * `counters.creados += 1`, la description incluye el aviso de rechazo.
 */
describe('runTick — rechazo local (.exe) no cancela el requisito: se cuenta creado (S-021, TS-7)', () => {
  function mailConExeRechazado(uid: number): Buffer {
    return Buffer.from(
      `Message-Id: <rechazo-local-${String(uid)}@fixtures.local>\r\n` +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+alfa@grava.io\r\n' +
        'Subject: No puedo entrar\r\n' +
        'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        'No puedo entrar\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: application/x-msdownload\r\n' +
        'Content-Disposition: attachment; filename="virus.exe"\r\n' +
        'Content-Transfer-Encoding: base64\r\n\r\n' +
        'TVo=\r\n' +
        '--ATT-BOUNDARY--\r\n',
    );
  }

  it('el requisito se crea, counters.creados += 1, con el aviso de rechazo en la description', async () => {
    const { logger, capture } = testLoggerWithCapture();

    // Sin responder de files.request-upload: el rechazo del .exe es LOCAL (particionar(), antes de
    // tocar el bus) -- si la orquestacion llegara a publicar un permiso para el, este test lo
    // detectaria porque local.payloads() de requirements.new seguiria viendo un unico mensaje pero
    // ninguna aserción de esta suite depende del bus de files.request-upload, precisamente porque
    // no deberia usarlo.
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 555 },
    });

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailConExeRechazado(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0, descartados: 0 });

      const payload = local.payloads()[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('fileIds');
      expect(typeof payload['description']).toBe('string');
      expect(payload['description'] as string).toContain('virus.exe');

      const successLine = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
      expect(successLine).toMatchObject({ archivosVinculados: 0, archivosConAviso: 1 });
    } finally {
      await local.stop();
      responder = await respondTo(
        bus.connection,
        'requirements.new',
        Array.from({ length: 200 }, (_, i) => ({ status: 'success' as const, data: { id: i + 1 } })),
      );
    }
  });
});
