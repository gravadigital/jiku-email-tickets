import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadFileContent } from '#domain/publicacion/upload-byte.js';
import { createLogger } from '#shared/logger.js';
import { MIN_TIMEOUT_MS, DEFAULT_PUT_TIMEOUT_MS } from '#config/schema.js';
import type { AppConfig } from '#config/index.js';

import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-1 a TS-17: `uploadFileContent()` con `fetch` doblado en el limite -- vi.stubGlobal('fetch',
 * ...), nunca una libreria de HTTP-mocking nueva (`nock`, `msw`), que violaria "sin dependencias
 * npm nuevas". Es la unica pieza de `publicacion/` que se testea asi: esta funcion no toca NATS,
 * asi que no necesita `setupTestBus()` ni el contenedor compartido.
 *
 * TS-13, TS-18, TS-19 (tests de propiedad sobre el codigo fuente) estan en
 * `source-properties.test.ts` (Task 3), no aca.
 */

const TEST_UPLOAD_URL = 'https://storage.example/put/xyz?sig=abc';

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: 'test-instance',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: 'proj-uuid',
    issuer: 'https://unreachable-issuer.invalid',
    timeoutMs: MIN_TIMEOUT_MS,
    verifyProjectId: 7,
    logLevel: 'trace',
    nodeEnv: 'test',
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
      putTimeoutMs: DEFAULT_PUT_TIMEOUT_MS,
    },
    ...overrides,
  };
}

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadFileContent', () => {
  // TS-1
  it('returns { tipo: subido } on a 200, invoking fetch exactly once with the exact PUT shape', async () => {
    const capture = createLogCapture();
    const content = Buffer.alloc(2_000_000, 1);
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'subido' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(TEST_UPLOAD_URL, {
      method: 'PUT',
      body: content,
      signal: expect.any(AbortSignal),
    });
  });

  // TS-2
  it('returns { tipo: subido } on a 201 — any 2xx counts, not just 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(2_000_000, 1) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(createLogCapture()) },
    );

    expect(result).toEqual({ tipo: 'subido' });
  });

  // TS-3
  it('returns { tipo: subido } on a 204, never reading any body-reading method of the response', async () => {
    const jsonSpy = vi.fn();
    const textSpy = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204, json: jsonSpy, text: textSpy }),
    );

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(2_000_000, 1) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(createLogCapture()) },
    );

    expect(result).toEqual({ tipo: 'subido' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  // TS-4
  it('sends no authorization headers', async () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(2_000_000, 1) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(createLogCapture()) },
    );

    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit & { headers?: unknown }];
    if (init.headers !== undefined) {
      const headerKeys = Object.keys(init.headers as Record<string, unknown>).map((k) =>
        k.toLowerCase(),
      );
      for (const forbidden of ['authorization', 'x-amz-security-token', 'x-amz-date', 'apikey']) {
        expect(headerKeys).not.toContain(forbidden);
      }
    }
  });

  // TS-5
  it('uses config.adjuntos.putTimeoutMs (the real default, 30000) for AbortSignal.timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const config = configWith();

    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      {
        uploadUrl: TEST_UPLOAD_URL,
        timeoutMs: config.adjuntos.putTimeoutMs,
        logger: loggerFor(createLogCapture()),
      },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  // TS-6
  it('uses a configured timeoutMs different from the default — never a hardcoded literal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 5_000, logger: loggerFor(createLogCapture()) },
    );

    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  // TS-7
  it('treats a network error (fetch rejects with TypeError) as tipo: fallido, warn without uploadUrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const capture = createLogCapture();

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'fallido' });
    const warnLine = capture.lines().find((line) => line['level'] === 'warn');
    expect(warnLine?.['nombre']).toBe('captura.png');
    expect(warnLine?.['mime']).toBe('image/png');
    expect(capture.raw().join('\n')).not.toContain('uploadUrl');
  });

  // TS-8
  it('treats a timeout (AbortError from a short-lived AbortSignal.timeout) the same as TS-7', async () => {
    // El timeoutMs corto (50ms) evita alargar la suite: el stub de fetch respeta el signal real de
    // AbortSignal.timeout(50) y rechaza con el AbortError/DOMException real que Node produce,
    // sin necesitar simular timing de wall-clock mas alla de esos 50ms.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }),
    );
    const capture = createLogCapture();

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 50, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'fallido' });
    const warnLine = capture.lines().find((line) => line['level'] === 'warn');
    expect(warnLine?.['nombre']).toBe('captura.png');
    expect(warnLine?.['mime']).toBe('image/png');
    expect(capture.raw().join('\n')).not.toContain('uploadUrl');
  });

  // TS-9
  it('treats a non-2xx response (403, expired URL) as tipo: fallido, same as TS-7/TS-8', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const capture = createLogCapture();

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'fallido' });
    expect(capture.raw().join('\n')).not.toContain('uploadUrl');
  });

  // TS-10
  it('treats a 500 response from storage as tipo: fallido', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(createLogCapture()) },
    );

    expect(result).toEqual({ tipo: 'fallido' });
  });

  // TS-11
  it('never logs the uploadUrl, neither on success nor on failure — checked against raw serialized lines', async () => {
    const capture = createLogCapture();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain(TEST_UPLOAD_URL);
    expect(raw).not.toContain('uploadUrl');
  });

  // TS-12
  it('logs nombre and mime on failure, never the content buffer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const capture = createLogCapture();

    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(2_000_000, 1) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    const warnLine = capture.lines().find((line) => line['level'] === 'warn');
    expect(warnLine?.['nombre']).toBe('captura.png');
    expect(warnLine?.['mime']).toBe('image/png');
    for (const line of capture.lines()) {
      expect(Object.values(line)).not.toContain(Buffer.alloc(2_000_000, 1).toString());
    }
  });

  // TS-14
  it('has an arity of 2 — no list or order parameter', () => {
    expect(uploadFileContent).toHaveLength(2);
  });

  // TS-15
  it('captures an unexpected error building the PUT (before fetch) the same way as a fetch failure', async () => {
    // Se fuerza una excepcion ANTES de invocar fetch: un `uploadUrl` no-string rompe la
    // construccion misma de la llamada (fetch la recibiria como primer argumento y TypeScript no lo
    // permitiria en produccion, pero a nivel runtime cualquier valor puede llegar mal formado desde
    // un caller que ignore el tipo — el punto de inyeccion real es simular que `fetch` mismo no esta
    // disponible como funcion, forzando un TypeError al invocarlo).
    vi.stubGlobal('fetch', undefined);
    const capture = createLogCapture();

    const result = await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'fallido' });
    const warnLine = capture.lines().find((line) => line['level'] === 'warn');
    expect(warnLine?.['nombre']).toBe('captura.png');
    expect(warnLine?.['mime']).toBe('image/png');
  });

  // TS-16
  it('invokes fetch exactly once per call — no internal retry', async () => {
    const fetchStub = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetchStub);

    await uploadFileContent(
      { filename: 'captura.png', mimeType: 'image/png', content: Buffer.alloc(10) },
      { uploadUrl: TEST_UPLOAD_URL, timeoutMs: 30_000, logger: loggerFor(createLogCapture()) },
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  // TS-17
  it('uses putTimeoutMs (30000) independently of the bus MIN_TIMEOUT_MS (15000) — distinct literals', () => {
    expect(DEFAULT_PUT_TIMEOUT_MS).toBe(30_000);
    expect(MIN_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_PUT_TIMEOUT_MS).not.toBe(MIN_TIMEOUT_MS);
  });
});
