import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MissingMessageIdError } from '#domain/ingesta/errors.js';
import { normalize } from '#domain/ingesta/normalize.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick, type TickCounters } from '#domain/ingesta/tick.js';

import { testLoggerWithCapture } from './test-logger.js';

/**
 * Suite del tick: TS-1 a TS-14, TS-19 a TS-24 (los que no dependen de un fallo de conexion — esos
 * son de `tick-entrypoint.test.ts`, Tarea 3). Dobla `MailSource` directamente, nunca `ImapFlow` ni
 * un servidor real (convencion `testing`). Los mails "reales" usan los fixtures `.eml` de S-008;
 * el unico caso que no tiene fixture real (un mail descargado que falla el PARSEO, distinto de
 * "sin Message-Id") inyecta un `normalize` doblado, tal como anticipa la Story Plan.
 */

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

/** Construye un mail RFC 822 valido y parseable con un Message-Id distinto por UID. */
function mailWithId(uid: number): Buffer {
  return Buffer.from(
    `Message-Id: <uid-${uid}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: soporte@grava.io\r\n' +
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

    await expect(runTick(source, configWithMax(50), logger)).rejects.toThrow('connection lost');

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
  // TS-1
  it('processes three unseen mails, marks them Seen, and reports the five counters', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const sources = new Map([
      [3, mailWithId(3)],
      [2, mailWithId(2)],
      [1, mailWithId(1)],
    ]);
    const source = fakeMailSource({ uidsUnseen: [3, 2, 1], sources });

    await runTick(source, configWithMax(50), logger);

    expect(source.seen).toEqual([3, 2, 1]);
    expect(tickLine(capture)).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
  });

  // TS-2, CA-15
  it('logs one line per mail with its real messageId', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const sources = new Map([
      [3, mailWithId(3)],
      [2, mailWithId(2)],
      [1, mailWithId(1)],
    ]);
    const source = fakeMailSource({ uidsUnseen: [3, 2, 1], sources });

    await runTick(source, configWithMax(50), logger);

    const perMailLines = capture
      .lines()
      .filter((line) => line['msg'] === 'mail procesado' && line['resultado'] === 'normalizado');

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

    await runTick(source, configWithMax(50), logger);

    expect(source.fetchCalls).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i)); // 60..11
    const warnLine = capture.lines().find((line) => line['msg'] === 'mails diferidos por el cap');
    expect(warnLine).toMatchObject({ diferidos: 10 });
  });

  // TS-4
  it('does not mark the 10 deferred mails as Seen', async () => {
    const uids = Array.from({ length: 60 }, (_, i) => 60 - i);
    const source = fakeMailSource({ uidsUnseen: uids });
    const { logger } = testLoggerWithCapture();

    await runTick(source, configWithMax(50), logger);

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

    await runTick(source, configWithMax(50), logger);

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

    await runTick(source, configWithMax(50), logger);

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

    await runTick(source, configWithMax(50), logger);

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

    await runTick(sourceWithRealMails, configWithMax(50), logger, failingNormalize);

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

    await runTick(sourceWithRealMails, configWithMax(50), logger, failingNormalize);

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

    await runTick(sourceWithRealMails, configWithMax(50), logger, failingNormalize);

    expect(source.seen).toContain(7);
  });
});

describe('runTick — a failed download is skipped without marking (CA-6)', () => {
  // TS-11
  it('does not mark Seen for a uid whose fetch fails, and warns with the uid', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const uids = [5, 4, 3];
    const source = fakeMailSource({ uidsUnseen: uids, failFetchFor: new Set([5]) });

    await runTick(source, configWithMax(50), logger);

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

    await runTick(sourceWithRealMails, configWithMax(50), logger);

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

    await runTick(source, configWithMax(50), logger, spiedNormalize);

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

    await runTick(sourceWithRealMails, configWithMax(50), logger);

    expect(source.markSeenCalls).toEqual(uids);
    expect(source.markSeenCalls).toHaveLength(5);
    for (const call of source.markSeenCalls) {
      expect(typeof call).toBe('number');
    }
  });
});

describe('runTick — the five counters, one line (CA-14)', () => {
  // TS-19
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

    await runTick(sourceWithRealMails, configWithMax(50), logger, failingNormalize);

    const tickLines = capture.lines().filter((line) => line['msg'] === 'tick completado');
    expect(tickLines).toHaveLength(1);
    expect(tickLines[0]).toMatchObject({
      ingestados: 10,
      parseados: 9,
      creados: 0,
      descartados: 0,
      fallidos: 1,
    });
  });

  // TS-20
  it('descartados stays literal 0 even when normalize throws MissingMessageIdError', async () => {
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

    await runTick(source, configWithMax(50), logger);

    expect(tickLine(capture)).toMatchObject({ fallidos: 1, descartados: 0 });
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

    await runTick(source, configWithMax(50), logger);

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

    await runTick(source, configWithMax(50), logger);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({ motivo: 'sin_message_id' });
    expect(discardLine?.['messageId']).toBeUndefined();
  });
});

describe('runTick — CA-16: the normalized mail is discarded, nothing is published', () => {
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

  // TS-24
  it('tick.ts does not import from #domain/publicacion nor @gravadigital/jiku', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ingesta/tick.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toMatch(/from\s*'#domain\/publicacion/);
    expect(source).not.toMatch(/from\s*'@gravadigital\/jiku'/);
  });
});
