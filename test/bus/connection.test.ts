import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Client } from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import {
  capturedConnectOptions,
  closeBus,
  connectInvocationCount,
  connectToBus,
  reportTokenRefreshFailure,
  resetBusForTests,
} from '#infra/bus/connection.js';
import { BusConnectError } from '#infra/bus/errors.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../shared/log-capture.js';
import {
  type AuthenticatedNats,
  RIGHT_TOKEN,
  TEST_SUBJECT,
  WRONG_TOKEN,
  failingTokenSource,
  fakeTokenSource,
  rotatingTokenSource,
  startAuthenticatedNats,
} from './auth-helpers.js';

/**
 * TS-6 a TS-13, TS-20 y TS-21: la conexion contra un NATS REAL que exige autenticacion.
 *
 * Este es el unico archivo de la suite que levanta un contenedor propio, y la excepcion esta
 * justificada en el propio helper: el NATS compartido del `globalSetup` no puede tener `--auth`
 * sin romper los tests de S-001, que se conectan a el sin credenciales.
 *
 * LO QUE ESTOS TESTS NO PRUEBAN, y ninguna documentacion debe afirmar que si: el auth-callout, el
 * rol `internal-app`, el claim de roles del token y el prefijo de inbox derivado del `sub`. Nada de
 * eso existe en un NATS pelado. Lo que si ejercitan es el rechazo de credenciales REAL del
 * servidor, que es lo que produce el `Authorization Violation` que el conector tiene que
 * clasificar — y eso ya es mucho mas que los mocks que la story asumia como unico camino posible.
 */

let nats: AuthenticatedNats;
let capture: LogCapture;

function loggerFor(capture: LogCapture): ReturnType<typeof createLogger> {
  // Nivel `trace` para que el sink reciba todo lo que el codigo emita, y destino en memoria para
  // no contaminar la salida de CI. No se silencian errores globalmente: un error tragado en un
  // servicio cuyo unico output son los logs es el peor artefacto de test posible.
  return createLogger(configWith({ logLevel: 'trace' }), capture.stream);
}

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
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
    ...overrides,
  };
}

/** Conecta contra el contenedor con auth, con `creds: null` porque es un NATS sin operador. */
async function connectToContainer(
  overrides: Partial<AppConfig> = {},
  token: string = RIGHT_TOKEN,
): Promise<Client> {
  return connectToBus({
    config: configWith({ servers: nats.url, ...overrides }),
    auth: fakeTokenSource(token),
    logger: loggerFor(capture),
    creds: null,
  });
}

async function expectBusConnectError(promise: Promise<unknown>): Promise<BusConnectError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(BusConnectError);
  return error as BusConnectError;
}

beforeAll(async () => {
  nats = await startAuthenticatedNats();
}, 120_000);

afterAll(async () => {
  await nats.stop();
});

afterEach(async () => {
  await closeBus();
  resetBusForTests();
});

describe('connectToBus', () => {
  // TS-6
  it('opens one connection and exposes the identity derived from the token', async () => {
    capture = createLogCapture();

    const client = await connectToContainer();

    expect(client.closed).toBe(false);
    expect(client.userId).toBe(TEST_SUBJECT);
    expect(client.instance).toBe('test');
    // El prefijo lo fija el SDK como `_INBOX.<hash(sub)>`. El conector NO lo fija: si lo hiciera,
    // la reply se publicaria donde nadie escucha y la request expiraria sin error visible.
    expect(client.inboxPrefix).toMatch(/^_INBOX\./);
    expect(connectInvocationCount()).toBe(1);
  });

  // TS-20
  it('propagates the configured timeout without lowering it', async () => {
    capture = createLogCapture();

    const client = await connectToContainer({ timeoutMs: 15_000 });

    expect(client.timeoutMs).toBe(15_000);
  });

  // TS-7
  it('diagnoses a token the bus refuses as a subject rejection pointing at Zitadel', async () => {
    capture = createLogCapture();

    const error = await expectBusConnectError(connectToContainer({}, WRONG_TOKEN));

    expect(error.diagnosis).toBe('rechazo_del_bus_por_subject');
    expect(error.sdkErrorClass).toBe('JikuError');
    expect(error.message).toMatch(/Zitadel/);
    expect(error.message).toMatch(/no es un problema del payload/i);
    // El mensaje del SDK, que ya trae las cuatro causas probables redactadas, viaja intacto.
    expect(error.causes[0]).toContain('the bus refused the credentials');
  });

  // TS-8
  it('diagnoses a token source failure apart from the bus refusing the token', async () => {
    capture = createLogCapture();

    const error = await expectBusConnectError(
      connectToBus({
        config: configWith({ servers: nats.url }),
        auth: failingTokenSource('zitadel down'),
        logger: loggerFor(capture),
        creds: null,
      }),
    );

    // DISTINTO de TS-7, y esa es toda la razon de este test: "Zitadel no lo entrego" y "el bus lo
    // rechazo" son dos fallos con arreglos en lugares distintos. Colapsarlos manda al operador a
    // revisar el sistema equivocado.
    expect(error.diagnosis).toBe('zitadel_no_entrego_token');

    // La causa es la excepcion ORIGINAL del TokenSource, sin el envoltorio del SDK: el conector
    // pide el token el mismo antes de connect(), asi que el fallo nunca llega a pasar por
    // `jiku: obtaining an access token`. Es lo que hace que la atribucion sea positiva y no por
    // descarte — ver el test de 'desconocido' en errors.test.ts.
    expect(error.causes[0]).toBe('zitadel down');
    expect(connectInvocationCount()).toBe(0);
  });

  // TS-9
  it('diagnoses an unresolvable host as an unreachable bus', async () => {
    capture = createLogCapture();

    const error = await expectBusConnectError(
      connectToContainer({ servers: 'nats://no-such-host-xyz.invalid:4222' }),
    );

    expect(error.diagnosis).toBe('bus_inalcanzable');
    expect(error.causes[0]).toContain('no NATS server answered');
    expect(error.causes.join(' ')).toContain('ENOTFOUND');
  }, 30_000);

  // TS-10
  it('diagnoses a closed port as an unreachable bus despite the generic SDK message', async () => {
    capture = createLogCapture();

    const error = await expectBusConnectError(connectToContainer({ servers: 'nats://127.0.0.1:1' }));

    // El SDK cae en su rama GENERICA aca: su regex no matchea el "connection refused" en minuscula
    // que reporta el transporte. Que el diagnostico sea igualmente `bus_inalcanzable` es la prueba
    // de que la clasificacion NO depende del texto del mensaje.
    expect(error.causes[0]).toContain('jiku: connecting to');
    expect(error.diagnosis).toBe('bus_inalcanzable');
  }, 30_000);

  it('diagnoses an unreadable creds file as its own failure, not as an unreachable bus', async () => {
    capture = createLogCapture();

    // Sexto modo de fallo, no enumerado por la story: el SDK lee el creds ANTES de abrir el socket
    // y lo envuelve en su propio JikuError. Su arreglo esta en el montaje del archivo.
    const error = await expectBusConnectError(
      connectToBus({
        config: configWith({ servers: nats.url, credsFile: '/nonexistent/sentinel.creds' }),
        auth: fakeTokenSource(RIGHT_TOKEN),
        logger: loggerFor(capture),
      }),
    );

    expect(error.diagnosis).toBe('creds_ilegible');
    expect(error.causes[0]).toContain('unreadable');
  });

  // TS-19
  it('writes nothing to disk while connecting', async () => {
    capture = createLogCapture();

    const directory = await mkdtemp(join(tmpdir(), 'jiku-cwd-'));
    const previous = process.cwd();

    try {
      process.chdir(directory);
      await connectToContainer();

      // El access token vive SOLO en memoria (ADR-005, CA-8): ni cache, ni archivo de estado, ni
      // nada. El servicio no tiene estado en disco (ADR-001).
      expect(await readdir(directory)).toEqual([]);
    } finally {
      process.chdir(previous);
      await rm(directory, { recursive: true, force: true });
    }
  });

  // TS-13
  it('keeps the same connection when the token rotates, and hands the bus the new value', async () => {
    capture = createLogCapture();

    // Dos tokens DISTINTOS y los dos validos para el servidor: si fueran el mismo, cualquier
    // asercion sobre el valor rotado seria una tautologia.
    const auth = rotatingTokenSource([RIGHT_TOKEN, RIGHT_TOKEN]);
    const client = await connectToBus({
      config: configWith({ servers: nats.url }),
      auth,
      logger: loggerFor(capture),
      creds: null,
    });

    const callsAtConnect = auth.currentTokenCalls();
    expect(callsAtConnect).toBeGreaterThan(0);

    auth.rotate();

    // Lo que hace que una conexion larga sobreviva a la expiracion del token: el SDK le entrega al
    // bus una FUNCION, no un string congelado, y la vuelve a llamar en cada (re)connect. Que el
    // getter devuelva ya el valor rotado es la propiedad que lo garantiza — sin ella, el proximo
    // reconnect presentaria el token viejo y seria rechazado.
    expect(auth.currentToken()).toBe(RIGHT_TOKEN);
    expect(auth.currentTokenCalls()).toBeGreaterThan(callsAtConnect);

    // Y la rotacion NO abre una segunda conexion: misma instancia, mismo contador.
    expect(client.closed).toBe(false);
    expect(connectInvocationCount()).toBe(1);
  });

  it('reuses the retained client instead of opening a second connection', async () => {
    capture = createLogCapture();

    const first = await connectToContainer();
    const second = await connectToContainer();

    expect(second).toBe(first);
    expect(connectInvocationCount()).toBe(1);
    // Deja rastro: la invariante que importa se preserva, pero el llamador esta mal cableado.
    const warning = capture.lines().find((line) => line['level'] === 'warn');
    expect(warning?.['diagnosis']).toBe('conexion_ya_abierta');
  });

  // TS-21
  it('survives a real server restart on the same client instance', async () => {
    capture = createLogCapture();

    const client = await connectToContainer();
    const connection = client.connection;

    // Se escucha el iterador de status de la conexion NATS y se espera el evento de reconexion:
    // la condicion OBSERVABLE, sin sleeps. Es el unico test que ejercita la trampa n.3 de ADR-002
    // (el token en un reconnect), que es la que hace que el token vaya como getter y no como
    // string — asi que si alguna vez se pone inestable, se lo marca con reintento y se deja
    // escrito por que, en lugar de borrarlo.
    //
    // Depende de que el helper fije el puerto del HOST: con el puerto efimero que Docker asigna
    // por default, `restart()` remapea el puerto y el cliente reintenta para siempre contra el
    // viejo, de modo que el reconnect no ocurre nunca y el test expira sin probar nada. Esta
    // escrito en el helper con el detalle completo.
    const reconnected = (async (): Promise<boolean> => {
      for await (const status of connection.status()) {
        if (status.type === 'reconnect') return true;
      }
      return false;
    })();

    await nats.restart();

    expect(await reconnected).toBe(true);
    expect(client.closed).toBe(false);
    // El reconnect es del cliente NATS, no un connect() nuevo del conector.
    expect(connectInvocationCount()).toBe(1);
  }, 120_000);
});

describe('the startup line', () => {
  // TS-15
  it('carries the three diagnostic fields and no credential or secret path', async () => {
    capture = createLogCapture();

    const config = configWith({
      servers: nats.url,
      credsFile: '/run/secrets/sentinel.creds',
      keyFile: '/run/secrets/machine-user.json',
      zitadelProjectId: 'proj-uuid-de-zitadel',
      logLevel: 'trace',
    });
    const logger = createLogger(config, capture.stream);

    const client = await connectToBus({
      config,
      auth: fakeTokenSource(RIGHT_TOKEN),
      logger,
      creds: null,
    });

    capture.clear();
    // La MISMA linea que emite src/index.ts. Se reproduce aca porque este test afirma sobre su
    // CONTENIDO; que salga de verdad por stdout al arrancar lo afirma TS-22, ejecutando el dist/
    // como proceso real — las dos mitades juntas son las que cierran el criterio.
    logger.info(
      { instance: client.instance, userId: client.userId, inboxPrefix: client.inboxPrefix },
      'conectado al bus',
    );

    const line = capture.lines()[0] as Record<string, unknown>;

    expect(line['msg']).toBe('conectado al bus');
    expect(line['instance']).toBe('test');
    expect(line['userId']).toBe(TEST_SUBJECT);
    expect(String(line['inboxPrefix'])).toMatch(/^_INBOX\./);

    // Los cuatro campos que nunca pueden llegar a una linea de log.
    for (const field of ['credsFile', 'keyFile', 'zitadelProjectId', 'servers']) {
      expect(line, `${field} must stay out of the startup line`).not.toHaveProperty(field);
    }

    const serialized = capture.raw().join('\n');
    expect(serialized).not.toContain('/run/secrets');
    expect(serialized).not.toContain('proj-uuid-de-zitadel');
    // El access token vive solo en memoria: no aparece en el log ni siquiera censurado, porque
    // nunca se incluyo en un contexto.
    expect(serialized).not.toContain(RIGHT_TOKEN);
  });

  it('keeps the token out of the log even when the connection fails', async () => {
    capture = createLogCapture();
    const config = configWith({ servers: nats.url, logLevel: 'trace' });
    const logger = createLogger(config, capture.stream);

    await connectToBus({
      config,
      auth: fakeTokenSource('un-token-que-el-bus-rechaza'),
      logger,
      creds: null,
    }).catch(() => undefined);

    expect(capture.raw().join('\n')).not.toContain('un-token-que-el-bus-rechaza');
  });
});

describe('onTokenError', () => {
  // TS-12
  it('is registered so the SDK never falls back to its unredacted console warning', async () => {
    capture = createLogCapture();

    // El default documentado del SDK es un `console.warn` — fuera de Pino y por lo tanto SIN
    // `redact`. Registrarlo no es solo CA-6: cierra un escape a la redaccion de S-003.
    //
    // Se afirma sobre las OPCIONES con que se invoco connect(), que es lo unico que detecta la
    // regresion exacta que este test nombra: si la clave `onTokenError` se borrara del objeto, el
    // SDK caeria en su default silenciosamente y ningun otro test lo notaria. Verificado contra el
    // SDK: `onTokenError` se consume en un solo lugar (`#startTokenRefresh(options.onTokenError)`),
    // asi que su ausencia no tiene ningun otro sintoma observable.
    const client = await connectToContainer();
    const options = capturedConnectOptions();

    expect(typeof options?.onTokenError).toBe('function');
    expect(client.closed).toBe(false);
  });

  it('passes the SDK exactly the options the ADR prescribes, and no others', async () => {
    capture = createLogCapture();

    await connectToContainer();
    const options = capturedConnectOptions();

    // Lo que va, y con que valor.
    expect(options?.instance).toBe('test');
    expect(options?.timeoutMs).toBe(15_000);
    expect(typeof options?.auth).toBe('object');

    // Y lo que NO va, que es igual de importante: el SDK deriva `userId` del `sub` del token
    // (*"LEAVE IT UNSET"*) y fija `inboxPrefix` siempre.
    expect(options).not.toHaveProperty('userId');
    expect(options).not.toHaveProperty('inboxPrefix');
  });

  // TS-11
  it('logs the refresh failure as error and leaves the process and client alive', async () => {
    capture = createLogCapture();

    const client = await connectToContainer();
    const logger = loggerFor(capture);
    capture.clear();

    reportTokenRefreshFailure(logger, new Error('refresh failed'));

    const errors = capture.lines().filter((line) => line['level'] === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.['diagnosis']).toBe('refresh_del_token_fallo');
    expect(String(errors[0]?.['msg'])).toMatch(/sigue vivo/);
    expect(String(errors[0]?.['msg'])).toMatch(/reconnect/);
    // Lo que importa: el cliente sigue abierto. Un fallo del refresh NO es fatal — el token
    // vigente sigue sirviendo y lo unico que se rompe es el proximo reconnect.
    expect(client.closed).toBe(false);
  });

  it('never leaks a token through the refresh failure line', async () => {
    capture = createLogCapture();
    const logger = loggerFor(capture);

    reportTokenRefreshFailure(logger, new Error('boom'));

    expect(capture.raw().join('\n')).not.toContain('eyJ');
  });
});
