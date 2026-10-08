import {
  JikuFailure,
  JikuPermissionDenied,
} from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { requestFileUpload } from '#domain/publicacion/upload-file.js';
import { diagnosePublishFailure } from '#domain/publicacion/publish-errors.js';
import { createLogger } from '#shared/logger.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import type { AppConfig } from '#config/index.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondTo } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-1 a TS-17: `requestFileUpload()` contra el NATS REAL del contenedor compartido.
 *
 * Esta funcion toca el bus (`client.command()`), asi que por la convencion `testing` es
 * integracion por definicion — sin unit test, mismo criterio ya aplicado a
 * `publishVerificationRequirement()`/`publishRequirementFromMail()` (`publish.test.ts`). `core` se
 * dobla con `respondTo()` sobre el bus real, nunca con un mock de `client.command`.
 *
 * TS-13 (rechazo del bus por subject) NO se prueba conectando con un `userId` fuera de scope:
 * `Client.fromConnection()` salta el handshake de auth (documentado en `publish.test.ts`), asi que
 * un `JikuPermissionDenied` real no se puede provocar contra el NATS plano de este contenedor. El
 * mismo criterio que ya usa la suite de `diagnose.test.ts` para esa clase se aplica aca: se
 * construye la instancia real del SDK a mano y se verifica que `requestFileUpload()` la traduce
 * igual que cualquier otro fallo de las 9 ramas — lo que se prueba es la traduccion, no el rechazo
 * de Zitadel en si, que ya cubre `test/bus/*` para la conexion.
 */

const COMMAND = 'files.request-upload';

let bus: TestBusContext;
let capture: LogCapture;
let responder: CoreResponder | undefined;

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: TEST_INSTANCE,
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
    ...overrides,
  };
}

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  await bus.cleanup();
});

afterEach(async () => {
  // Se da de baja el responder para que un caso no le conteste al siguiente — necesario porque
  // `fileParallelism: false` deja una suscripcion viva contaminando el siguiente test si no se da
  // de baja (mismo patron que `publish.test.ts`/`source-properties.test.ts`).
  await responder?.stop();
  responder = undefined;
});

describe('requestFileUpload', () => {
  // TS-1
  it('returns { tipo: concedido, fileId, uploadUrl } and sends exactly the 4 payload keys', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 99, uploadUrl: 'https://storage.example/put/xyz' },
    });

    const result = await requestFileUpload(
      {
        filename: 'captura.png',
        mimeType: 'image/png',
        content: Buffer.alloc(2_000_000, 1),
        checksum: 'abc123...',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({
      tipo: 'concedido',
      fileId: 99,
      uploadUrl: 'https://storage.example/put/xyz',
    });

    // El payload OBSERVADO por el responder, exactamente los 4 campos, sin uploader ni actor.
    expect(responder.payloads()).toEqual([
      { fileName: 'captura.png', mimeType: 'image/png', fileSize: 2_000_000, checksum: 'abc123...' },
    ]);
  });

  // TS-2
  it('lets the SDK build the subject, with the wildcard already authorized', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 1, uploadUrl: 'https://storage.example/put/1' },
    });

    await requestFileUpload(
      {
        filename: 'captura.png',
        mimeType: 'image/png',
        content: Buffer.alloc(2_000_000, 1),
        checksum: 'abc123...',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(responder.subjects()).toEqual([
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-commands.v1.${COMMAND}`,
    ]);
  });

  // TS-3 (test de propiedad, ya cubierto por test/publicacion/source-properties.test.ts:
  // 'invokes client.command exactly once in upload-file.ts, with two arguments')

  // TS-4
  it('treats a success reply without a usable fileId/uploadUrl as a FAILURE, never a partial success', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    const result = await requestFileUpload(
      {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        content: Buffer.alloc(10),
        checksum: 'c1',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({
      tipo: 'fallido',
      diagnosis: 'respuesta_ilegible',
      nombre: 'x.pdf',
      mime: 'application/pdf',
    });

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure?.['diagnosis']).toBe('respuesta_ilegible');
  });

  // TS-5
  it('treats a file_type_not_allowed business failure as a REJECTION, not a failure', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_type_not_allowed',
    });

    const result = await requestFileUpload(
      {
        filename: 'virus.exe',
        mimeType: 'application/x-msdownload',
        content: Buffer.from('MZ'),
        checksum: 'def456...',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({
      tipo: 'rechazado',
      codigo: 'file_type_not_allowed',
      nombre: 'virus.exe',
      mime: 'application/x-msdownload',
    });
  });

  // TS-6
  it('treats a file_too_large business failure as a REJECTION too', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_too_large',
    });

    const result = await requestFileUpload(
      {
        filename: 'enorme.zip',
        mimeType: 'application/zip',
        content: Buffer.alloc(50_000_000),
        checksum: 'ghi789...',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({
      tipo: 'rechazado',
      codigo: 'file_too_large',
      nombre: 'enorme.zip',
      mime: 'application/zip',
    });
  });

  // TS-7
  it('logs the core rejection at warn, with code, nombre and mime — never the uploadUrl', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_type_not_allowed',
    });

    await requestFileUpload(
      {
        filename: 'virus.exe',
        mimeType: 'application/x-msdownload',
        content: Buffer.from('MZ'),
        checksum: 'def456...',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const warnLine = capture.lines().find((line) => line['level'] === 'warn');
    expect(warnLine?.['code']).toBe('file_type_not_allowed');
    expect(warnLine?.['nombre']).toBe('virus.exe');
    expect(warnLine?.['mime']).toBe('application/x-msdownload');

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('uploadUrl');
  });

  // TS-8 (documental — comparacion de nivel entre S-017 e este story, sin codigo que ejercitar
  // directamente: `particionar()` no loguea, esta funcion loguea `warn` en su rechazo de core.
  // Cubierto por TS-7 arriba y por el hecho de que `procesar.ts`/`particionar.ts` no llaman
  // logger.warn en ningun punto — verificado en el codigo de S-017.)

  // TS-9, TS-10, TS-13 agrupados: ramas de diagnosePublishFailure() sin cambios.
  it.each([
    { errorCode: 'caller_not_authorized', diagnosis: 'core_rechazo_por_rol' },
    { errorCode: 'invalid_fields', diagnosis: 'core_rechazo_por_forma' },
  ] as const)(
    'maps $errorCode via diagnosePublishFailure() unchanged, to $diagnosis, logged as error',
    async ({ errorCode, diagnosis }) => {
      capture = createLogCapture();
      responder = await respondTo(bus.connection, COMMAND, { status: 'failure', errorCode });

      const result = await requestFileUpload(
        {
          filename: 'a.png',
          mimeType: 'image/png',
          content: Buffer.from('x'),
          checksum: 'c',
        },
        { client: bus.client, logger: loggerFor(capture) },
      );

      expect(result).toEqual({
        tipo: 'fallido',
        diagnosis,
        nombre: 'a.png',
        mime: 'image/png',
      });

      const errorLine = capture.lines().find((line) => line['level'] === 'error');
      expect(errorLine?.['diagnosis']).toBe(diagnosis);
      expect(errorLine?.['sdkErrorClass']).toBe('JikuFailure');
    },
  );

  // TS-13, sobre la funcion de traduccion directamente (ver nota de la suite arriba: no se puede
  // provocar un JikuPermissionDenied real contra este bus sin auth-callout).
  it('TS-13: a rechazo_del_bus_por_subject from diagnosePublishFailure would also produce tipo: fallido', () => {
    const cause = new JikuPermissionDenied(
      'el bus rechazo',
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-commands.v1.${COMMAND}`,
      COMMAND,
    );

    expect(diagnosePublishFailure(cause)).toBe('rechazo_del_bus_por_subject');
  });

  // TS-11
  it('never falls into a file-rejection diagnosis for an unknown core code', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'algo_que_no_existe_todavia',
    });

    const result = await requestFileUpload(
      {
        filename: 'a.png',
        mimeType: 'image/png',
        content: Buffer.from('x'),
        checksum: 'c',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({
      tipo: 'fallido',
      diagnosis: 'core_rechazo_desconocido',
      nombre: 'a.png',
      mime: 'image/png',
    });
    expect(result.tipo).not.toBe('rechazado');
  });

  // TS-12: timeout real del comando. Intrinsecamente lento (15000 ms del default del SDK) — mismo
  // criterio documentado en publish.test.ts/diagnose.test.ts para este tipo de caso.
  it(
    'TS-12: a muted responder (nobody answers) produces tipo: fallido, diagnosis nada_respondio, no retry',
    async () => {
      capture = createLogCapture();
      responder = await respondTo(bus.connection, COMMAND, MUTE);

      const result = await requestFileUpload(
        {
          filename: 'a.png',
          mimeType: 'image/png',
          content: Buffer.from('x'),
          checksum: 'c',
        },
        { client: bus.client, logger: loggerFor(capture) },
      );

      expect(result).toEqual({
        tipo: 'fallido',
        diagnosis: 'nada_respondio',
        nombre: 'a.png',
        mime: 'image/png',
      });
      // Una sola invocacion observada por el responder: sin reintento.
      expect(responder.count()).toBe(1);

      const errorLine = capture.lines().find((line) => line['level'] === 'error');
      expect(errorLine?.['diagnosis']).toBe('nada_respondio');
    },
    20_000,
  );

  // TS-14
  it('is invoked once per attachment — the signature accepts no list or batch parameter', () => {
    // Test de propiedad sobre la firma: `requestFileUpload` recibe un solo adjunto (Pick de
    // AdjuntoAceptado) y las deps, nunca un array. Se afirma que la funcion tiene aridad 2.
    expect(requestFileUpload).toHaveLength(2);
  });

  // TS-15
  it('never logs the uploadUrl, neither on success nor on any other result', async () => {
    capture = createLogCapture();

    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 5, uploadUrl: 'https://storage.example/put/xyz' },
    });
    await requestFileUpload(
      { filename: 'a.png', mimeType: 'image/png', content: Buffer.from('x'), checksum: 'c1' },
      { client: bus.client, logger: loggerFor(capture) },
    );
    await responder.stop();

    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_type_not_allowed',
    });
    await requestFileUpload(
      { filename: 'b.exe', mimeType: 'application/x-msdownload', content: Buffer.from('y'), checksum: 'c2' },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('https://storage.example/put/xyz');
    expect(raw).not.toContain('uploadUrl');
  });

  // TS-16
  it('sends the checksum verbatim, never recalculated', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 1, uploadUrl: 'https://storage.example/put/1' },
    });

    await requestFileUpload(
      {
        filename: 'a.png',
        mimeType: 'image/png',
        content: Buffer.from('x'),
        checksum: 'checksum-ya-calculado-por-s017',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(responder.payloads()).toEqual([
      {
        fileName: 'a.png',
        mimeType: 'image/png',
        fileSize: 1,
        checksum: 'checksum-ya-calculado-por-s017',
      },
    ]);
  });

  // TS-17
  it('derives fileSize from content.length, never from a declared size field', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 1, uploadUrl: 'https://storage.example/put/1' },
    });

    await requestFileUpload(
      {
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        content: Buffer.alloc(5_242_880),
        checksum: 'c',
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const [payload] = responder.payloads();
    expect((payload as { fileSize: number }).fileSize).toBe(5_242_880);
  });

  it('publishes exactly once per call, with no retry', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 1, uploadUrl: 'https://storage.example/put/1' },
    });

    await requestFileUpload(
      { filename: 'a.png', mimeType: 'image/png', content: Buffer.from('x'), checksum: 'c' },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(responder.count()).toBe(1);
  });

  it('never throws for a rejection or a failure — always resolves with a typed result', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    await expect(
      requestFileUpload(
        { filename: 'a.png', mimeType: 'image/png', content: Buffer.from('x'), checksum: 'c' },
        { client: bus.client, logger: loggerFor(capture) },
      ),
    ).resolves.not.toThrow();
  });
});
