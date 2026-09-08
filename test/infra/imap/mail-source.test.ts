import { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource } from '#domain/ingesta/ports.js';
import { withMailSource, type ImapFlowCtor, type ImapFlowLike } from '#infra/imap/client.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture } from '../../shared/log-capture.js';

/**
 * TS-13 a TS-16: `fetch(uid)` y `markSeen(uid)` del `MailSource` ensamblado.
 */

function configWith(): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: 'test',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: 'proj-uuid',
    issuer: 'https://unreachable-issuer.invalid',
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'silent',
    nodeEnv: 'test',
    imap: { host: 'imap.test', port: 993, user: 'u', password: 'p' },
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

function silentLogger(): Logger {
  return createLogger(configWith(), createLogCapture().stream);
}

interface FakeClientOptions {
  readonly downloadContent?: Buffer;
  readonly downloadError?: unknown;
}

/** Ver el comentario homologo en `test/infra/imap/client.test.ts` sobre por que no extiende `ImapFlowLike`. */
interface FakeClient {
  readonly release: ReturnType<typeof vi.fn>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly getMailboxLock: ReturnType<typeof vi.fn>;
  readonly search: ReturnType<typeof vi.fn>;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly messageFlagsAdd: ReturnType<typeof vi.fn>;
  readonly download: ReturnType<typeof vi.fn>;
}

function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const release = vi.fn();
  const logout = vi.fn(async () => undefined);
  const connect = vi.fn(async () => undefined);
  const getMailboxLock = vi.fn(async () => ({ path: 'INBOX', release }));
  const search = vi.fn(async () => []);
  const messageFlagsAdd = vi.fn(async () => true);
  const download = vi.fn(async () => {
    if (options.downloadError !== undefined) throw options.downloadError;
    return {
      meta: { expectedSize: 0, contentType: 'message/rfc822' },
      content: Readable.from([options.downloadContent ?? Buffer.from('')]),
    };
  });

  return { connect, logout, getMailboxLock, search, messageFlagsAdd, download, release };
}

function ctorFor(client: FakeClient): ImapFlowCtor {
  return () => client as unknown as ImapFlowLike;
}

async function withSource<T>(client: FakeClient, callback: (source: MailSource) => Promise<T>): Promise<T> {
  return withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctorFor(client) }, callback);
}

describe('MailSource assembled — fetch and markSeen', () => {
  // TS-13
  it('fetch(uid) returns a RawMessage with the exact bytes the double delivered', async () => {
    const expectedBytes = Buffer.from('From: a@b.com\r\nSubject: test\r\n\r\nBody', 'utf8');
    const client = createFakeClient({ downloadContent: expectedBytes });

    const message = await withSource(client, (source) => source.fetch(42));

    expect(message.uid).toBe(42);
    expect(Buffer.isBuffer(message.source)).toBe(true);
    expect(message.source.equals(expectedBytes)).toBe(true);
  });

  // TS-14
  it('fetch(uid) throws if the download fails', async () => {
    const client = createFakeClient({ downloadError: new Error('download failed') });

    await expect(withSource(client, (source) => source.fetch(99))).rejects.toThrow('download failed');
  });

  // TS-15
  it('markSeen(uid) invokes messageFlagsAdd with a single UID', async () => {
    const client = createFakeClient();

    await withSource(client, async (source) => {
      await source.markSeen(7);
    });

    expect(client.messageFlagsAdd).toHaveBeenCalledWith(7, ['\\Seen'], { uid: true });
  });

  // TS-16
  it('offers no batch-marking operation: MailSource has no method taking uid[]', async () => {
    const client = createFakeClient();

    await withSource(client, async (source) => {
      const methodNames = Object.keys(source as unknown as Record<string, unknown>);
      expect(methodNames.sort()).toEqual(['fetch', 'markSeen', 'searchUnseen']);
    });
  });
});
