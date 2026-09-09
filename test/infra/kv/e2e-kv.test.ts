import type { KV } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { KvBucketMissingError } from '#infra/kv/errors.js';
import { openKvStores } from '#infra/kv/stores.js';
import { sha256hex } from '#infra/kv/threads.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { type CoreResponder, respondTo } from '../../bus/responder.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * S-028 Tarea 4 (CA-7, CA-8): la verificacion E2E contra un NATS REAL con JetStream y los dos
 * buckets creados. TS-31 a TS-38.
 *
 * # QUE VERIFICA ESTE ARCHIVO Y QUE NO
 *
 * **CA-7 — el ciclo ENCADENADO.** `tick-hilos.test.ts` TS-40 ya cubre un tick MIXTO contra KV real.
 * Lo que no existia es la SECUENCIA de ticks separados sobre el mismo bucket:
 * alta → write → (tick nuevo) respuesta → comentario → write → (tick nuevo) respuesta a la
 * respuesta → comentario. Esa cadena es la que prueba que el write del tick 1 es LEGIBLE por el
 * lookup del tick 2 —lo que en un tick mixto podria pasar por casualidad si el orden del lote
 * ayudara— y es lo que hace concreta la razon de que el SEGUNDO write exista.
 *
 * **CA-8 — el ENCADENADO del fail-fast.** `stores.test.ts` ya cubre `openKvStores()` fallando y
 * nombrando cada bucket, los dos ausentes, el nombre invalido y el NATS sin JetStream; y
 * `startup-wiring.test.ts` ya cubre el `logger.fatal` de `reportStartupFailure()` sobre un
 * `KvBucketMissingError` construido a mano. Lo que falta, y es lo que se agrega aca, es LA UNION:
 * el error que el SERVIDOR produjo de verdad pasando por `reportStartupFailure()` en la MISMA
 * corrida, con la afirmacion de que el bucket sigue sin existir despues.
 *
 * # POR QUE NO SE INVOCA `runStartup()`
 *
 * `runStartup()` llama a `connectToBus()`, que pide el token a Zitadel ANTES de abrir el socket. No
 * hay Zitadel en test y no puede haberlo: `Client.fromConnection()` existe precisamente para
 * saltear ese handshake. Asi que el encadenado se arma con las DOS piezas reales que el arranque
 * ejecuta en secuencia —`openKvStores()` y `reportStartupFailure()`— sobre el `client` de
 * `fromConnection()`. Es el mismo encadenado que produce el arranque real y es el precedente que
 * `startup-wiring.test.ts` ya usa.
 *
 * NO LO "MEJORES" a un `runStartup()`: no puede correr, y el intento termina en un mock del modulo
 * del bus que ya no prueba nada del KV.
 *
 * # UN SOLO CONTENEDOR POR ARCHIVO
 *
 * Los escenarios de CA-8 necesitan buckets AUSENTES. Se resuelve con NOMBRES DE BUCKET DISTINTOS
 * por escenario, sembrando solo el que corresponde, en vez de un contenedor por escenario: el KV no
 * tiene forma de borrar un bucket sin `create()`, y un contenedor por caso multiplicaria el tiempo
 * de la suite por nada.
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
};

const configWithKv = (ticketsBucket: string, threadsBucket: string): AppConfig => ({
  ...BASE_CONFIG,
  kv: { ...BASE_CONFIG.kv, ticketsBucket, threadsBucket },
});

/**
 * El capture del caso en curso, leido por el `getLogger()` mockeado.
 *
 * `reportStartupFailure()` usa el logger SINGLETON (`getLogger()`), que `initLogger()` construye
 * sin aceptar un destino. La unica forma de leer lo que emite es interceptar `getLogger()`. No se
 * cambia el codigo de produccion para hacerlo testeable: el modulo del logger ya expone
 * `createLogger(config, destination)` para exactamente esto. Es el patron de
 * `startup-wiring.test.ts`.
 */
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

/** Un mail al slug mapeado `alfa`, con el `Message-Id` y los headers de hilo indicados. */
function mail(opts: { messageId: string; inReplyTo?: string; subject?: string }): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      `Subject: ${opts.subject ?? 'Consulta'}\r\n` +
      (opts.inReplyTo === undefined ? '' : `In-Reply-To: ${opts.inReplyTo}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Texto del mensaje.\r\n',
  );
}

let bus: TestBusContext;
let nats: JetStreamNats;
const openResponders: CoreResponder[] = [];

async function responderFor(
  command: string,
  replies: Parameters<typeof respondTo>[2],
): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  openResponders.push(responder);
  return responder;
}

const tickLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await nats.stop();
  await bus.cleanup();
});

/* ==========================================================================================
 * CA-7 — EL CAMINO COMPLETO DE UNA RESPUESTA, CONTRA EL KV REAL
 * ========================================================================================== */
describe('E2E contra NATS real: el ciclo alta -> respuesta -> respuesta a la respuesta (CA-7)', () => {
  // TS-31, TS-32, TS-33 en una sola cadena: los tres ticks comparten el MISMO handle del bucket, y
  // eso NO es un detalle de comodidad — es lo que hace que el write del tick 1 sea legible por el
  // lookup del tick 2. Por eso este escenario NO refresca el bucket entre ticks, a diferencia del
  // resto de las suites del KV, que si aislan.
  it('TS-31/TS-32/TS-33: los tres ticks encadenados contra el KV real, sin ningun doble del KV', async () => {
    await nats.seedBucket('E2E_THREADS', 90);
    const threads: KV = await nats.openBucket('E2E_THREADS');

    // ---------- TICK 1: el mail nuevo crea el Requisito y ESCRIBE su entrada ----------
    const { logger: l1, capture: c1 } = loggerWithCapture();
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 700 },
    });

    await runTick(
      sourceWith(new Map([[1, mail({ messageId: '<orig-1@cliente.com>' })]])),
      configWithKv('E2E_TICKETS_NO_USADO', 'E2E_THREADS'),
      l1,
      bus.client,
      threads,
    );

    expect(tickLine(c1)).toMatchObject({ creados: 1, comentados: 0, descartados: 0, fallidos: 0 });
    expect(altas.count()).toBe(1);

    // El valor se lee DEL KV REAL, no de un doble.
    const entrada1 = await threads.get(sha256hex('<orig-1@cliente.com>'));
    expect(entrada1).not.toBeNull();
    expect(entrada1?.string()).toBe('700');

    // ---------- TICK 2: la respuesta COMENTA y escribe la entrada de SU PROPIO Message-Id ----------
    const { logger: l2, capture: c2 } = loggerWithCapture();
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 900 },
    });

    await runTick(
      sourceWith(
        new Map([
          [2, mail({ messageId: '<reply-1@cliente.com>', inReplyTo: '<orig-1@cliente.com>', subject: 'Re: Consulta' })],
        ]),
      ),
      configWithKv('E2E_TICKETS_NO_USADO', 'E2E_THREADS'),
      l2,
      bus.client,
      threads,
    );

    expect(tickLine(c2)).toMatchObject({
      comentados: 1,
      // NO crea ningun Requisito: el Requisito ya existe.
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
    expect(comentarios.count()).toBe(1);
    // El comentario viajo al subject del REQUISITO que el lookup resolvio.
    expect(comentarios.subjects()[0]).toContain('requirements.700.comment');
    // Y el responder del alta NO recibio nada mas en este tick.
    expect(altas.count()).toBe(1);

    // TS-32: el payload que llego al BUS REAL.
    const payload = comentarios.payloads()[0] as Record<string, unknown>;
    // `visibilityLevel: 'public'` EXPLICITO y PRESENTE. El default del contrato es `'internal'`, y
    // un comentario interno NO LO VERIA EL CLIENTE EN OPUS — `core` responderia `success` igual, y
    // la falla seria invisible del lado del conector.
    expect(payload['visibilityLevel']).toBe('public');
    expect('visibilityLevel' in payload).toBe(true);
    // Ni `author` ni `actor`: `core` resuelve el actor del `sub` del subject (ADR-005), y el
    // `.strict()` del schema hace que colar cualquiera de las dos FALLE en vez de removerse.
    expect('author' in payload).toBe(false);
    expect('actor' in payload).toBe(false);
    // Y `fileIds` AUSENTE (nunca `fileIds: []`): la clave ausente ES la representacion de "cero
    // adjuntos".
    expect('fileIds' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['comment', 'visibilityLevel']);

    // El SEGUNDO write: la entrada del Message-Id de LA RESPUESTA, apuntando al MISMO requisito.
    const entrada2 = await threads.get(sha256hex('<reply-1@cliente.com>'));
    expect(entrada2).not.toBeNull();
    expect(entrada2?.string()).toBe('700');

    // ---------- TICK 3: una respuesta A LA RESPUESTA rutea igual ----------
    //
    // ES LA RAZON CONCRETA DE QUE EL SEGUNDO WRITE EXISTA. Este mail lleva como UNICA referencia el
    // `Message-Id` de la respuesta (el cliente recorto `References`, que es lo que varios clientes
    // hacen): sin la entrada que el tick 2 escribio, este mail seria `hilo_desconocido`.
    const { logger: l3, capture: c3 } = loggerWithCapture();

    await runTick(
      sourceWith(
        new Map([
          [3, mail({ messageId: '<reply-2@cliente.com>', inReplyTo: '<reply-1@cliente.com>', subject: 'Re: Re: Consulta' })],
        ]),
      ),
      configWithKv('E2E_TICKETS_NO_USADO', 'E2E_THREADS'),
      l3,
      bus.client,
      threads,
    );

    expect(tickLine(c3)).toMatchObject({ comentados: 1, creados: 0, descartados: 0, fallidos: 0 });
    expect(comentarios.count()).toBe(2);
    // Comenta en el MISMO requisito 700, no en otro.
    expect(comentarios.subjects()[1]).toContain('requirements.700.comment');
    // Y escribe su propia entrada, para que la cadena siga.
    expect((await threads.get(sha256hex('<reply-2@cliente.com>')))?.string()).toBe('700');
  }, 90_000);
});

/* ==========================================================================================
 * CA-8 — EL FAIL-FAST DEL BUCKET FALTANTE, ENCADENADO CON EL REPORTE DEL ARRANQUE
 * ========================================================================================== */
describe('E2E contra NATS real: el arranque falla nombrando el bucket faltante (CA-8)', () => {
  /**
   * El encadenado real: `openKvStores()` contra el servidor de verdad, el error capturado, y
   * `reportStartupFailure()` sobre ESE error. Es lo que el arranque hace en secuencia.
   */
  async function arrancarYFallar(
    ticketsBucket: string,
    threadsBucket: string,
    client = nats.client,
  ): Promise<{ error: KvBucketMissingError; fatals: Record<string, unknown>[] }> {
    startupCapture = createLogCapture();
    const { logger } = loggerWithCapture();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const caught = await openKvStores({
      client,
      config: configWithKv(ticketsBucket, threadsBucket),
      logger,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(KvBucketMissingError);

    // Y aca esta la union que faltaba: el error del SERVIDOR pasando por el reporte del arranque.
    reportStartupFailure(caught);

    // Nada por stderr: este fallo ocurre con el logger ya construido (paso 5.5 del arranque, que
    // va DESPUES de `initLogger()`).
    expect(stderr).not.toHaveBeenCalled();

    return {
      error: caught as KvBucketMissingError,
      fatals: startupCapture.lines().filter((line) => line['level'] === 'fatal'),
    };
  }

  /** Tras el fallo, el bucket TIENE que seguir sin existir: el conector no lo creo. */
  async function sigueSinExistir(name: string): Promise<void> {
    const handle = await nats.openBucket(name);
    // `open()` NO falla si el bucket no existe (fija `bindOnly` y delega en `Bucket.bind()`, que
    // nunca consulta `streams.info`). El fallo esta diferido al primer acceso real, y por eso la
    // verificacion es el `status()` — el mismo que hace produccion. NO es redundante.
    await expect(handle.status()).rejects.toThrow();
  }

  // TS-34
  it('TS-34: falta el bucket de SLUGS -> falla nombrandolo, el fatal sale por la rama del KV, y no lo crea', async () => {
    await nats.seedBucket('T34_THREADS', 90);

    const { error, fatals } = await arrancarYFallar('T34_TICKETS', 'T34_THREADS');

    expect(error.bucket).toBe('T34_TICKETS');
    expect(error.operation).toBe('status');
    expect(error.diagnosis).toBe('bucket_inexistente');

    // UNA sola linea fatal, con el contexto PLANO que la convencion `logging` exige (`redact.paths`
    // de Pino no tiene comodin profundo: un contexto anidado dejaria un valor sin redactar sin
    // fallar y sin avisar).
    expect(fatals).toHaveLength(1);
    const fatal = fatals[0];
    expect(fatal?.['code']).toBe('KV_BUCKET_MISSING_ERROR');
    expect(fatal?.['diagnosis']).toBe('bucket_inexistente');
    expect(fatal?.['bucket']).toBe('T34_TICKETS');
    expect(fatal?.['operation']).toBe('status');
    expect(fatal?.['msg']).toBe('el arranque fallo: un bucket del KV no esta usable');
    expect(fatal?.['errorClass']).toBeDefined();
    expect(Array.isArray(fatal?.['causes'])).toBe(true);
    for (const [key, value] of Object.entries(fatal ?? {})) {
      if (key === 'causes') continue;
      expect(typeof value, `${key} debe ser plano`).not.toBe('object');
    }

    // Y NO lo creo.
    await sigueSinExistir('T34_TICKETS');
  });

  // TS-35
  it('TS-35: falta el bucket de HILOS -> falla nombrandolo, y no lo crea', async () => {
    await nats.seedBucket('T35_TICKETS');

    const { error, fatals } = await arrancarYFallar('T35_TICKETS', 'T35_THREADS');

    expect(error.bucket).toBe('T35_THREADS');
    expect(error.diagnosis).toBe('bucket_inexistente');
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.['bucket']).toBe('T35_THREADS');

    await sigueSinExistir('T35_THREADS');
  });

  // TS-36
  it('TS-36: faltan los DOS -> nombra el de slugs y SOLO ese, con una sola linea fatal', async () => {
    const { error, fatals } = await arrancarYFallar('T36_TICKETS', 'T36_THREADS');

    // La verificacion es SECUENCIAL (slugs primero) y corta ahi a proposito: sin el Mapa de
    // Tickets no se puede rutear nada, y el error tiene que nombrar UN bucket para que el operador
    // sepa cual crear. Nombrar los dos lo dejaria dudando de por donde empezar.
    expect(error.bucket).toBe('T36_TICKETS');
    expect(error.message).not.toContain('T36_THREADS');
    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.['bucket']).toBe('T36_TICKETS');

    await sigueSinExistir('T36_TICKETS');
    await sigueSinExistir('T36_THREADS');
  });

  // TS-37
  it('TS-37: el fallo del bucket es una rama PROPIA, no la del bus', async () => {
    await nats.seedBucket('T37_THREADS', 90);

    const { fatals } = await arrancarYFallar('T37_TICKETS', 'T37_THREADS');

    const msg = String(fatals[0]?.['msg']);
    // La conexion al bus FUNCIONO: el `client` de este escenario esta conectado y usable.
    // Reportarlo como "el conector no pudo conectarse al bus" mandaria al operador a revisar
    // Zitadel, la red y los montajes de credenciales cuando el arreglo es UN `nats kv add`. Ese es
    // el diagnostico equivocado que ADR-006 existe para evitar.
    expect(msg).toBe('el arranque fallo: un bucket del KV no esta usable');
    expect(msg).not.toContain('el conector no pudo conectarse al bus');
    expect(msg).not.toMatch(/conectar|conexion/i);
    expect(fatals[0]?.['diagnosis']).not.toBe('bus_inalcanzable');
  });

  // TS-38 — contra el contenedor COMPARTIDO, que por NO tener JetStream es el doble perfecto y
  // gratis del escenario "JetStream deshabilitado". No hay que simular nada.
  it('TS-38: contra un NATS sin JetStream el diagnostico es kv_no_disponible y nombra las DOS cosas', async () => {
    const { error, fatals } = await arrancarYFallar('TICKETS', 'MAIL_THREADS', bus.client);

    // NO es `bucket_inexistente`: el KV entero no esta disponible. Desde el cliente, JetStream
    // deshabilitado y los permisos de KV faltantes son INDISTINGUIBLES, asi que el mensaje nombra
    // las dos cosas a revisar en vez de elegir una y mandar al operador al lugar equivocado.
    expect(error.diagnosis).toBe('kv_no_disponible');
    expect(error.message).toMatch(/JetStream/i);
    expect(error.message).toMatch(/permisos/i);
    expect(error.message).not.toMatch(/inalcanzable|no se pudo conectar/i);

    expect(fatals).toHaveLength(1);
    expect(fatals[0]?.['diagnosis']).toBe('kv_no_disponible');
    expect(fatals[0]?.['msg']).toBe('el arranque fallo: un bucket del KV no esta usable');
  });
});
