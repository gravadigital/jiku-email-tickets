import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { PublishError } from '#domain/publicacion/publish-errors.js';
import { publishRequirementFromMail } from '#domain/publicacion/publish-requirement.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-11 a TS-16, TS-26: `publishRequirementFromMail()` contra el NATS REAL del contenedor.
 *
 * Mismo criterio que `publish.test.ts` (S-005): toca el bus, es integracion por definicion, `core`
 * se dobla con un responder EN EL PROPIO TEST, nunca se mockea el bus.
 */

const COMMAND = 'requirements.new';

const RUTEO_CONFIG = {
  placeholderTitle: 'Ticket recibido por mail',
  placeholderBody: '(mail sin contenido)',
};

function mail(overrides: Partial<{ messageId: string; subject: string; body: string }> = {}) {
  return {
    messageId: '<abc@cliente.com>',
    subject: 'Falla en el login',
    body: 'No puedo entrar',
    ...overrides,
  };
}

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
      ticketMap: new Map([['alfa', 42]]),
      subaddressPrefix: 'tickets',
      placeholderTitle: RUTEO_CONFIG.placeholderTitle,
      placeholderBody: RUTEO_CONFIG.placeholderBody,
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
  await responder?.stop();
  responder = undefined;
});

describe('publishRequirementFromMail', () => {
  // TS-11
  it('publishes with two arguments, no options, subject observed by the responder', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 100 } });

    await publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    expect(responder.count()).toBe(1);
    expect(responder.subjects()).toEqual([
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-commands.v1.${COMMAND}`,
    ]);
    expect(responder.payloads()).toEqual([
      {
        title: 'Falla en el login',
        description: 'No puedo entrar',
        projectId: 42,
        type: 'incidencia',
        priority: 'sin_prioridad',
        visibilityLevel: 'public',
        creator: TEST_USER_ID,
      },
    ]);
  });

  // TS-12
  it('does NOT report success when the reply carries no usable id', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    await expect(
      publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure?.['diagnosis']).toBe('respuesta_ilegible');
    expect(capture.lines().some((line) => 'requirementId' in line)).toBe(false);
  });

  // TS-13
  it('logs one success line with messageId, projectId and requirementId together', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 55 } });

    const result = await publishRequirementFromMail(
      mail({ messageId: '<abc@cliente.com>' }),
      42,
      RUTEO_CONFIG,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ requirementId: 55 });

    const success = capture
      .lines()
      .filter(
        (line) =>
          line['messageId'] === '<abc@cliente.com>' &&
          line['projectId'] === 42 &&
          line['requirementId'] === 55,
      );

    expect(success).toHaveLength(1);
    expect(success[0]?.['level']).toBe('info');
    expect(success[0]?.['msg']).toBe('requisito creado en Jiku');
  });

  // TS-14
  it('adds messageId to the error line, and the rest of the context is identical to logContext()', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    await expect(
      publishRequirementFromMail(mail({ messageId: '<xyz@cliente.com>' }), 42, RUTEO_CONFIG, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure).toMatchObject({
      messageId: '<xyz@cliente.com>',
      diagnosis: 'core_rechazo_por_rol',
      sdkErrorClass: 'JikuFailure',
      projectId: 42,
      planoDeEscrituraAbierto: true,
      code: 'caller_not_authorized',
    });
  });

  // TS-15
  it('diagnoses caller_not_authorized as a role rejection, not a payload problem', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    await expect(
      publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure?.['diagnosis']).toBe('core_rechazo_por_rol');
  });

  // TS-16
  it('diagnoses project_not_found with the projectId included', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'project_not_found',
    });

    await expect(
      publishRequirementFromMail(mail(), 999, RUTEO_CONFIG, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure).toMatchObject({
      diagnosis: 'core_rechazo_por_forma',
      projectId: 999,
      code: 'project_not_found',
    });
  });

  // TS-26
  it('diagnoses unknown_caller the same as caller_not_authorized', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'unknown_caller',
    });

    await expect(
      publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure?.['diagnosis']).toBe('core_rechazo_por_rol');
  });

  // S-021, TS-13: el log de exito suma archivosVinculados/archivosConAviso a la MISMA linea.
  it('sums archivosVinculados and archivosConAviso to the same success line, not a second one', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 77 } });

    await publishRequirementFromMail(
      mail({ messageId: '<con-adjuntos@cliente.com>' }),
      42,
      RUTEO_CONFIG,
      { client: bus.client, logger: loggerFor(capture) },
      [101],
      'No puedo entrar\nNo se pudo subir b.exe: error al subir el archivo.\n![attach:101]',
      2,
    );

    const successLines = capture.lines().filter((line) => line['msg'] === 'requisito creado en Jiku');
    expect(successLines).toHaveLength(1);
    expect(successLines[0]).toMatchObject({
      messageId: '<con-adjuntos@cliente.com>',
      projectId: 42,
      requirementId: 77,
      archivosVinculados: 1,
      archivosConAviso: 2,
    });
  });

  // S-021: sin adjuntos (llamado con la firma previa a esta story), los dos conteos son 0 -- CA-4,
  // retro-compatibilidad de la linea de exito.
  it('with no attachments, archivosVinculados and archivosConAviso are both 0', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 88 } });

    await publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    const success = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
    expect(success).toMatchObject({ archivosVinculados: 0, archivosConAviso: 0 });
  });

  // TS-24 (parcial)
  it('logs neither the payload nor the title nor the description on success', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 3 } });

    await publishRequirementFromMail(mail(), 42, RUTEO_CONFIG, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('Falla en el login');
    expect(raw).not.toContain('No puedo entrar');
    expect(raw).not.toMatch(/"(title|description|payload)"\s*:/);
  });
});
