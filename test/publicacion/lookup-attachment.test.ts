import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { lookupAttachmentByChecksum } from '#domain/publicacion/lookup-attachment.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondToQuery } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-1, TS-2, TS-6, TS-8, TS-9, TS-12, TS-14 a TS-18, TS-22 a TS-27:
 * `lookupAttachmentByChecksum()` contra el NATS REAL del contenedor compartido.
 *
 * Esta funcion toca el bus (`client.list()`), asi que por la convencion `testing` es integracion
 * por definicion — sin unit test, mismo criterio que `requestFileUpload()`. `core` se dobla con
 * `respondToQuery()` sobre el bus real, nunca con un mock de `client.list`.
 *
 * DOS CONVENCIONES QUE APLICAN A TODA LA SUITE:
 *
 * 1. EL PAYLOAD OBSERVADO EN EL BUS LLEVA `page: { limit: 1 }`, NO `limit: 1`. `listPayload()` del
 *    SDK pliega `limit` y `cursor` dentro de `page`. Afirmar `limit` en el primer nivel haria
 *    fallar el test contra una implementacion correcta — verificado contra el SDK instalado.
 * 2. `count()` DEL RESPONDER es lo que prueba la AUSENCIA de una consulta. Sin el, CA-5, CA-7 y
 *    CA-9 son inafirmables: el resultado observable de la funcion seria el mismo con y sin
 *    consulta.
 */

/** El nombre COMPLETO de la operacion, tal como el SDK lo arma desde `client.list('attachments')`. */
const METHOD = 'attachments.list';

/** El checksum de un adjunto cualquiera. Es un sha256 hex de 64 caracteres, como el real. */
const CHECKSUM = 'a3f1'.padEnd(64, '0');

/** El requisito del hilo. Es el `entityId` de la consulta. */
const REQUIREMENT_ID = 500;

const ADJUNTO = {
  filename: 'captura.png',
  mimeType: 'image/png',
  checksum: CHECKSUM,
} as const;

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
      subaddressPrefix: 'tickets',
      placeholderTitle: 'Ticket recibido por mail',
      placeholderBody: '(mail sin contenido)',
    },
    adjuntos: {
      allowedExtensions: ['.png', '.pdf'],
      allowedMimeTypes: ['image/png', 'application/pdf'],
      maxSizeBytes: 10_485_760,
      putTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

/** La coleccion con match: una fila, con el `checksum` que `include` trae de vuelta. */
function conMatch(fileId = 1000, checksum = CHECKSUM): {
  status: 'success';
  data: { items: { id: number; fileId: number; checksum: string }[]; page: { limit: number; returned: number } };
} {
  return {
    status: 'success',
    data: { items: [{ id: 77, fileId, checksum }], page: { limit: 1, returned: 1 } },
  };
}

/** La coleccion vacia. Un `list` NUNCA contesta un `*_not_found`: la ausencia es un `success`. */
const SIN_MATCH = {
  status: 'success' as const,
  data: { items: [], page: { limit: 1, returned: 0 } },
};

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  await bus.cleanup();
});

afterEach(async () => {
  // Con `fileParallelism: false` y un bus compartido, una suscripcion viva de un caso anterior le
  // contesta al siguiente. Mismo patron que `upload-file.test.ts`.
  await responder?.stop();
  responder = undefined;
});

describe('lookupAttachmentByChecksum', () => {
  // TS-1
  it('returns the reused fileId when the checksum is already linked to the thread requirement', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'reusado', fileId: 1000 });
    expect(responder.count()).toBe(1);
  });

  // TS-2
  it('treats an empty collection as a success, never an error', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, SIN_MATCH);

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });
    // Y NO loguea `warn`: la ausencia de match no es un fallo, y un `warn` por cada adjunto nuevo
    // de cada respuesta ahogaria el `warn` que si importa (la consulta fallida).
    expect(capture.lines().filter((line) => line['level'] === 'warn')).toEqual([]);
  });

  // TS-6
  it('filters by uploadedBy = client.userId, never a value from the environment', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const payload = responder.payloads()[0] as { filter: Record<string, unknown> };
    expect(payload.filter['uploadedBy']).toBe(bus.client.userId);
    expect(payload.filter['uploadedBy']).toBe(TEST_USER_ID);
  });

  // TS-9
  it('sends the complete filter: the four names, not one less', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    // LOS CUATRO, ni uno menos: sin `entityId` el match seria GLOBAL y un archivo de un cliente se
    // reusaria en el requisito de otro (G-04). Es la razon de que este test afirme la forma
    // COMPLETA y no solo la presencia de `checksum`.
    const payload = responder.payloads()[0] as { filter: Record<string, unknown> };
    expect(Object.keys(payload.filter).sort()).toEqual([
      'checksum',
      'entityId',
      'entityType',
      'uploadedBy',
    ]);
    expect(payload.filter['entityType']).toBe('requirement');
    expect(payload.filter['entityId']).toBe(REQUIREMENT_ID);
    expect(payload.filter['checksum']).toBe(CHECKSUM);
  });

  // TS-8
  it('isolates projects through entityId: another requirement is not a match', async () => {
    const capture = createLogCapture();
    // El responder simula el filtro de `core`: el checksum esta vinculado al Requisito 300
    // (proyecto A), y esta consulta pregunta por el 500 (proyecto B).
    responder = await respondToQuery(bus.connection, METHOD, SIN_MATCH);

    const result = await lookupAttachmentByChecksum(
      {
        adjunto: { filename: 'manual.pdf', mimeType: 'application/pdf', checksum: CHECKSUM },
        requirementId: REQUIREMENT_ID,
      },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });

    const payload = responder.payloads()[0] as { filter: Record<string, unknown> };
    expect(payload.filter['entityId']).toBe(500);
  });

  // TS-25
  it('asks once, with page.limit 1, without paginating and without count', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    // `page: { limit: 1 }` y NO `limit: 1`: `listPayload()` pliega `limit`/`cursor` dentro de
    // `page`. Afirmar el primer nivel haria fallar el test contra una implementacion correcta.
    const payload = responder.payloads()[0] as Record<string, unknown>;
    expect(payload['page']).toEqual({ limit: 1 });
    expect(payload).not.toHaveProperty('cursor');
    expect(payload).not.toHaveProperty('count');
    expect(payload).not.toHaveProperty('sort');
    expect(responder.count()).toBe(1);
  });

  // TS-26
  it('sends exactly the declared fields and include', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const payload = responder.payloads()[0] as Record<string, unknown>;
    expect(payload['fields']).toEqual(['fileId']);
    // `include: ['checksum']` va aunque el checksum viaje ya en el `filter`, y NO es redundante:
    // `include` decide QUE VUELVE, `filter` decide QUE FILAS. Hace la fila autoverificable.
    expect(payload['include']).toEqual(['checksum']);
  });

  // TS-22
  it('never tries to override the resource fixed predicate', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, SIN_MATCH);

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    // Las DOS EXCLUSIONES PERMANENTES del recurso (el vinculo borrado y el archivo no retenido) no
    // se pueden sobrescribir desde el payload, y el conector NO LO INTENTA: un vinculo borrado
    // produce `items: []` y el archivo se sube de nuevo. No se puede reusar NI EQUIVOCANDOSE.
    expect(result).toEqual({ tipo: 'sin_match' });

    const payload = responder.payloads()[0] as { filter: Record<string, unknown> };
    expect(payload.filter).not.toHaveProperty('byteStatus');
    expect(payload.filter).not.toHaveProperty('deletedAt');
  });

  // TS-27
  it('lets the SDK build the query subject', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    // El subject OBSERVADO en el bus, no reconstruido por el codigo de produccion. Es la prueba de
    // que `client.list('attachments', ...)` deriva `attachments.list` y el subject completo, y de
    // que el comodin del responder cubre lo que tiene que cubrir.
    expect(responder.subjects()).toEqual([
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-queries.v1.${METHOD}`,
    ]);
  });

  // TS-12
  it('degrades to sin_match on query_timeout, with a warn and its diagnosis', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, {
      status: 'failure',
      errorCode: 'query_timeout',
      errorMessage: 'the read timed out',
    });

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });

    // `warn` y NO `error`: el resultado del mail sigue siendo correcto (el adjunto llega, el
    // comentario se publica). Solo se perdio una optimizacion.
    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      checksum: CHECKSUM,
      requirementId: REQUIREMENT_ID,
      // `query_timeout` es un codigo NUEVO para este conector y cae, correctamente, en
      // `core_rechazo_desconocido`. `diagnosePublishFailure()` NO gana una rama por el (CA-6).
      diagnosis: 'core_rechazo_desconocido',
      sdkErrorClass: 'JikuFailure',
      code: 'query_timeout',
      resultado: 'consulta_fallida',
    });
    expect(capture.lines().filter((line) => line['level'] === 'error')).toEqual([]);
  });

  // TS-14
  it('classifies invalid_fields as a connector bug', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, {
      status: 'failure',
      errorCode: 'invalid_fields',
    });

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });

    // `core_rechazo_por_forma` es el diagnostico que nombra el bug: el filtro se desalineo del
    // whitelist del recurso. Apareceria en la PRIMERA corrida, en cada adjunto de cada respuesta —
    // mucho log, cero perdida.
    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      diagnosis: 'core_rechazo_por_forma',
      code: 'invalid_fields',
      resultado: 'consulta_fallida',
    });
  });

  // TS-15
  it.each(['caller_not_authorized', 'unknown_caller'])(
    'classifies %s as a role rejection',
    async (errorCode) => {
      const capture = createLogCapture();
      responder = await respondToQuery(bus.connection, METHOD, { status: 'failure', errorCode });

      const result = await lookupAttachmentByChecksum(
        { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
        { client: bus.client, logger: loggerFor(capture) },
      );

      expect(result).toEqual({ tipo: 'sin_match' });

      // Los dos COMPARTEN diagnostico porque comparten arreglo: la fila ausente en `users` se
      // corrige sola al reconectar.
      const warns = capture.lines().filter((line) => line['level'] === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({
        diagnosis: 'core_rechazo_por_rol',
        code: errorCode,
        resultado: 'consulta_fallida',
      });
    },
  );

  // TS-16
  it('degrades when nobody answers the query (JikuTimeout)', async () => {
    const capture = createLogCapture();
    // MUTE: recibe y NO responde. Distinto de no tener responder, que produce `JikuNoEndpoint` de
    // inmediato — y por eso los dos casos son tests separados.
    responder = await respondToQuery(bus.connection, METHOD, MUTE);

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });
    // El mensaje SI llego a la red: es lo que distingue este caso de un error local.
    expect(responder.count()).toBe(1);

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      diagnosis: 'nada_respondio',
      sdkErrorClass: 'JikuTimeout',
      resultado: 'consulta_fallida',
    });
    // SIN clave `code`: no hubo reply de `core`, asi que `codeOf()` devuelve `undefined` y el
    // spread condicional omite la clave en vez de dejarla vacia.
    expect(warns[0]).not.toHaveProperty('code');
  });

  // TS-17
  it('degrades when the query plane has no endpoint (JikuNoEndpoint)', async () => {
    const capture = createLogCapture();
    // NINGUN responder suscripto: el `afterEach` del caso anterior ya dio de baja el suyo.
    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(result).toEqual({ tipo: 'sin_match' });

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      diagnosis: 'bus_sin_endpoint',
      sdkErrorClass: 'JikuNoEndpoint',
      resultado: 'consulta_fallida',
    });
  });

  // TS-18
  it('degrades on an unreadable success whose data is not a collection', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, {
      status: 'success',
      data: { foo: 'bar' },
    });

    const result = await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    // La SEPTIMA forma de fallar, la que NO esta en los seis codigos del contrato:
    // `client.list()` valida la forma de la respuesta y lanza `JikuError` generico. No es ninguna
    // de las cinco clases que `diagnosePublishFailure()` distingue, asi que cae en `desconocido` —
    // y eso es CORRECTO, no requiere ninguna rama nueva (CA-6).
    expect(result).toEqual({ tipo: 'sin_match' });

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      diagnosis: 'desconocido',
      sdkErrorClass: 'JikuError',
      resultado: 'consulta_fallida',
    });
  });

  // TS-23
  it('logs the four fields of a reuse and none of the forbidden ones', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, conMatch());

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const infos = capture.lines().filter((line) => line['level'] === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      checksum: CHECKSUM,
      requirementId: REQUIREMENT_ID,
      fileId: 1000,
      resultado: 'reusado',
    });

    // Sobre el STRING SERIALIZADO, no sobre el objeto parseado: un secreto puede filtrarse por un
    // campo inesperado que el objeto no delata. El `checksum` SI va —es un hash, no el byte— y es
    // el dato que cruza este log con el de `core`.
    const raw = capture.raw().join('\n');
    expect(raw).toContain(CHECKSUM);
    // Ningun campo se llama `key`: `REDACT_PATHS` lo redactaria en SILENCIO, sin fallar ni avisar.
    expect(raw).not.toMatch(/"key"\s*:/);
    expect(raw).not.toMatch(/"content"\s*:/);
    expect(raw).not.toMatch(/"body"\s*:/);
    expect(raw).not.toMatch(/"text"\s*:/);
  });

  // TS-24
  it('logs a sin_match without a fileId, because there is none', async () => {
    const capture = createLogCapture();
    responder = await respondToQuery(bus.connection, METHOD, SIN_MATCH);

    await lookupAttachmentByChecksum(
      { adjunto: ADJUNTO, requirementId: REQUIREMENT_ID },
      { client: bus.client, logger: loggerFor(capture) },
    );

    const infos = capture.lines().filter((line) => line['level'] === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      checksum: CHECKSUM,
      requirementId: REQUIREMENT_ID,
      resultado: 'sin_match',
    });
    expect(infos[0]).not.toHaveProperty('fileId');
  });
});
