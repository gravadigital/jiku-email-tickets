import {
  JikuFailure,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuTimeout,
} from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { PublishError, diagnosePublishFailure } from '#domain/publicacion/publish-errors.js';
import { publishVerificationRequirement } from '#domain/publicacion/publish-requirement.js';
import { buildVerificationPayload } from '#domain/publicacion/verification-payload.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondTo } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-15 a TS-22, TS-26 y TS-34: las ocho situaciones de error CONTRA EL BUS REAL.
 *
 * La regla dura de la convencion `testing` gobierna este archivo: cada clase de error del SDK
 * manejada en produccion tiene su test que afirma el diagnostico que produce — "el valor de ADR-006
 * es el mapeo, y UN MAPEO NO TESTEADO NO ES UN MAPEO".
 *
 * Estos tests son distintos de los de `diagnose.test.ts` y ninguno cubre al otro: alla se le pasan
 * al traductor instancias CONSTRUIDAS A MANO de cada clase; aca se verifica que las clases que el
 * SDK REALMENTE PRODUCE en cada situacion son las que el traductor espera. La segunda es la que se
 * rompe si el SDK cambia.
 *
 * NINGUN test de este archivo espera 15 segundos: el de `JikuTimeout` inyecta un timeout corto por
 * `options` DESDE EL TEST (nunca desde produccion), y el 15000 se afirma por separado sobre la
 * configuracion y el cliente.
 */

const COMMAND = 'requirements.new';

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

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

/** Publica y devuelve el `PublishError` mas las lineas capturadas. */
async function publishExpectingFailure(
  projectId = 7,
): Promise<{ error: PublishError; capture: LogCapture }> {
  const capture = createLogCapture();

  const error = await publishVerificationRequirement({
    client: bus.client,
    projectId,
    logger: loggerFor(capture),
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(PublishError);
  return { error: error as PublishError, capture };
}

/** La linea de fallo, que es la unica `error` que emite la funcion. */
function failureLine(capture: LogCapture): Record<string, unknown> {
  const line = capture.lines().find((entry) => entry['level'] === 'error');
  expect(line, 'a failure must leave exactly one error line').toBeDefined();
  return line as Record<string, unknown>;
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

describe('publishVerificationRequirement error translation', () => {
  // TS-16
  it('translates JikuNoEndpoint immediately, without waiting for the timeout', async () => {
    // NINGUN responder suscripto: el bus contesta de inmediato que nada escucha. Medido: 11 ms, no
    // los 15 s del timeout. Es lo que hace testeable a CA-12 sin un test de 15 segundos, y confirma
    // como COMPORTAMIENTO OBSERVABLE la afirmacion del flow de que se loguea sin esperar.
    const started = Date.now();
    const { error, capture } = await publishExpectingFailure();
    const elapsed = Date.now() - started;

    expect(error.diagnosis).toBe('bus_sin_endpoint');
    expect(error.sdkErrorClass).toBe('JikuNoEndpoint');
    expect(elapsed).toBeLessThan(2000);

    const line = failureLine(capture);
    expect(line['diagnosis']).toBe('bus_sin_endpoint');
    expect(line['sdkErrorClass']).toBe('JikuNoEndpoint');
    // El bus rechazo: `core` nunca vio nada, asi que el plano de escritura no quedo probado.
    expect(line['planoDeEscrituraAbierto']).toBe(false);
  });

  // TS-15
  it('translates JikuTimeout when a responder receives and never answers', async () => {
    // Responder MUDO: el mensaje llega —asi que el contador prueba que SI llego a la red— y nadie
    // contesta. El timeout se inyecta corto POR `options` DESDE EL TEST: verificar los 15 s
    // literales sumaria 15 segundos de suite por un numero que ya esta afirmado mas barato
    // (`client.timeoutMs === 15_000` y el piso del schema). Son dos aserciones distintas y ninguna
    // cubre a la otra.
    responder = await respondTo(bus.connection, COMMAND, MUTE);

    const error = await bus.client
      .command(COMMAND, buildVerificationPayload(7), { timeoutMs: 250 })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(JikuTimeout);
    // Llego a la red exactamente UNA vez: sin reintento.
    expect(responder.count()).toBe(1);

    // Y el TRADUCTOR mapea la clase que el SDK produjo de verdad. El diagnostico se DERIVA con
    // `diagnosePublishFailure()` en vez de pasarse como literal: pasarlo a mano afirmaria que el
    // constructor guarda lo que se le da —que ya se sabe— en vez de que el traductor reconoce esta
    // clase. Esa es justamente la afirmacion que se rompe si el SDK cambia.
    expect(diagnosePublishFailure(error)).toBe('nada_respondio');

    const translated = new PublishError(diagnosePublishFailure(error), error);
    expect(translated.diagnosis).toBe('nada_respondio');
    expect(translated.sdkErrorClass).toBe('JikuTimeout');
    expect(translated.planoDeEscrituraAbierto).toBe(false);
    expect(translated.logContext(7)['diagnosis']).toBe('nada_respondio');
  });

  // TS-17
  it('translates JikuInvalidRequest for actor, rejected locally without touching the wire', async () => {
    // H3: `actor` es la UNICA clave prohibida del plano de escritura, y el SDK la rechaza
    // LOCALMENTE en `checkNoIdentityFields()` antes de publicar.
    //
    // Este caso NO pasa por `publishVerificationRequirement()`, y no puede: el payload que el
    // conector arma nunca lleva `actor` (esa es justamente la garantia de CA-3). Es un test DEL
    // CONTRATO DEL SDK, no de la funcion del conector, y por eso se nombra asi.
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 1 } });

    const error = await bus.client
      .command(COMMAND, { ...buildVerificationPayload(7), actor: 'x' })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(JikuInvalidRequest);
    // CERO mensajes: nada llego a la red. Es la afirmacion que distingue este caso de un rechazo
    // del bus, que si viaja.
    expect(responder.count()).toBe(0);

    // Igual que en TS-15: el diagnostico se DERIVA de la clase real que lanzo el SDK, no se pasa
    // como literal.
    expect(diagnosePublishFailure(error)).toBe('error_de_armado_del_conector');

    const translated = new PublishError(diagnosePublishFailure(error), error);
    expect(translated.diagnosis).toBe('error_de_armado_del_conector');
    expect(translated.sdkErrorClass).toBe('JikuInvalidRequest');
    expect(translated.planoDeEscrituraAbierto).toBe(false);
  });

  // TS-18
  it('translates caller_not_authorized as core refusing by ROLE, not by payload', async () => {
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
      errorMessage: 'el caller no esta autorizado',
    });

    const { error, capture } = await publishExpectingFailure();

    expect(error.cause).toBeInstanceOf(JikuFailure);
    expect(error.errorCode).toBe('caller_not_authorized');
    expect(error.diagnosis).toBe('core_rechazo_por_rol');

    const line = failureLine(capture);
    expect(line['diagnosis']).toBe('core_rechazo_por_rol');
    expect(line['code']).toBe('caller_not_authorized');
    // `hint` presente y no vacio: es uno de los codigos que el catalogo del SDK si cubre.
    expect(typeof line['hint']).toBe('string');
    expect((line['hint'] as string).length).toBeGreaterThan(0);
    // `core` contesto, asi que el bus dejo pasar: informacion POSITIVA.
    expect(line['planoDeEscrituraAbierto']).toBe(true);

    // Y el mensaje NO manda a revisar el payload, que es el peor desvio posible para este caso:
    // el arreglo es la fila en `users`, y reconectar lo corrige solo.
    expect(error.message).toMatch(/RECONECTAR LO CORRIGE SOLO/i);
    expect(error.message).toMatch(/No revises el payload/i);
  });

  // TS-19
  it('translates invalid_fields as core refusing the SHAPE, proving the write plane is open', async () => {
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'invalid_fields',
      errorMessage: 'title requerido',
    });

    const { error, capture } = await publishExpectingFailure();

    expect(error.errorCode).toBe('invalid_fields');
    expect(error.diagnosis).toBe('core_rechazo_por_forma');

    const line = failureLine(capture);
    expect(line['diagnosis']).toBe('core_rechazo_por_forma');
    expect(line['code']).toBe('invalid_fields');
    expect(line['planoDeEscrituraAbierto']).toBe(true);
    expect(typeof line['hint']).toBe('string');
    // El mensaje que mando `core`, verbatim y sin parsear.
    expect(line['errorMessage']).toBe('title requerido');
  });

  // TS-20
  it('translates project_not_found logging the projectId used, and never retries', async () => {
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'project_not_found',
      errorMessage: 'no existe el proyecto 99',
    });

    const { error, capture } = await publishExpectingFailure(99);

    expect(error.errorCode).toBe('project_not_found');
    expect(error.diagnosis).toBe('core_rechazo_por_forma');

    const line = failureLine(capture);
    expect(line['diagnosis']).toBe('core_rechazo_por_forma');
    expect(line['code']).toBe('project_not_found');
    // CA-9 lo pide explicitamente: el `projectId` USADO, que es el dato que cruza este log con el
    // de `core`.
    expect(line['projectId']).toBe(99);
    expect(line['planoDeEscrituraAbierto']).toBe(true);

    // UN solo mensaje: no se reintenta.
    expect(responder.count()).toBe(1);
  });

  // TS-21
  it('omits the hint for project_not_found instead of inventing one', async () => {
    // H2: `hint()` devuelve `undefined` para `project_not_found` — su catalogo no lo cubre. CA-9
    // pide loguear "su hint()", y lo honesto es OMITIR el campo: un `hint: null` sugiere que el SDK
    // contesto algo cuando no contesto nada. Lo que viaja en su lugar es `code` + `errorMessage`, y
    // ESE es el dato de diagnostico real acá.
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'project_not_found',
      errorMessage: 'no existe el proyecto 99',
    });

    const { capture } = await publishExpectingFailure(99);
    const line = failureLine(capture);

    expect('hint' in line).toBe(false);
    expect(line['errorMessage']).toBe('no existe el proyecto 99');
  });

  // TS-22
  it('logs an unknown errorCode with its code and maps it to no known case', async () => {
    // El catalogo del SDK NO ES CERRADO: `core` lo posee y lo hace crecer. Un codigo desconocido es
    // un resultado NORMAL Y ESPERADO, no un caso residual.
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'flux_capacitor_offline',
      errorMessage: 'raro',
    });

    const { error, capture } = await publishExpectingFailure();

    expect(error.errorCode).toBe('flux_capacitor_offline');
    expect(error.diagnosis).toBe('core_rechazo_desconocido');

    const line = failureLine(capture);
    expect(line['code']).toBe('flux_capacitor_offline');
    expect(line['diagnosis']).toBe('core_rechazo_desconocido');
    // NO se mapea a ninguno de los casos conocidos.
    expect(line['diagnosis']).not.toBe('core_rechazo_por_rol');
    expect(line['diagnosis']).not.toBe('core_rechazo_por_forma');
    expect(line['diagnosis']).not.toBe('rechazo_del_bus_por_subject');
    // Sin `hint` (H2: el default del catalogo devuelve undefined), pero con el mensaje de `core`.
    expect('hint' in line).toBe(false);
    expect(line['errorMessage']).toBe('raro');
  });

  // TS-26
  it('never retries: exactly one message on the wire for every failure that reaches it', async () => {
    // La afirmacion que ningun resultado observable de la funcion daria: un reintento silencioso
    // produciria el mismo error final. Solo el contador del responder lo detecta.
    for (const errorCode of ['caller_not_authorized', 'invalid_fields', 'project_not_found', 'flux_capacitor_offline']) {
      const local = await respondTo(bus.connection, COMMAND, { status: 'failure', errorCode });

      await publishExpectingFailure();

      expect(local.count(), `${errorCode} must be published exactly once`).toBe(1);
      await local.stop();
    }
  });

  // TS-34
  it('never dumps the payload, the title or the description on any failure', async () => {
    for (const errorCode of ['caller_not_authorized', 'invalid_fields', 'project_not_found', 'flux_capacitor_offline']) {
      const local = await respondTo(bus.connection, COMMAND, { status: 'failure', errorCode });

      const { capture } = await publishExpectingFailure();

      // Sobre el string CRUDO: es la unica forma de detectar una filtracion por un campo
      // inesperado. Sobre el objeto parseado no se puede.
      const raw = capture.raw().join('\n');
      expect(raw, `${errorCode} must not leak the description`).not.toContain(
        '[verificacion de despliegue]',
      );
      expect(raw, `${errorCode} must not carry a payload key`).not.toMatch(
        /"(payload|title|description)"\s*:/,
      );

      await local.stop();
    }
  });

  it('produces a distinct diagnosis for the bus and for core, on the real bus', async () => {
    // El eje entero del entregable: sin responder es EL BUS el que contesta; con responder que
    // rechaza es CORE. Los dos diagnosticos tienen que ser distintos, porque los arreglos estan en
    // sistemas distintos.
    const { error: busRefusal } = await publishExpectingFailure();

    const local = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });
    const { error: coreRefusal } = await publishExpectingFailure();
    await local.stop();

    expect(busRefusal.diagnosis).not.toBe(coreRefusal.diagnosis);
    expect(busRefusal.planoDeEscrituraAbierto).toBe(false);
    expect(coreRefusal.planoDeEscrituraAbierto).toBe(true);
  });
});
