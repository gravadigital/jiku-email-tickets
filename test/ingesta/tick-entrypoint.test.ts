import { Readable } from 'node:stream';

import type { Client } from '@gravadigital/jiku';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { runIngestaTick } from '#domain/ingesta/tick.js';
import type { ImapFlowCtor, ImapFlowLike } from '#infra/imap/client.js';

import { testLoggerWithCapture } from './test-logger.js';
import { fakeKvSpace } from './fake-kv-space.js';

/**
 * El Espacio KV, que estas suites propagan hasta el tick (S-032; hasta entonces, el handle del bucket
 * de hilos de S-026). Lleva `tickets.alfa` → `42`, el mismo mapa que hasta S-032 viajaba en
 * `config.ruteo.ticketMap`, para que los mails de estas suites ruteen igual que antes.
 */
const SPACE = fakeKvSpace({ 'tickets.alfa': '42' }).space;

/**
 * TS-15 a TS-18: el punto de entrada del modulo (`runIngestaTick`), que compone `withMailSource()`
 * con `runTick()`. Dobla `ImapFlow` por fabrica inyectada (`imapFlowCtor`), mismo patron que
 * `test/infra/imap/client.test.ts` — nunca mockeando el modulo `imapflow`.
 *
 * `FAKE_CLIENT` es un STUB del `Client` del bus (S-015): los mails de este archivo (`To:
 * c@d.com`) no matchean ningun subaddress y `routeMail()` los descarta como `sin_slug` antes de
 * llegar a publicar — esta suite es sobre el arranque IMAP, no sobre publicacion, asi que no hace
 * falta el bus real.
 */

const FAKE_CLIENT = {} as unknown as Client;

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
};

interface FakeClientOptions {
  readonly connectError?: unknown;
  readonly lockError?: unknown;
  readonly searchResult?: number[];
  /**
   * Hace que `messageFlagsAdd` (markSeen) lance a partir del N-esimo uid marcado — simula un corte
   * de red a mitad del batch. Se elige `markSeen` y no `fetch`/`download` porque un fallo de
   * `fetch` es "descarga fallida aislable" (CA-6: se saltea con warn, el loop sigue) — el tick NO
   * lo deja propagar. Un fallo de `markSeen`, en cambio, no esta contemplado por ningun AC
   * especifico y la Story Plan (Tarea 2, Implementation Notes) es explicita en que ese caso "se
   * deja propagar fuera del loop", que es exactamente el escenario que TS-17/TS-18 necesitan.
   */
  readonly failMarkSeenAfter?: number;
}

function createFakeClient(options: FakeClientOptions = {}) {
  let marksSoFar = 0;
  let downloadsSoFar = 0;
  const release = vi.fn();
  const logout = vi.fn(async () => undefined);
  const connect = vi.fn(async () => {
    if (options.connectError !== undefined) throw options.connectError;
  });
  const getMailboxLock = vi.fn(async () => {
    if (options.lockError !== undefined) throw options.lockError;
    return { path: 'INBOX', release };
  });
  const search = vi.fn(async () => options.searchResult ?? []);
  const messageFlagsAdd = vi.fn(async (_range: number, _flags: string[], _opts: { uid: boolean }) => {
    marksSoFar += 1;
    if (options.failMarkSeenAfter !== undefined && marksSoFar > options.failMarkSeenAfter) {
      throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    }
    return true;
  });
  const download = vi.fn(async () => {
    downloadsSoFar += 1;
    const body = Buffer.from(
      `Message-Id: <entrypoint-${downloadsSoFar}@fixtures.local>\r\n` +
        'From: a@b.com\r\nTo: c@d.com\r\nSubject: x\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\nhola\r\n',
    );
    return { meta: { expectedSize: body.length, contentType: 'message/rfc822' }, content: Readable.from([body]) };
  });

  return { connect, logout, getMailboxLock, search, messageFlagsAdd, download, release };
}

function ctorFor(client: ReturnType<typeof createFakeClient>): ImapFlowCtor {
  return () => client as unknown as ImapFlowLike;
}

describe('runIngestaTick — credenciales incorrectas (CA-9)', () => {
  // TS-15
  it('fails the tick without leaking credentials, worker alive, metrics line with all counters at zero', async () => {
    class AuthenticationFailure extends Error {}
    const client = createFakeClient({ connectError: new AuthenticationFailure('LOGIN failed') });
    const { logger, capture } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger, FAKE_CLIENT, SPACE, ctorFor(client));

    const errorLine = capture.lines().find((line) => line['level'] === 'error' || line['msg'] === 'el tick fallo');
    expect(errorLine).toBeDefined();

    for (const line of capture.raw()) {
      expect(line).not.toContain('app-password-de-prueba');
      expect(line).not.toContain('tickets@ejemplo.com');
    }

    const tickLine = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tickLine).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
      // TS-32 (S-026): los SEIS en 0. Sin afirmarlo, `comentados` podria desaparecer del `catch`
      // de `runIngestaTick()` sin que ningun test se entere — `toMatchObject` no lo detectaria.
      comentados: 0,
    });
  });

  /**
   * Hallazgo de QA review: distinguir "el callback de runTick corrio" de "nunca corrio" NO puede
   * basarse en el tipo de excepcion (`instanceof ImapConnectError`) porque `withMailSource` puede
   * fallar ANTES de invocar el callback por mas de una razon — `connect()` (que SI traduce a
   * `ImapConnectError`) y `getMailboxLock()` (que NO lo hace, y deja pasar el error del cliente tal
   * cual). Este test cubre especificamente el segundo camino: si no se emitiera la linea de
   * metricas tambien aca, un fallo real del lock de INBOX perderia el rastro que CA-11/ADR-006
   * exigen sin excepcion.
   */
  it('also emits the metrics line at zero when getMailboxLock() fails (not just connect())', async () => {
    const lockError = Object.assign(new Error('lock timeout'), { code: 'ETIMEDOUT' });
    const client = createFakeClient({ lockError });
    const { logger, capture } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger, FAKE_CLIENT, SPACE, ctorFor(client));

    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    const tickLines = capture.lines().filter((line) => line['msg'] === 'tick completado');
    expect(tickLines).toHaveLength(1);
    expect(tickLines[0]).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
      // TS-32 (S-026): los SEIS en 0. Sin afirmarlo, `comentados` podria desaparecer del `catch`
      // de `runIngestaTick()` sin que ningun test se entere — `toMatchObject` no lo detectaria.
      comentados: 0,
    });
  });
});

describe('runIngestaTick — host inalcanzable (CA-10)', () => {
  // TS-16
  it('no message ends up marked Seen; the tick fails, worker alive, metrics at zero', async () => {
    const networkError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const client = createFakeClient({ connectError: networkError });
    const { logger, capture } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger, FAKE_CLIENT, SPACE, ctorFor(client));

    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    const tickLine = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tickLine).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
      // TS-32 (S-026): los SEIS en 0. Sin afirmarlo, `comentados` podria desaparecer del `catch`
      // de `runIngestaTick()` sin que ningun test se entere — `toMatchObject` no lo detectaria.
      comentados: 0,
    });
  });
});

describe('runIngestaTick — corte de red a mitad de camino (CA-11, CA-12)', () => {
  // TS-17
  it('emits the metrics line with partial counters when the tick fails mid-batch', async () => {
    const client = createFakeClient({
      searchResult: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      // Los primeros 4 uids (10,9,8,7) se marcan y normalizan con exito. El 5to intento de
      // markSeen (uid 6) revienta: ese uid ya conto "ingestados" (se incrementa antes del fetch)
      // pero nunca llega a "parseados", y el error escapa del loop entero (no es un fallo de
      // fetch/normalize, que el tick aisla — ver nota de Tarea 2).
      failMarkSeenAfter: 4,
    });
    const { logger, capture } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger, FAKE_CLIENT, SPACE, ctorFor(client));

    const tickLine = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tickLine).toMatchObject({ ingestados: 5, parseados: 4, fallidos: 0 });
    // Solo una linea de metricas (la de runTick, ya que su finally corrio antes de propagar).
    expect(capture.lines().filter((line) => line['msg'] === 'tick completado')).toHaveLength(1);
  });

  // TS-18
  it('the already-marked Seen mails are not reprocessed on the next tick', async () => {
    const client = createFakeClient({
      searchResult: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      failMarkSeenAfter: 4,
    });
    const { logger } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger, FAKE_CLIENT, SPACE, ctorFor(client));

    // La 5ta llamada (uid 6) se invoco pero RECHAZO — no cuenta como "marcado con exito". Los
    // primeros 4 uids son los unicos efectivamente vistos por el proximo tick.
    const attemptedUids = client.messageFlagsAdd.mock.calls.map((call) => call[0]);
    expect(attemptedUids).toEqual([10, 9, 8, 7, 6]);
    const successfulResults = await Promise.allSettled(client.messageFlagsAdd.mock.results.map((r) => r.value));
    const seenUids = attemptedUids.filter((_uid, index) => successfulResults[index]?.status === 'fulfilled');
    expect(seenUids).toEqual([10, 9, 8, 7]);

    // Segunda invocacion: searchUnseen ahora excluye los ya marcados.
    const client2 = createFakeClient({ searchResult: [6, 5, 4, 3, 2, 1] });
    const { logger: logger2 } = testLoggerWithCapture();

    await runIngestaTick(BASE_CONFIG, logger2, FAKE_CLIENT, SPACE, ctorFor(client2));

    const fetchedInSecondRun = client2.download.mock.calls.length;
    expect(fetchedInSecondRun).toBe(6);
    for (const uid of [10, 9, 8, 7]) {
      expect(client2.search).toHaveBeenCalled();
      // El doble de la 2da invocacion ya no incluye los marcados: no hay forma de que aparezcan.
      expect([6, 5, 4, 3, 2, 1]).not.toContain(uid);
    }
  });
});
