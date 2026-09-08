import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadEnv } from '#config/env.js';
import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { PublishError } from '#domain/publicacion/publish-errors.js';
import { publishVerificationRequirement } from '#domain/publicacion/publish-requirement.js';
import { buildVerificationPayload } from '#domain/publicacion/verification-payload.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-11 a TS-14, TS-25 y TS-27: la publicacion contra el NATS REAL del contenedor.
 *
 * `publishVerificationRequirement()` toca el bus, asi que por la convencion `testing` es
 * integracion por definicion: no hay unit test de esta funcion y no debe haberlo. El bus NO se
 * mockea — `core` se dobla con un responder EN EL PROPIO TEST, sobre el bus real.
 *
 * LO QUE ESTA SUITE NO PRUEBA, y ninguna documentacion debe afirmar que si:
 * `Client.fromConnection()` SALTEA EL HANDSHAKE DE AUTH. Estos tests cubren la traduccion de las
 * ocho situaciones, pero no prueban nada sobre Zitadel, el rol `internal-app` ni el prefijo de
 * inbox real. Eso solo se verifica contra un despliegue real, y es precisamente por eso que FG-1
 * existe como walking skeleton.
 */

const COMMAND = 'requirements.new';

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
    // Los dos bloques anidados los agrega S-007. Los valores son los de prueba consistentes de toda
    // la suite: TS-34 los busca literalmente en los streams del proceso real.
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

/** Nivel `trace` al sink en memoria: recibe todo lo que el codigo emita y no contamina CI. */
function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  // El `cleanup()` del helper hace `drain()` y no `close()`: con `close()` a secas una reply en
  // vuelo se pierde. Irrelevante en S-001, decisivo aca.
  await bus.cleanup();
});

afterEach(async () => {
  // Se da de baja el responder para que un caso no le conteste al siguiente. Con
  // `fileParallelism: false` y un bus compartido, una suscripcion viva de un test anterior es
  // exactamente la contaminacion cruzada que la ejecucion secuencial busca evitar.
  await responder?.stop();
  responder = undefined;
});

describe('publishVerificationRequirement', () => {
  // TS-11
  it('returns the requirement id and logs it next to the projectId in ONE line', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 42 } });

    const result = await publishVerificationRequirement({
      client: bus.client,
      projectId: 7,
      logger: loggerFor(capture),
    });

    expect(result).toEqual({ requirementId: 42 });

    // CA-1 pide los dos campos EN LA MISMA LINEA: separados en dos lineas obligan a correlacionar
    // por timestamp para encontrar el requisito en Jiku.
    const success = capture
      .lines()
      .filter((line) => line['projectId'] === 7 && line['requirementId'] === 42);

    expect(success).toHaveLength(1);
    expect(success[0]?.['level']).toBe('info');
  });

  // TS-12
  it('lets the SDK build the subject, with the full grammar', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 1 } });

    await publishVerificationRequirement({
      client: bus.client,
      projectId: 7,
      logger: loggerFor(capture),
    });

    // El subject OBSERVADO, no uno reconstruido por el test: el responder se suscribio con comodin
    // justamente para que esta asercion sea sobre la gramatica del SDK y no sobre la del test.
    expect(responder.subjects()).toEqual([
      `${TEST_INSTANCE}.${TEST_USER_ID}.jiku-commands.v1.${COMMAND}`,
    ]);
  });

  // TS-13
  it('puts the validated payload on the wire, with no keys added', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 1 } });

    await publishVerificationRequirement({
      client: bus.client,
      projectId: 7,
      logger: loggerFor(capture),
    });

    // El SDK no agrega nada al cuerpo del comando: el envelope de la REQUEST es el payload tal cual.
    expect(responder.payloads()).toEqual([buildVerificationPayload(7)]);
  });

  // TS-14
  it('keeps the effective command timeout at 15000 ms, floor included', () => {
    // Dos aserciones DISTINTAS y ninguna cubre a la otra: el cliente lleva el default del SDK, y el
    // schema pone el piso que impide bajarlo DESDE EL ENTORNO. Verificarlo asi cuesta 0 ms, mientras
    // provocar un timeout real costaria 15 s de suite por un numero ya afirmado mas barato.
    expect(bus.client.timeoutMs).toBe(15_000);
    expect(MIN_TIMEOUT_MS).toBe(15_000);

    // Y el piso PISA un valor mas bajo declarado en el entorno. Es la mitad de la propiedad que de
    // verdad protege: alguien "optimiza" el timeout a 5 s y convierte los errores explicados de
    // PostgreSQL —que corta a los 8 s— en timeouts mudos. El `.transform()` va despues del
    // `.default()` justamente para que el piso se aplique al valor provisto y al default por igual.
    const lowered = loadEnv({
      JIKU_CREDS: '/run/secrets/sentinel.creds',
      JIKU_KEY_FILE: '/run/secrets/machine-user.json',
      JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
      JIKU_VERIFY_PROJECT_ID: '7',
      JIKU_TIMEOUT: '5000',
      // Requeridas desde S-007: un entorno sin ellas ya no resuelve.
      IMAP_HOST: 'imap.gmail.com',
      IMAP_USER: 'tickets@ejemplo.com',
      IMAP_PASSWORD: 'app-password-de-prueba',
      // Requerida desde S-012, en una de sus dos fuentes.
      TICKET_MAP: '{"alfa":42}',
    });

    expect(lowered.JIKU_TIMEOUT).toBe(15_000);
  });

  // TS-25
  it('does NOT report success when the reply carries no usable id', async () => {
    // H6: `command<T>()` devuelve `reply.data` sin validarlo contra `T`. Sin el schema de respuesta,
    // esto produciria la linea que CA-1 exige con `requirementId: undefined` — formalmente
    // presente, materialmente inutil, y sin que nada falle.
    for (const data of [{}, { id: 'no-es-numero' }]) {
      capture = createLogCapture();
      const local = await respondTo(bus.connection, COMMAND, { status: 'success', data });

      await expect(
        publishVerificationRequirement({
          client: bus.client,
          projectId: 7,
          logger: loggerFor(capture),
        }),
      ).rejects.toBeInstanceOf(PublishError);

      const failure = capture.lines().find((line) => line['level'] === 'error');
      expect(failure?.['diagnosis'], `data ${JSON.stringify(data)}`).toBe('respuesta_ilegible');
      // Y NUNCA una linea de exito con el hueco.
      expect(capture.lines().some((line) => 'requirementId' in line)).toBe(false);

      await local.stop();
    }
  });

  // TS-27
  it('is repeatable with no idempotency: two runs create two requirements', async () => {
    capture = createLogCapture();
    // La secuencia responde `id: 1` a la primera y `id: 2` a la segunda, sin re-suscribir a mitad
    // del test.
    responder = await respondTo(bus.connection, COMMAND, [
      { status: 'success', data: { id: 1 } },
      { status: 'success', data: { id: 2 } },
    ]);

    const logger = loggerFor(capture);
    const first = await publishVerificationRequirement({ client: bus.client, projectId: 7, logger });
    const second = await publishVerificationRequirement({ client: bus.client, projectId: 7, logger });

    expect(first.requirementId).toBe(1);
    expect(second.requirementId).toBe(2);
    expect(responder.count()).toBe(2);

    // Y NINGUNA publicacion de compensacion: el conector no tiene comando para modificar ni borrar
    // un requisito (invariante 9), asi que los dos quedan para siempre. Es una consecuencia
    // aceptada, y la mitigacion es operativa: correr contra un proyecto de prueba.
    for (const subject of responder.subjects()) {
      expect(subject).not.toMatch(/requirements\.(edit|delete|update)/);
    }
    expect(responder.subjects().every((s) => s.endsWith(`.${COMMAND}`))).toBe(true);
  });

  it('publishes exactly once per call, with no retry', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 9 } });

    await publishVerificationRequirement({
      client: bus.client,
      projectId: 7,
      logger: loggerFor(capture),
    });

    expect(responder.count()).toBe(1);
  });

  it('logs neither the payload nor the title nor the description on success', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 3 } });

    await publishVerificationRequirement({
      client: bus.client,
      projectId: 7,
      logger: loggerFor(capture),
    });

    // Sobre el string CRUDO: es la unica forma de detectar una filtracion por un campo inesperado.
    // `title` y `description` NO estan en REDACT_PATHS (verificado), asi que si viajaran no habria
    // nada que los tape.
    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('[verificacion de despliegue]');
    expect(raw).not.toMatch(/"(title|description|payload)"\s*:/);
  });
});
