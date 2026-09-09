import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { KV } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { sha256hex } from '#infra/kv/threads.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { startJetStreamNats, type JetStreamNats } from '../infra/kv/helpers.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-19 a TS-28 y TS-40 del Story Plan de S-026: el Mapa de Hilos cableado DENTRO del tick.
 *
 * Corre contra los DOS sistemas reales que participan, sin mockear ninguno (convencion `testing`):
 *
 * - El bus del contenedor compartido, con el doble de `core` respondiendo `requirements.new`.
 * - Un NATS PROPIO con `-js` para el KV, porque el compartido arranca sin JetStream y por lo tanto
 *   sin buckets. Ver la cabecera de `test/infra/kv/helpers.ts`: no se le agrega `-js` al compartido.
 *
 * Lo unico que se dobla es `MailSource` (el borde IMAP) y, en los dos escenarios que lo necesitan,
 * un `KV` cuyo `put()`/`get()` RECHAZA — el bucket inaccesible en caliente no se puede provocar
 * contra un contenedor sano sin tirarlo abajo, que seria lento y no determinista.
 *
 * El `KV` ESPIA envuelve el handle REAL y solo registra las claves antes de delegar: la asercion de
 * "el lookup SI se ejecuto" tiene que valer contra el KV de verdad.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

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

/** Un mail NUEVO (sin referencias) al slug mapeado `alfa`. */
function mailNuevo(uid: number): Buffer {
  return Buffer.from(
    `Message-Id: <uid-${uid}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `Cuerpo del mail ${String(uid)}.\r\n`,
  );
}

/** Una RESPUESTA al slug mapeado `alfa`, con los headers de hilo que se le indiquen. */
function mailRespuesta(uid: number, headers: { inReplyTo?: string; references?: string }): Buffer {
  return Buffer.from(
    `Message-Id: <reply-${String(uid)}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Re: Consulta\r\n' +
      (headers.inReplyTo === undefined ? '' : `In-Reply-To: ${headers.inReplyTo}\r\n`) +
      (headers.references === undefined ? '' : `References: ${headers.references}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Respondo lo que preguntaste.\r\n',
  );
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

/** Envuelve el handle REAL y registra las claves de cada `get()`/`put()`, en orden. */
function spyOn(real: KV): { kv: KV; gets: string[]; puts: string[] } {
  const gets: string[] = [];
  const puts: string[] = [];
  const kv = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return async (key: string) => {
          gets.push(key);
          return target.get(key);
        };
      }
      if (prop === 'put') {
        return async (key: string, value: string) => {
          puts.push(key);
          return target.put(key, value);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as KV;
  return { kv, gets, puts };
}

/** Un `KV` cuyo `put()` rechaza siempre; el `get()` sigue funcionando contra el real. */
function withFailingPut(real: KV): KV {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'put') return () => Promise.reject(new Error('bucket inaccesible'));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as KV;
}

/** Un `KV` cuyo `get()` rechaza siempre. */
function withFailingGet(real: KV): KV {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'get') return () => Promise.reject(new Error('bucket inaccesible'));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as KV;
}

let bus: TestBusContext;
let nats: JetStreamNats;
let bucketCounter = 0;
let responder: CoreResponder | undefined;

/** Un bucket VACIO propio por test: sin aislamiento, el conteo de entradas de un test ve el del otro. */
async function freshThreads(): Promise<KV> {
  bucketCounter += 1;
  const name = `TICK_THREADS_T${String(bucketCounter)}`;
  await nats.seedBucket(name);
  return nats.openBucket(name);
}

async function countKeys(threads: KV): Promise<number> {
  let count = 0;
  for await (const _key of await threads.keys()) count += 1;
  return count;
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  await responder?.stop();
  responder = undefined;
});

afterAll(async () => {
  await nats.stop();
  await bus.cleanup();
});

/** El doble de `core` que responde `requirements.new` con exito y el id indicado. */
async function coreRespondeExito(ids: number[]): Promise<void> {
  responder = await respondTo(
    bus.connection,
    'requirements.new',
    ids.map((id) => ({ status: 'success' as const, data: { id } })),
  );
}

describe('runTick — el write al Mapa de Hilos despues del alta (TS-19 a TS-23)', () => {
  // TS-19
  it('TS-19: escribe la entrada del hilo tras un alta exitosa', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([500]);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, threads);

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ creados: 1, comentados: 0 });

    const entry = await threads.get(sha256hex('<uid-1@fixtures.local>'));
    expect(entry).not.toBeNull();
    expect(Number.parseInt(entry?.string() ?? '', 10)).toBe(500);
  });

  // TS-20
  it('TS-20: el write NO ocurre si el alta fallo', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    responder = await respondTo(bus.connection, 'requirements.new', [
      { status: 'failure', errorCode: 'project_not_found' },
    ]);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, threads);

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ creados: 0, fallidos: 1 });
    expect(await threads.get(sha256hex('<uid-1@fixtures.local>'))).toBeNull();
    expect(await countKeys(threads)).toBe(0);
  });

  // TS-21
  it('TS-21: un put() que falla NO cancela el alta ni revierte el contador', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([500]);

    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(threads),
    );

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    // `creados` NO se revierte: el write es un efecto posterior y fuera del camino critico.
    expect(tick).toMatchObject({ creados: 1, fallidos: 0, descartados: 0 });
    expect(lines.some((l) => l['msg'] === 'requisito creado en Jiku')).toBe(true);

    const warn = lines.find(
      (l) => l['level'] === 'warn' && l['requirementId'] === 500,
    );
    expect(warn).toBeDefined();
    expect(warn?.['messageId']).toBe('<uid-1@fixtures.local>');
  });

  // TS-22
  it('TS-22: un put() que falla no interrumpe el resto del lote', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([501, 502, 503]);

    // Solo el SEGUNDO `put()` rechaza. Los otros dos escriben contra el bucket real.
    let putCount = 0;
    const flaky = new Proxy(threads, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async (key: string, value: string) => {
            putCount += 1;
            if (putCount === 2) throw new Error('bucket inaccesible');
            return target.put(key, value);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as KV;

    const source = sourceWith(
      new Map([
        [3, mailNuevo(3)],
        [2, mailNuevo(2)],
        [1, mailNuevo(1)],
      ]),
    );

    await runTick(source, BASE_CONFIG, logger, bus.client, flaky);

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ ingestados: 3, creados: 3, fallidos: 0 });
    expect(source.markSeenCalls).toEqual([3, 2, 1]);
    expect(await countKeys(threads)).toBe(2);
  });

  // TS-23
  it('TS-23: un mail sin Message-Id no escribe nada (put() no se invoca ni una vez)', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    const spy = spyOn(threads);

    await runTick(
      sourceWith(new Map([[1, fixture('no-message-id.eml')]])),
      BASE_CONFIG,
      logger,
      bus.client,
      spy.kv,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ descartados: 1, creados: 0 });
    expect(
      capture.lines().some((l) => l['motivo'] === 'sin_message_id'),
    ).toBe(true);
    expect(spy.puts).toEqual([]);
    expect(await countKeys(threads)).toBe(0);
  });

  it('un mail NUEVO no paga ningun round-trip de LECTURA (CA-12)', async () => {
    const threads = await freshThreads();
    const { logger } = testLoggerWithCapture();
    await coreRespondeExito([500]);
    const spy = spyOn(threads);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, spy.kv);

    expect(spy.gets).toEqual([]);
    expect(spy.puts).toEqual([sha256hex('<uid-1@fixtures.local>')]);
  });
});

describe('runTick — el lookup en la rama de la respuesta (TS-24 a TS-28)', () => {
  // TS-24
  it('TS-24: una respuesta sin match se descarta como hilo_desconocido', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ descartados: 1, creados: 0, fallidos: 0, comentados: 0 });

    const discard = lines.find((l) => l['msg'] === 'mail descartado');
    expect(discard).toMatchObject({
      messageId: '<reply-1@fixtures.local>',
      motivo: 'hilo_desconocido',
    });
    // Ningun comando se publico: el responder no recibio nada.
    expect(responder?.count()).toBe(0);
  });

  // TS-25
  it('TS-25: un reenvio de hilo interno con slug mapeado tambien es hilo_desconocido', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    await runTick(
      sourceWith(
        new Map([
          [
            1,
            mailRespuesta(1, {
              references: '<interno-1@empresa.com> <interno-2@empresa.com>',
            }),
          ],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const lines = capture.lines();
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toMatchObject({
      motivo: 'hilo_desconocido',
    });
    expect(lines.find((l) => l['msg'] === 'tick completado')).toMatchObject({
      descartados: 1,
      creados: 0,
    });
    expect(responder?.count()).toBe(0);
  });

  // TS-26
  it('TS-26: una entrada expirada por TTL es indistinguible de "nunca existio"', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    // El TTL de 90 dias no se puede esperar en un test. Lo que el `get()` ve al expirar una entrada
    // es exactamente lo que ve tras un `delete()`: la clave no esta. Se siembra y se borra.
    await threads.put(sha256hex('<r1@x>'), '77');
    await threads.delete(sha256hex('<r1@x>'));

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const lines = capture.lines();
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toMatchObject({
      motivo: 'hilo_desconocido',
    });
    // NO se crea un Requisito duplicado.
    expect(lines.find((l) => l['msg'] === 'tick completado')).toMatchObject({ creados: 0 });
    expect(responder?.count()).toBe(0);
  });

  // TS-27
  it('TS-27: una respuesta CON match se sigue descartando en esta story, y el lookup SI corrio', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);
    await threads.put(sha256hex('<r1@x>'), '77');
    const spy = spyOn(threads);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      spy.kv,
    );

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ descartados: 1, creados: 0, comentados: 0 });

    // Con match el motivo NO es `hilo_desconocido` — seria falso, el hilo SI se conoce — y tampoco
    // hay salida por comentario todavia: el mail se descarta como `es_respuesta`.
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toMatchObject({
      motivo: 'es_respuesta',
    });

    // El lookup SI se ejecuto y resolvio: sin esta asercion, un lookup que nunca corre pasaria el
    // test de "no publica nada" por la razon equivocada.
    expect(spy.gets).toEqual([sha256hex('<r1@x>')]);
    expect(responder?.count()).toBe(0);
  });

  // TS-28
  it('TS-28: el bucket inaccesible en caliente degrada a es_respuesta, no a hilo_desconocido', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingGet(threads),
    );

    const lines = capture.lines();
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toMatchObject({
      motivo: 'es_respuesta',
    });
    expect(lines.find((l) => l['msg'] === 'tick completado')).toMatchObject({ descartados: 1 });
  });

  it('el lookup NO se paga en los otros motivos de descarte (sin_slug, slug_no_mapeado)', async () => {
    const threads = await freshThreads();
    const { logger } = testLoggerWithCapture();
    const spy = spyOn(threads);

    const sinSlug = Buffer.from(
      'Message-Id: <sin-slug@fixtures.local>\r\n' +
        'From: cliente@cliente.com\r\n' +
        'To: soporte@grava.io\r\n' +
        'Subject: Consulta\r\n\r\n' +
        'Cuerpo.\r\n',
    );
    const noMapeado = Buffer.from(
      'Message-Id: <no-mapeado@fixtures.local>\r\n' +
        'From: cliente@cliente.com\r\n' +
        'To: tickets+beta@grava.io\r\n' +
        'Subject: Consulta\r\n\r\n' +
        'Cuerpo.\r\n',
    );

    await runTick(
      sourceWith(
        new Map([
          [2, sinSlug],
          [1, noMapeado],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      spy.kv,
    );

    expect(spy.gets).toEqual([]);
    expect(spy.puts).toEqual([]);
  });
});

/**
 * TS-29, TS-30 y TS-31 (CA-11): la linea de metricas con SEIS contadores, con los inputs EXACTOS que
 * el Story Plan especifica para cada uno.
 *
 * Los tres afirman la misma decision desde angulos distintos: que `comentados` existe, que en esta
 * story queda siempre en 0, y que `creados` cuenta SOLO altas de Requisito. Sumar los dos borraria
 * la distincion en la unica linea de metricas que el tick emite (ADR-006: no hay healthcheck ni
 * exportador de metricas), que es justamente la metrica que S-027 va a mirar.
 */
describe('runTick — los seis contadores de la linea del tick (TS-29, TS-30, TS-31)', () => {
  /** Los campos que Pino agrega a TODA linea y que no son contadores de negocio. */
  const PINO_STRUCTURAL_FIELDS = new Set(['level', 'time', 'msg', 'env', 'service']);

  function counterKeys(line: Record<string, unknown> | undefined): string[] {
    return Object.keys(line ?? {})
      .filter((key) => !PINO_STRUCTURAL_FIELDS.has(key))
      .sort();
  }

  // TS-29
  it('TS-29: un tick con 3 mails nuevos resolubles emite EXACTAMENTE las seis claves', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([801, 802, 803]);

    await runTick(
      sourceWith(
        new Map([
          [3, mailNuevo(3)],
          [2, mailNuevo(2)],
          [1, mailNuevo(1)],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    // Ni una mas, ni una menos.
    expect(counterKeys(tick)).toEqual(
      ['comentados', 'creados', 'descartados', 'fallidos', 'ingestados', 'parseados'],
    );
    expect(tick).toMatchObject({ ingestados: 3, parseados: 3, creados: 3, comentados: 0 });
  });

  // TS-31 (y TS-30 sobre el mismo tick, que incluye una respuesta CON match)
  it('TS-31: 2 mails nuevos + 1 respuesta con match dan creados:2, comentados:0, descartados:1', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    // Solo DOS ids: si el tick publicara un comando por la respuesta, el responder se quedaria sin
    // respuestas y el fallo se veria en los contadores.
    await coreRespondeExito([810, 811]);

    await threads.put(sha256hex('<viejo@x>'), '77');

    await runTick(
      sourceWith(
        new Map([
          [3, mailNuevo(3)],
          [2, mailNuevo(2)],
          [1, mailRespuesta(1, { inReplyTo: '<viejo@x>' })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 2,
      // TS-30: `comentados` queda en 0 INCLUSO con una respuesta que SI matcheo — es la senal de
      // que la salida por comentario todavia no existe.
      comentados: 0,
      descartados: 1,
      fallidos: 0,
    });
    // `creados` no se contamina con el hilo: la respuesta con match NO publico ningun comando.
    expect(responder?.count()).toBe(2);
  });
});

/**
 * TS-37 (CA-14), la mitad de COMPORTAMIENTO.
 *
 * La otra mitad —el escaneo estructural de `tick.ts`— vive en
 * `test/infra/kv/source-properties.test.ts`. La propiedad real ("el KV no participa de la
 * idempotencia") es semantica, y un escaneo de texto solo puede afirmar la forma del codigo: este
 * test afirma el efecto observable, que es lo que de verdad importa.
 */
describe('runTick — el Mapa de Hilos NO participa de la idempotencia (TS-37)', () => {
  it('un mail cuyo hash YA esta en el bucket se procesa igual, sin saltearse', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([600]);

    // La entrada ya existe: si el conector usara el bucket para deduplicar, este mail se saltearia.
    await threads.put(sha256hex('<uid-1@fixtures.local>'), '77');

    const source = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source, BASE_CONFIG, logger, bus.client, threads);

    // Se procesa IGUAL: se crea el requisito, se cuenta, y el UID queda \Seen. El `\Seen` sigue
    // siendo la unica marca de idempotencia (ADR-001).
    expect(capture.lines().find((l) => l['msg'] === 'tick completado')).toMatchObject({
      ingestados: 1,
      creados: 1,
      descartados: 0,
    });
    expect(source.markSeenCalls).toEqual([1]);
    expect(responder?.count()).toBe(1);

    // Y el write posterior PISA la entrada con el requisito nuevo: es la ultima escritura la que
    // vale, sin ninguna rama de "ya existia".
    const entry = await threads.get(sha256hex('<uid-1@fixtures.local>'));
    expect(Number.parseInt(entry?.string() ?? '', 10)).toBe(600);
  });
});

/**
 * Task 5 (CA-13, TS-40): el estado INTERMEDIO DESPLEGABLE.
 *
 * Ninguna de las suites de arriba afirma por si sola que el sistema COMPLETO, con S-026 terminada y
 * S-027 sin empezar, sea coherente: el lookup funciona, el bucket se puebla, y ninguna respuesta
 * genera todavia un efecto en Jiku. Es la tarea que evita el modo de falla clasico de una story de
 * "estado antes que consumidor": que cada pieza pase sus tests y el conjunto haga algo raro.
 */
describe('runTick — el estado intermedio desplegable de punta a punta (TS-40)', () => {
  it('TS-40: un tick mixto deja los seis contadores exactos, el bucket coherente y los 4 UIDs \\Seen', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    // Un solo id disponible: si el tick publicara un comando de mas, el responder se quedaria sin
    // respuestas y el fallo seria visible en los contadores.
    await coreRespondeExito([500]);

    await threads.put(sha256hex('<viejo@x>'), '77');
    const spy = spyOn(threads);

    const slugNoMapeado = Buffer.from(
      'Message-Id: <no-mapeado@fixtures.local>\r\n' +
        'From: cliente@cliente.com\r\n' +
        'To: tickets+beta@grava.io\r\n' +
        'Subject: Consulta\r\n\r\n' +
        'Cuerpo.\r\n',
    );

    const source = sourceWith(
      new Map([
        [4, mailNuevo(4)], //                                (a) mail nuevo resoluble
        [3, mailRespuesta(3, { inReplyTo: '<viejo@x>' })], // (b) respuesta CON match
        [2, mailRespuesta(2, { inReplyTo: '<nadie@x>' })], // (c) respuesta SIN match
        [1, slugNoMapeado], //                               (d) slug_no_mapeado
      ]),
    );

    await runTick(source, BASE_CONFIG, logger, bus.client, spy.kv);

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({
      ingestados: 4,
      parseados: 4,
      creados: 1,
      comentados: 0,
      descartados: 3,
      fallidos: 0,
    });

    // El bucket termina con DOS entradas: la sembrada mas la del mail nuevo. Ninguna respuesta
    // escribio nada — eso es S-027.
    expect(await countKeys(threads)).toBe(2);
    expect(spy.puts).toEqual([sha256hex('<uid-4@fixtures.local>')]);

    // Los cuatro UIDs quedan \Seen: el Mapa de Hilos NO participa de la idempotencia (CA-14).
    expect(source.markSeenCalls).toEqual([4, 3, 2, 1]);

    // El lookup corrio SOLO en las dos respuestas, en el orden del lote.
    expect(spy.gets).toEqual([sha256hex('<viejo@x>'), sha256hex('<nadie@x>')]);

    // EXACTAMENTE UN comando publicado, el del alta. La respuesta CON match no publico nada.
    expect(responder?.count()).toBe(1);

    const motivos = lines
      .filter((l) => l['msg'] === 'mail descartado')
      .map((l) => l['motivo']);
    expect(motivos.sort()).toEqual(['es_respuesta', 'hilo_desconocido', 'slug_no_mapeado']);
  });
});

/**
 * TS-38 y TS-39 (CA-15): la redaccion, ahora que hay un hash en el contexto.
 *
 * Lo que cambia con S-026 es que aparece un campo NUEVO en el log —`messageIdHash`— y hay que
 * afirmar dos cosas sobre el a la vez: que SI sale (no se redacta) y que su llegada no arrastro
 * contenido del cliente. El `Message-Id` se sigue logueando en claro, como siempre: ADR-006 lo
 * exige en cada linea, y el hash no lo reemplaza en el log — solo en la clave.
 *
 * La asercion que de verdad detecta una filtracion es sobre la linea CRUDA, no sobre el objeto
 * parseado: un secreto que se colo por un campo inesperado no se ve mirando campos conocidos.
 */
describe('runTick — el messageIdHash se puede loguear; el contenido no (TS-38, TS-39)', () => {
  // TS-38
  it('TS-38: ninguna linea filtra el cuerpo del mail; el Message-Id SI aparece en claro', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([700]);

    // `sensitive-body.eml` va a `soporte@grava.io`, que no tiene subaddress: se reescribe el
    // destinatario al slug mapeado para que llegue hasta el alta y ejercite el write del hilo.
    const sensitive = fixture('sensitive-body.eml')
      .toString('utf8')
      .replace('To: soporte@grava.io', 'To: tickets+alfa@grava.io');

    await runTick(
      sourceWith(
        new Map([
          [2, Buffer.from(sensitive)],
          [1, mailRespuesta(1, { inReplyTo: '<r1@x>' })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    const raw = capture.raw().join('\n');

    // El cuerpo del mail NUNCA aparece, ni entero ni en fragmentos.
    expect(raw).not.toContain('4111 1111 1111 1111');
    expect(raw).not.toContain('mi tarjeta es');

    // El `Message-Id` SI aparece en claro: es el identificador que ADR-006 exige en cada linea.
    expect(raw).toContain('<sensitive-body-001@fixtures.local>');
    expect(raw).toContain('<reply-1@fixtures.local>');
  });

  // TS-39
  it('TS-39: el messageIdHash sale LITERAL, no [REDACTED] — por eso el campo no se llama key', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([701]);

    // Un `put()` que rechaza es el camino que emite el `warn` con el `messageIdHash`.
    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(threads),
    );

    const hash = sha256hex('<uid-1@fixtures.local>');
    const warn = capture.lines().find((l) => l['messageIdHash'] !== undefined);

    expect(warn?.['messageIdHash']).toBe(hash);
    // El valor sale entero, 64 chars de hex. Si el campo se llamara `key`, `REDACT_PATHS` lo
    // habria censurado sin fallar y sin avisar.
    expect(capture.raw().join('\n')).toContain(hash);
    expect(warn?.['key']).toBeUndefined();
    expect(JSON.stringify(warn)).not.toContain('[REDACTED]');
  });
});
