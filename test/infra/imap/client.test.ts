import type { Logger } from 'pino';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { INBOX, withMailSource, type ImapFlowCtor, type ImapFlowLike } from '#infra/imap/client.js';
import { ImapConnectError } from '#infra/imap/errors.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture } from '../../shared/log-capture.js';

/**
 * TS-3 a TS-12, TS-17 a TS-19, TS-22, TS-23: el ciclo de apertura, lock de INBOX,
 * `searchUnseen()` y cierre, con un doble de `ImapFlow` inyectado por fabrica (nunca mockeando el
 * modulo `imapflow` globalmente — mismo patron que `createLogger(config, destination,
 * transportTarget)`).
 *
 * `withMailSource()` abre UNA conexion, construye el `MailSource` ligado a ella, invoca el
 * callback del llamador (el tick, en produccion), y cierra en el `finally` — asi
 * `lock.release()`/`client.logout()` corren exactamente una vez por CICLO, no una vez por
 * operacion (TS-22, TS-23; ver Tarea 3/4 de la Story Plan: "dentro del MISMO try/finally").
 */

function configWith(overrides: Partial<AppConfig['imap']> = {}): AppConfig {
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
    imap: {
      host: 'imap.test',
      port: 993,
      user: 'u',
      password: 'p',
      ...overrides,
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

function silentLogger(): Logger {
  return createLogger(configWith(), createLogCapture().stream);
}

interface FakeClientOptions {
  readonly searchResult?: number[];
  readonly connectError?: unknown;
  readonly searchError?: unknown;
}

/**
 * El doble de `ImapFlowLike`, con cada metodo espiado por `vi.fn()`.
 *
 * No extiende `ImapFlowLike` directamente: el tipo de retorno de `vi.fn()` no es asignable a las
 * firmas de metodo exactas de la interfaz (TypeScript no unifica `Mock<...>` con una firma de
 * funcion concreta). Se declara la forma propia y se afirma que CUMPLE `ImapFlowLike` al pasarla a
 * `ctorFor`, que es donde importa que lo haga.
 */
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
  const connect = vi.fn(async () => {
    if (options.connectError !== undefined) throw options.connectError;
  });
  const getMailboxLock = vi.fn(async () => ({ path: 'INBOX', release }));
  const search = vi.fn(async () => {
    if (options.searchError !== undefined) throw options.searchError;
    return options.searchResult ?? [];
  });
  const messageFlagsAdd = vi.fn(async () => true);
  const download = vi.fn(async () => ({
    meta: { expectedSize: 0, contentType: 'message/rfc822' },
    content: Readable.from([Buffer.from('')]),
  }));

  return { connect, logout, getMailboxLock, search, messageFlagsAdd, download, release };
}

function ctorFor(client: FakeClient): {
  ctor: ImapFlowCtor;
  captured: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const ctor: ImapFlowCtor = (options) => {
    captured = options;
    return client as unknown as ImapFlowLike;
  };
  return { ctor, captured: () => captured };
}

describe('withMailSource — connection, lock, searchUnseen', () => {
  // TS-3
  it('constructs ImapFlow with secure: true unconditionally', async () => {
    const client = createFakeClient({ searchResult: [] });
    const { ctor, captured } = ctorFor(client);

    await withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
      source.searchUnseen(),
    );

    expect(captured()).toMatchObject({
      host: 'imap.test',
      port: 993,
      secure: true,
      auth: { user: 'u', pass: 'p' },
      logger: false,
    });
  });

  // TS-5
  it('constructs ImapFlow with logger: false unconditionally', async () => {
    const client = createFakeClient({ searchResult: [] });
    const { ctor, captured } = ctorFor(client);

    await withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
      source.searchUnseen(),
    );

    expect(captured()?.logger).toBe(false);
  });

  // TS-7
  it('opens the mailbox taking the lock of INBOX with the exact literal', async () => {
    const client = createFakeClient({ searchResult: [] });
    const { ctor } = ctorFor(client);

    await withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
      source.searchUnseen(),
    );

    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(INBOX).toBe('INBOX');
  });

  // TS-9
  it('searchUnseen invokes client.search with the exact seen: false criterion', async () => {
    const client = createFakeClient({ searchResult: [5, 3, 8, 1] });
    const { ctor } = ctorFor(client);

    await withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
      source.searchUnseen(),
    );

    expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
  });

  // TS-10
  it('searchUnseen returns UIDs sorted descending (newest first)', async () => {
    const client = createFakeClient({ searchResult: [5, 3, 8, 1] });
    const { ctor } = ctorFor(client);

    const uids = await withMailSource(
      { config: configWith(), logger: silentLogger(), imapFlowCtor: ctor },
      (source) => source.searchUnseen(),
    );

    expect(uids).toEqual([8, 5, 3, 1]);
  });

  // TS-11
  it('searchUnseen returns the TOTAL, without truncating to any maximum', async () => {
    const allUids = Array.from({ length: 120 }, (_, index) => index + 1);
    const client = createFakeClient({ searchResult: allUids });
    const { ctor } = ctorFor(client);

    const uids = await withMailSource(
      { config: configWith(), logger: silentLogger(), imapFlowCtor: ctor },
      (source) => source.searchUnseen(),
    );

    expect(uids).toHaveLength(120);
  });

  // TS-17, TS-19
  it('a connect() failure throws an AppError without leaking the secret, and logs nothing with it', async () => {
    class AuthenticationFailure extends Error {}
    const authError = new AuthenticationFailure('LOGIN failed');
    const client = createFakeClient({ connectError: authError });
    const { ctor } = ctorFor(client);
    const capture = createLogCapture();
    const logger = createLogger(configWith(), capture.stream);

    const error = await withMailSource(
      { config: configWith(), logger, imapFlowCtor: ctor },
      (source) => source.searchUnseen(),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImapConnectError);
    const asError = error as ImapConnectError;
    // La password y el usuario de prueba son literales exactos ('p', 'u') deliberadamente cortos
    // para que cualquier aparicion textual sea inequivoca: se busca la SUBCADENA exacta entre
    // comillas, no la letra suelta, que aparece libremente en la prosa del mensaje ("password").
    expect(asError.message).not.toMatch(/['"]p['"]/);
    expect(asError.message).not.toMatch(/['"]u['"]/);
    expect(JSON.stringify(asError.details)).not.toMatch(/['"]p['"]/);

    for (const line of capture.raw()) {
      expect(line).not.toContain('app-password-de-prueba');
      expect(line).not.toMatch(/"pass"\s*:\s*"p"/);
    }
  });

  // TS-18
  it('an unreachable host throws before touching any other method', async () => {
    const networkError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const client = createFakeClient({ connectError: networkError });
    const { ctor } = ctorFor(client);

    await expect(
      withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
        source.searchUnseen(),
      ),
    ).rejects.toBeInstanceOf(ImapConnectError);

    expect(client.getMailboxLock).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  // TS-23
  it('releases the lock and logs out even when the callback rejects', async () => {
    const client = createFakeClient({ searchError: new Error('boom') });
    const { ctor } = ctorFor(client);

    await expect(
      withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, (source) =>
        source.searchUnseen(),
      ),
    ).rejects.toThrow();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  // TS-22
  it('releases the lock and logs out exactly once after a full successful cycle', async () => {
    const client = createFakeClient({ searchResult: [1, 2] });
    const { ctor } = ctorFor(client);

    await withMailSource({ config: configWith(), logger: silentLogger(), imapFlowCtor: ctor }, async (source) => {
      const uids = await source.searchUnseen();
      for (const uid of uids) {
        const message = await source.fetch(uid);
        await source.markSeen(message.uid);
      }
    });

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });
});
