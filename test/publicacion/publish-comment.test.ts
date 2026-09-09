import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { publishCommentFromMail } from '#domain/publicacion/publish-comment.js';
import { PublishError } from '#domain/publicacion/publish-errors.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondTo } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-20 a TS-38 del Story Plan de S-027: `publishCommentFromMail()` contra el NATS REAL.
 *
 * El bus NO se mockea (convencion `testing`): `core` se dobla con `respondTo()` en el propio test,
 * suscripto CON COMODIN. Es lo que permite afirmar el SUBJECT EXACTO y el PAYLOAD EXACTO que
 * viajaron — sin `.subjects()` y `.payloads()`, CA-4 y CA-5 se "verificarian" leyendo el codigo,
 * que no es verificar.
 */

const REQUIREMENT_ID = 500;
const COMMAND = `requirements.${String(REQUIREMENT_ID)}.comment`;
const MESSAGE_ID = '<reply1@cliente.com>';
const TEXTO = 'texto compuesto';

const MAIL = { messageId: MESSAGE_ID };

let bus: TestBusContext;
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
      placeholderTitle: 'Ticket recibido por mail',
      placeholderBody: '(mail sin contenido)',
    },
    adjuntos: {
      allowedExtensions: ['.png', '.pdf', '.txt'],
      allowedMimeTypes: ['image/png', 'application/pdf'],
      maxSizeBytes: 10_485_760,
      putTimeoutMs: 30_000,
    },
    kv: {
      ticketsBucket: 'TICKETS',
      threadsBucket: 'MAIL_THREADS',
      threadsTtlDays: 90,
      watchRetryMs: 30_000,
    },
    ...overrides,
  };
}

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith(), sink.stream);
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

/** Un fallo de `core` con el codigo indicado, y la ejecucion que lo provoca. */
async function failWith(
  errorCode: string,
): Promise<{ capture: LogCapture; error: unknown }> {
  const capture = createLogCapture();
  responder = await respondTo(bus.connection, COMMAND, { status: 'failure', errorCode });

  let error: unknown;
  try {
    await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });
  } catch (cause) {
    error = cause;
  }

  return { capture, error };
}

describe('publishCommentFromMail — el camino feliz (TS-20 a TS-26)', () => {
  // TS-20
  it('TS-20: publica y el responder recibe EXACTAMENTE un mensaje', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    expect(responder.count()).toBe(1);
  });

  // TS-21
  it('TS-21: el subject exacto lleva el id interpolado, armado por el SDK', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    // El prefijo `{instance}.{userId}` lo arma el SDK a partir del `method`: el conector NO escribe
    // `jiku-commands.v1` en ningun lado (ADR-002).
    expect(responder.subjects()).toEqual([
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-commands.v1.requirements.500.comment`,
    ]);
  });

  // TS-22, TS-25
  it('TS-22/TS-25: el payload EXACTO, sin author, sin actor, sin fileIds y con visibilityLevel explicito', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    const payload = responder.payloads()[0] as Record<string, unknown>;

    expect(payload).toEqual({ comment: TEXTO, visibilityLevel: 'public' });
    expect('author' in payload).toBe(false);
    expect('fileIds' in payload).toBe(false);
    expect('actor' in payload).toBe(false);
    // TS-25: la clave ESTA PRESENTE, no omitida esperando el default del contrato — que es
    // `internal`, el OPUESTO del que hace falta.
    expect(payload['visibilityLevel']).toBe('public');
  });

  // TS-23
  it('TS-23: con fileIds la clave viaja con sus ids', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(
      MAIL,
      REQUIREMENT_ID,
      TEXTO,
      { client: bus.client, logger: loggerFor(capture) },
      [7, 8],
    );

    expect(responder.payloads()[0]).toEqual({
      comment: TEXTO,
      visibilityLevel: 'public',
      fileIds: [7, 8],
    });
  });

  // TS-24
  it('TS-24: con fileIds vacio la clave NO viaja — nunca fileIds: []', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(
      MAIL,
      REQUIREMENT_ID,
      TEXTO,
      { client: bus.client, logger: loggerFor(capture) },
      [],
    );

    const payload = responder.payloads()[0] as Record<string, unknown>;
    expect('fileIds' in payload).toBe(false);
  });

  it('el array de fileIds se COPIA, no se manda la referencia mutable del llamador', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    const fileIds = [7, 8];
    await publishCommentFromMail(
      MAIL,
      REQUIREMENT_ID,
      TEXTO,
      { client: bus.client, logger: loggerFor(capture) },
      fileIds,
    );
    fileIds.push(9);

    expect(responder.payloads()[0]).toMatchObject({ fileIds: [7, 8] });
  });

  // TS-26, TS-38
  it('TS-26/TS-38: la linea de exito lleva messageId y requirementId, y NUNCA el commentId', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    const success = capture.lines().filter((line) => line['level'] === 'info');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({ messageId: MESSAGE_ID, requirementId: REQUIREMENT_ID });
    expect(success[0]?.['comment']).toBeUndefined();
    expect(success[0]?.['commentId']).toBeUndefined();

    // TS-26: el `commentId` NO se usa ni se loguea — no aporta diagnostico que el `requirementId`
    // no de ya. La asercion va sobre la LINEA CRUDA: un id que se colo por un campo inesperado no
    // se ve mirando campos conocidos.
    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('900');
    expect(raw).not.toContain('commentId');
  });

  it('el valor de retorno no expone el commentId', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    const result: unknown = await publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    expect(result).toBeUndefined();
  });
});

describe('publishCommentFromMail — las ramas de error (TS-27 a TS-35)', () => {
  // TS-27
  it('TS-27: requirement_not_found → core_rechazo_desconocido, con el code en el log', async () => {
    const { capture, error } = await failWith('requirement_not_found');

    expect(error).toBeInstanceOf(PublishError);

    const failure = capture.lines().find((line) => line['level'] === 'error');
    expect(failure).toMatchObject({
      messageId: MESSAGE_ID,
      requirementId: REQUIREMENT_ID,
      // NO es un defecto que caiga en el catch-all: el catalogo de codigos lo posee `core` y crece,
      // y el `code` real viaja igual en el contexto, que es lo que ADR-006 exige.
      diagnosis: 'core_rechazo_desconocido',
      code: 'requirement_not_found',
      planoDeEscrituraAbierto: true,
      sdkErrorClass: 'JikuFailure',
    });
    // El contexto es PLANO de un nivel: `redact.paths` de Pino no tiene comodin profundo.
    expect(failure?.['projectId']).toBeUndefined();
  });

  // TS-28
  it('TS-28: file_not_owned → el mismo camino, con su code', async () => {
    const { capture, error } = await failWith('file_not_owned');

    expect(error).toBeInstanceOf(PublishError);
    expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
      diagnosis: 'core_rechazo_desconocido',
      code: 'file_not_owned',
    });
  });

  // TS-29
  it('TS-29: invalid_fields → core_rechazo_por_forma', async () => {
    const { capture, error } = await failWith('invalid_fields');

    expect(error).toBeInstanceOf(PublishError);
    expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
      diagnosis: 'core_rechazo_por_forma',
      code: 'invalid_fields',
    });
  });

  // TS-30
  it.each(['access_denied', 'internal_error'])(
    'TS-30: %s → core_rechazo_desconocido con su code literal',
    async (errorCode) => {
      const { capture, error } = await failWith(errorCode);

      expect(error).toBeInstanceOf(PublishError);
      expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
        diagnosis: 'core_rechazo_desconocido',
        code: errorCode,
      });
    },
  );

  // TS-31
  it('TS-31: caller_not_authorized → core_rechazo_por_rol (la traduccion es la misma)', async () => {
    const { capture, error } = await failWith('caller_not_authorized');

    expect(error).toBeInstanceOf(PublishError);
    expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
      diagnosis: 'core_rechazo_por_rol',
    });
  });

  // TS-32
  // Intrinsecamente lento: espera el timeout REAL del SDK (15000 ms). Es deliberado y es el mismo
  // criterio del precedente directo (`upload-file.test.ts`, TS-12): la alternativa seria un
  // parametro `options` en `publishCommentFromMail()` usado solo por los tests, y eso abriria en la
  // firma de produccion exactamente el tercer argumento donde se baja el timeout por accidente —
  // que es lo que ADR-006 prohibe y lo que TS-66 escanea. Se paga el tiempo de suite en vez de
  // debilitar la firma.
  it(
    'TS-32: nadie contesta → nada_respondio',
    async () => {
      const capture = createLogCapture();
      // MUTE: el mensaje LLEGA (asi el contador lo cuenta, que es lo que prueba que la publicacion
      // si llego a la red) y nadie contesta.
      responder = await respondTo(bus.connection, COMMAND, MUTE);

      await expect(
        publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
          client: bus.client,
          logger: loggerFor(capture),
        }),
      ).rejects.toBeInstanceOf(PublishError);

      expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
        diagnosis: 'nada_respondio',
      });
      expect(responder.count()).toBe(1);
    },
    20_000,
  );

  // TS-33
  it('TS-33: nada suscripto → bus_sin_endpoint, de inmediato', async () => {
    const capture = createLogCapture();
    // Sin responder para este subject. Un requirementId distinto para no cruzarse con nada.

    await expect(
      publishCommentFromMail({ messageId: MESSAGE_ID }, 4242, TEXTO, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
      diagnosis: 'bus_sin_endpoint',
      requirementId: 4242,
    });
  });

  // TS-34
  it('TS-34: una reply de exito sin id usable es un FALLO, no un exito con hueco', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    await expect(
      publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(capture.lines().find((line) => line['level'] === 'error')).toMatchObject({
      diagnosis: 'respuesta_ilegible',
      messageId: MESSAGE_ID,
      requirementId: REQUIREMENT_ID,
    });
  });

  // TS-35
  it.each([
    'requirement_not_found',
    'file_not_owned',
    'invalid_fields',
    'access_denied',
    'internal_error',
    'caller_not_authorized',
  ])('TS-35: sin reintento — exactamente 1 mensaje por invocacion (%s)', async (errorCode) => {
    await failWith(errorCode);
    expect(responder?.count()).toBe(1);
  });

  it('TS-35: tambien exactamente 1 en la rama de la reply ilegible', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    await expect(
      publishCommentFromMail(MAIL, REQUIREMENT_ID, TEXTO, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(responder.count()).toBe(1);
  });

  // TS-36
  it('TS-36: un payload invalido NO se publica: se rechaza local, antes de la red', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await expect(
      publishCommentFromMail(MAIL, REQUIREMENT_ID, '', {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toThrow();

    // El responder NO recibio nada: publicarlo gastaria un round-trip para que `core` conteste algo
    // que el conector ya sabia.
    expect(responder.count()).toBe(0);
  });
});

describe('publishCommentFromMail — el texto NUNCA se loguea (TS-37)', () => {
  const SECRETO = 'CONTENIDO-SECRETO-DEL-CLIENTE';

  // TS-37
  it('TS-37: en el camino de exito, ninguna linea contiene el texto', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { id: 900 },
    });

    await publishCommentFromMail(MAIL, REQUIREMENT_ID, SECRETO, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    // Sobre la linea CRUDA: un secreto que se colo por un campo inesperado no se ve mirando campos
    // conocidos.
    expect(capture.raw().join('\n')).not.toContain(SECRETO);
  });

  // TS-37
  it.each([
    'requirement_not_found',
    'file_not_owned',
    'invalid_fields',
    'access_denied',
    'internal_error',
    'caller_not_authorized',
  ])('TS-37: en la rama de fallo %s tampoco aparece', async (errorCode) => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'failure', errorCode });

    await expect(
      publishCommentFromMail(MAIL, REQUIREMENT_ID, SECRETO, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(capture.raw().join('\n')).not.toContain(SECRETO);
  });

  it('TS-37: en la rama de la reply ilegible tampoco aparece', async () => {
    const capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    await expect(
      publishCommentFromMail(MAIL, REQUIREMENT_ID, SECRETO, {
        client: bus.client,
        logger: loggerFor(capture),
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(capture.raw().join('\n')).not.toContain(SECRETO);
  });
});
