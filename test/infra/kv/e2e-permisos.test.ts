import { Client } from '@gravadigital/jiku';
import type { NatsConnection } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { KvSpaceUnavailableError } from '#infra/kv/errors.js';
import { openKvSpace } from '#infra/kv/space.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { type CoreResponder, respondTo } from '../../bus/responder.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startPermissionedJetStreamNats, type PermissionedJetStreamNats } from './permission-helpers.js';

/**
 * S-033 Tarea 4 (CA-6 caso 3): el arranque contra un servidor que NIEGA los grants del Espacio KV.
 * TS-12, TS-13 y TS-14 del Story Plan de S-033.
 *
 * # POR QUE ES LA PRIMERA VEZ (Hallazgo 2 del Story Plan)
 *
 * El rechazo de permisos del servidor nunca se habia probado contra un `nats-server` real, ni
 * siquiera en el SDK: su test de integracion corre contra un servidor sin permisos, y el
 * `JikuKVPermissionDenied` de sus unit tests se construye con un `PermissionViolationError`
 * fabricado. Aca el servidor rechaza de verdad, `nats-core` rechaza el request en vuelo cuyo
 * subject coincide con el del `-ERR 'Permissions Violation'`, el SDK lo convierte en
 * `JikuKVPermissionDenied` con el subject y los grants, y el conector lo diagnostica por CLASE.
 *
 * # QUE NO PRUEBA
 *
 * Los permisos son ESTATICOS (`permission-helpers.ts`): no hay auth-callout, ni plantilla real de
 * `internal-app`, ni `{{user_id}}` reemplazado por el `sub` de un token. Que la plantilla real tenga
 * los tres grants lo verifica U-02 contra el despliegue (Parte 2 de `verificacion-e2e-manual.md`).
 *
 * # POR QUE UN CONTENEDOR PROPIO
 *
 * El compartido no puede tener usuarios con permisos sin romper a todos los que se conectan sin
 * credenciales. Es la tercera excepcion autorizada a "un contenedor por suite", con la misma forma
 * que `test/bus/auth-helpers.ts` y `test/infra/kv/helpers.ts`, en el `beforeAll` de ESTE archivo.
 *
 * # POR QUE `timeoutMs: 2_000` EN EL CLIENTE DE TEST
 *
 * Si el servidor entregara el rechazo como un timeout y no como una violacion, el diagnostico seria
 * `desconocido` tras `timeoutMs`. Con 2 s la falla es rapida y legible. Es el timeout del CLIENTE DE
 * TEST (`Client.fromConnection`), no el del conector: la regla de los 15000 ms (ADR-002) es del
 * codigo de produccion y no cambia.
 *
 * Como en `e2e-kv.test.ts`, NO se invoca `runStartup()` (pide el token a Zitadel antes de abrir el
 * socket): el encadenado se arma con `openKvSpace()` y `reportStartupFailure()`, las dos piezas
 * reales del arranque, sobre un `Client.fromConnection()`.
 */

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
    allowedExtensions: ['.png', '.pdf', '.txt'],
    allowedMimeTypes: ['image/png', 'application/pdf'],
    maxSizeBytes: 10_485_760,
    putTimeoutMs: 30_000,
  },
};

const FATAL_MESSAGE = 'el arranque fallo: el espacio KV no esta usable';

/** El capture que lee el `getLogger()` mockeado (el patron de `e2e-kv.test.ts`). */
let startupCapture: LogCapture;

vi.mock('#shared/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/logger.js')>();
  return {
    ...actual,
    getLogger: (): ReturnType<typeof actual.createLogger> =>
      actual.createLogger(BASE_CONFIG, startupCapture.stream),
  };
});

// Se importa DESPUES del `vi.mock` para que `startup.ts` resuelva el `getLogger()` mockeado.
const { reportStartupFailure } = await import('../../../src/startup.js');

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

function sourceWith(mails: Map<number, Buffer>): MailSource & { markSeenCalls: number[] } {
  const markSeenCalls: number[] = [];
  return {
    markSeenCalls,
    searchUnseen: (): Promise<number[]> => Promise.resolve([...mails.keys()]),
    fetch: (uid: number): Promise<RawMessage> => {
      const source = mails.get(uid);
      if (source === undefined) throw new Error(`no hay fuente para uid ${String(uid)}`);
      return Promise.resolve({ uid, source });
    },
    markSeen: (uid: number): Promise<void> => {
      markSeenCalls.push(uid);
      return Promise.resolve();
    },
  };
}

const openLines = (capture: LogCapture): Record<string, unknown>[] =>
  capture.lines().filter((line) => line['msg'] === 'espacio KV abierto');

let bus: TestBusContext;
let nats: PermissionedJetStreamNats;
const connections: NatsConnection[] = [];
const openResponders: CoreResponder[] = [];

async function connectAs(user: Parameters<PermissionedJetStreamNats['connectAs']>[0]): Promise<NatsConnection> {
  const connection = await nats.connectAs(user);
  connections.push(connection);
  return connection;
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startPermissionedJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const connection of connections) await connection.close().catch(() => undefined);
  await nats?.stop();
  await bus.cleanup();
});

describe('E2E contra NATS real con permisos: el arranque falla cuando al rol le faltan los grants (CA-6 caso 3)', () => {
  // TS-12. Si el servidor real no entregara la violacion (Hallazgo 4), este caso falla con
  // `desconocido`: NO se relaja, NO se reclasifica por texto en `errors.ts` (ADR-002) y NO se toca el
  // SDK — se marca `it.fails` citando el hallazgo y se reporta a los duenos del SDK.
  it('TS-12: un rol sin los grants del espacio -> kv_sin_permisos, con el subject rechazado y los grants que faltan', async () => {
    const connection = await connectAs('sin-grants');
    const client = Client.fromConnection(connection, {
      instance: 'test',
      userId: 'sin-grants-0001',
      timeoutMs: 2_000,
    });
    startupCapture = createLogCapture();
    const { logger, capture } = loggerWithCapture();

    const caught = await openKvSpace({ client, logger }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(KvSpaceUnavailableError);
    const error = caught as KvSpaceUnavailableError;
    // Por ESTRUCTURA: los campos del error, nunca su texto.
    expect(error).toMatchObject({
      diagnosis: 'kv_sin_permisos',
      errorClass: 'JikuKVPermissionDenied',
      subject: '$JS.API.STREAM.INFO.KV_JIKU_KV',
      bucket: 'JIKU_KV',
    });
    expect(openLines(capture)).toHaveLength(0);

    reportStartupFailure(caught);

    const fatals = startupCapture.lines().filter((line) => line['level'] === 'fatal');
    expect(fatals).toHaveLength(1);
    const fatal = fatals[0] ?? {};
    expect(fatal).toMatchObject({
      code: 'KV_SPACE_UNAVAILABLE_ERROR',
      diagnosis: 'kv_sin_permisos',
      bucket: 'JIKU_KV',
      subject: '$JS.API.STREAM.INFO.KV_JIKU_KV',
      errorClass: 'JikuKVPermissionDenied',
      msg: FATAL_MESSAGE,
    });
    // Contexto plano: solo `causes` es un objeto (la convencion `logging`).
    for (const [key, value] of Object.entries(fatal)) {
      if (key === 'causes') continue;
      expect(typeof value, `${key} debe ser plano`).not.toBe('object');
    }
    // Los grants que faltan, en la causa del SDK: es lo que el operador copia a la plantilla.
    const cause = String((fatal['causes'] as unknown[])[0]);
    expect(cause).toContain('$JS.API.STREAM.INFO.KV_JIKU_KV');
    expect(cause).toContain('$KV.JIKU_KV.test.{{user_id}}.>');
    expect(cause).toContain('$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.test.{{user_id}}.>');
  });

  // TS-13. El control: sin el, TS-12 podria estar fallando por el bucket y no por los grants.
  it('TS-13: con los permisos completos el mismo bucket si abre', async () => {
    const connection = await connectAs('deploy');
    const { logger, capture } = loggerWithCapture();

    await openKvSpace({
      client: Client.fromConnection(connection, { instance: 'test', userId: 'deploy-0001' }),
      logger,
    });

    expect(openLines(capture)).toEqual([
      expect.objectContaining({ bucket: 'JIKU_KV', kvPrefix: 'test.deploy-0001.', msg: 'espacio KV abierto' }),
    ]);
  });

  // TS-14. El unico caso de la story donde el rechazo de permisos llega EN CALIENTE: el rol abre el
  // espacio pero no puede leer claves. El mail se descarta como `slug_no_consultable` —el arreglo es
  // el KV, no cargar el slug— con la clase del SDK en el `warn`.
  it('TS-14: un rol que abre el espacio pero no puede leer claves descarta como slug_no_consultable', async () => {
    const connection = await connectAs('solo-info');
    const { logger: openLogger } = loggerWithCapture();
    const space = await openKvSpace({
      client: Client.fromConnection(connection, { instance: 'test', userId: 'solo-info-0001', timeoutMs: 2_000 }),
      logger: openLogger,
    });

    const altas = await respondTo(bus.connection, 'requirements.new', { status: 'success' as const, data: { id: 1 } });
    openResponders.push(altas);

    const { logger, capture } = loggerWithCapture();
    const source = sourceWith(
      new Map([
        [
          1,
          Buffer.from(
            'Message-Id: <solo-info-1@cliente.com>\r\n' +
              'From: cliente@cliente.com\r\n' +
              'To: tickets+alfa@grava.io\r\n' +
              'Subject: Consulta\r\n\r\n' +
              'Cuerpo.\r\n',
          ),
        ],
      ]),
    );

    await runTick(source, BASE_CONFIG, logger, bus.client, space);

    expect(capture.lines()).toContainEqual(
      expect.objectContaining({
        slug: 'alfa',
        errorClass: 'JikuKVPermissionDenied',
        msg: 'no se pudo consultar el Mapa de Tickets; el mail se descarta como slug_no_consultable',
      }),
    );
    expect(capture.lines().filter((line) => line['msg'] === 'mail descartado')).toEqual([
      expect.objectContaining({ motivo: 'slug_no_consultable', slug: 'alfa' }),
    ]);
    expect(altas.count()).toBe(0);
    expect(capture.lines().find((line) => line['msg'] === 'tick completado')).toMatchObject({
      descartados: 1,
      creados: 0,
    });
    expect(source.markSeenCalls).toEqual([1]);
  });
});
