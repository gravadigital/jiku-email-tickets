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

    await runTick(source, configWithMax(50), logger);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({
      motivo: 'slug_no_mapeado',
      slug: 'beta',
      messageId: '<s014-1@fixtures.local>',
    });
    expect(tickLine(capture)).toMatchObject({ descartados: 1, fallidos: 0 });
  });

  // TS-4
  it('el slug se loguea literal en la salida cruda, no [REDACTED] (CA-5)', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source = fakeMailSource({
      uidsUnseen: [1],
      sources: new Map([[1, mailTo({ uid: 1, recipient: 'tickets+beta@grava.io' })]]),
    });

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger, impostorNormalize);

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

    await runTick(source, BASE_CONFIG, logger, brokenNormalize);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

    expect(source.fetchCalls).toEqual([3, 2, 1]);
    expect(source.seen).toEqual([3, 2, 1]);
    expect(tickLine(capture)).toMatchObject({ ingestados: 3, parseados: 3, descartados: 1 });
  });
});

describe('runTick — creados sigue en 0 aunque haya descartes reales (CA-13)', () => {
  // TS-12
  it('creados permanece en 0 explicito junto con descartados: 3', async () => {
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

    await runTick(source, BASE_CONFIG, logger);

    expect(tickLine(capture)).toMatchObject({ creados: 0, descartados: 3 });
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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

    const discardLine = capture.lines().find((l) => l['msg'] === 'mail descartado');
    expect(discardLine).toMatchObject({ motivo: 'es_respuesta' });
    expect(discardLine).not.toHaveProperty('slug');
  });
});
