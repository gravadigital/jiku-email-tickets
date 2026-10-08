import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { threadKey } from '#infra/kv/keys.js';
import type { KvSpace } from '#infra/kv/space.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { startJetStreamNats, type JetStreamNats } from '../infra/kv/helpers.js';
import { spyOnSpace, withFailingGet, withFailingPut } from '../infra/kv/space-doubles.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-19 a TS-28 y TS-40 del Story Plan de S-026: el Mapa de Hilos cableado DENTRO del tick.
 *
 * Corre contra los DOS sistemas reales que participan, sin mockear ninguno (convencion `testing`):
 *
 * - El bus del contenedor compartido, con el doble de `core` respondiendo `requirements.new`.
 * - Un NATS PROPIO con `-js` y `JIKU_KV` para el KV, porque el compartido arranca sin JetStream y
 *   por lo tanto sin bucket. Ver la cabecera de `test/infra/kv/helpers.ts`: no se le agrega `-js`
 *   al compartido.
 *
 * Desde S-032 el Mapa de Hilos vive en el Espacio KV del conector (claves `hilos.<sha256>`), junto
 * al Mapa de Tickets (`tickets.<slug>`). Cada test usa un espacio FRESCO de una identidad propia
 * (`nats.spaceFor(...)`): el bucket es uno solo, y lo que aisla un test del otro es el prefijo
 * `{instance}.{userId}.` que agrega el SDK. Cada espacio se siembra con `tickets.alfa` → `42`, el
 * mismo mapa que hasta S-032 viajaba en `config.ruteo.ticketMap`, para que los mails nuevos de este
 * archivo resuelvan igual que antes.
 *
 * Lo unico que se dobla es `MailSource` (el borde IMAP) y, en los escenarios que lo necesitan, un
 * espacio cuyo `put()`/`get()` RECHAZA (`space-doubles.ts`) — el KV inaccesible en caliente no se
 * puede provocar contra un contenedor sano sin tirarlo abajo, que seria lento y no determinista.
 *
 * El espacio ESPIA envuelve el handle REAL y solo registra las claves antes de delegar: la asercion
 * de "el lookup SI se ejecuto" tiene que valer contra el KV de verdad. Y como el `KV` del SDK no
 * lista claves, "el bucket quedo con N entradas" se afirma con un `get()` dirigido a cada clave
 * esperada y con lo que el espia registro que se ESCRIBIO.
 */

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** El valor de una entrada del espacio como texto, o `undefined` si no esta. */
async function valueOf(space: KvSpace, key: string): Promise<string | undefined> {
  const entry = await space.get(key);
  return entry === undefined ? undefined : new TextDecoder().decode(entry.value);
}

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

let bus: TestBusContext;
let nats: JetStreamNats;
let spaceCounter = 0;
let responder: CoreResponder | undefined;

/**
 * Un espacio FRESCO propio por test (S-032: hasta entonces, un bucket propio por test), con
 * `tickets.alfa` → `42` ya cargado. Sin aislamiento, las entradas que escribe un test las veria el
 * siguiente.
 */
async function freshSpace(): Promise<KvSpace> {
  spaceCounter += 1;
  const space = await nats.spaceFor(`tick-hilos-t${String(spaceCounter)}`);
  await space.put('tickets.alfa', '42');
  return space;
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
  await nats?.stop();
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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([500]);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, space);

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ creados: 1, comentados: 0 });

    // La clave es `hilos.` + el sha256 del `Message-Id` crudo (S-032: el prefijo del espacio).
    expect(threadKey('<uid-1@fixtures.local>')).toBe(`hilos.${sha256('<uid-1@fixtures.local>')}`);
    expect(await valueOf(space, threadKey('<uid-1@fixtures.local>'))).toBe('500');
  });

  // TS-20
  it('TS-20: el write NO ocurre si el alta fallo', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    responder = await respondTo(bus.connection, 'requirements.new', [
      { status: 'failure', errorCode: 'project_not_found' },
    ]);
    const spy = spyOnSpace(space);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, spy.space);

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ creados: 0, fallidos: 1 });
    expect(await space.get(threadKey('<uid-1@fixtures.local>'))).toBeUndefined();
    // Ningun write en todo el tick: el `KV` del SDK no lista claves, asi que el "cero entradas" de
    // antes se afirma sobre lo que el codigo PIDIO escribir.
    expect(spy.puts).toEqual([]);
  });

  // TS-21
  it('TS-21: un put() que falla NO cancela el alta ni revierte el contador', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([500]);

    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(space),
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
    // S-032: el `warn` nombra la CLASE del error del SDK (el timeout es un `JikuError`).
    expect(warn?.['errorClass']).toBe('JikuError');
  });

  // TS-22
  it('TS-22: un put() que falla no interrumpe el resto del lote', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([501, 502, 503]);

    // Solo el SEGUNDO `put()` rechaza. Los otros dos escriben contra el espacio real. Objeto plano
    // que delega, y no un `Proxy`: ver la cabecera de `space-doubles.ts`.
    let putCount = 0;
    const flaky: KvSpace = {
      get: (key, options) => space.get(key, options),
      put: (key, value, options) => {
        putCount += 1;
        if (putCount === 2) return Promise.reject(new Error('bucket inaccesible'));
        return space.put(key, value, options);
      },
    };

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
    // Quedan DOS entradas, y se sabe cuales: el lote va en orden de UID descendente, asi que el
    // uid 3 es el alta 501, el 2 la 502 (su write fallo) y el 1 la 503.
    expect(await valueOf(space, threadKey('<uid-3@fixtures.local>'))).toBe('501');
    expect(await valueOf(space, threadKey('<uid-2@fixtures.local>'))).toBeUndefined();
    expect(await valueOf(space, threadKey('<uid-1@fixtures.local>'))).toBe('503');
  });

  // TS-23
  it('TS-23: un mail sin Message-Id no escribe nada (put() no se invoca ni una vez)', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    const spy = spyOnSpace(space);

    await runTick(
      sourceWith(new Map([[1, fixture('no-message-id.eml')]])),
      BASE_CONFIG,
      logger,
      bus.client,
      spy.space,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({ descartados: 1, creados: 0 });
    expect(
      capture.lines().some((l) => l['motivo'] === 'sin_message_id'),
    ).toBe(true);
    expect(spy.puts).toEqual([]);
    // Y tampoco se leyo nada: el mail se descarto antes de rutearse.
    expect(spy.gets).toEqual([]);
  });

  // S-032: desde que el Mapa de Tickets vive en el mismo espacio, un mail nuevo SI hace un `get()`
  // —el de su slug—. Lo que se conserva es la propiedad de S-026: un mail nuevo NO lee el Mapa de
  // Hilos.
  it('un mail NUEVO no paga ningun round-trip de LECTURA al Mapa de Hilos (CA-12)', async () => {
    const space = await freshSpace();
    const { logger } = testLoggerWithCapture();
    await coreRespondeExito([500]);
    const spy = spyOnSpace(space);

    await runTick(sourceWith(new Map([[1, mailNuevo(1)]])), BASE_CONFIG, logger, bus.client, spy.space);

    // Su unica lectura es la consulta del slug; ninguna clave `hilos.*`.
    expect(spy.gets).toEqual(['tickets.alfa']);
    expect(spy.gets.filter((key) => key.startsWith('hilos.'))).toEqual([]);
    expect(spy.puts.map((put) => put.key)).toEqual([`hilos.${sha256('<uid-1@fixtures.local>')}`]);
  });
});

describe('runTick — el lookup en la rama de la respuesta (TS-24 a TS-28)', () => {
  // TS-24
  it('TS-24: una respuesta sin match se descarta como hilo_desconocido', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      space,
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
    const space = await freshSpace();
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
      space,
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

  // TS-27, INVERTIDO EN S-027 — y esta inversion es el valor entero de REQ-005.
  //
  // Hasta S-026 este caso afirmaba que una respuesta CON match se descartaba igual como
  // `es_respuesta`, porque todavia no habia salida por comentario. El comentario de aquel test
  // decia literalmente "TODAVIA NO HAY SALIDA POR COMENTARIO — estado intermedio desplegable y
  // deliberado". S-027 construye esa salida: ahora se comenta.
  it('TS-27: una respuesta CON match se publica como Comentario, no se descarta', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    const comentarios = await respondTo(bus.connection, 'requirements.*.comment', {
      status: 'success' as const,
      data: { id: 4242 },
    });
    await space.put(threadKey('<r1@x>'), '77');
    const spy = spyOnSpace(space);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      spy.space,
    );

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    // `comentados` en 1, y NADA en `descartados`: la respuesta se proceso, no se tiro.
    expect(tick).toMatchObject({ comentados: 1, descartados: 0, creados: 0, fallidos: 0 });

    // Ninguna linea de descarte para este mail.
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toBeUndefined();

    // El lookup corrio y resolvio — y el slug no se consulto: una respuesta con match se comenta
    // sin evaluarlo (invariante 26).
    expect(spy.gets).toEqual([`hilos.${sha256('<r1@x>')}`]);

    // Y el comentario viajo al subject del REQUISITO que el lookup resolvio (77), no a otro.
    expect(comentarios.count()).toBe(1);
    expect(comentarios.subjects()[0]).toContain('requirements.77.comment');

    await comentarios.stop();
  });

  // TS-28
  it('TS-28: el bucket inaccesible en caliente degrada a es_respuesta, no a hilo_desconocido', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([999]);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: '<r1@x>' })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingGet(space),
    );

    const lines = capture.lines();
    expect(lines.find((l) => l['msg'] === 'mail descartado')).toMatchObject({
      motivo: 'es_respuesta',
    });
    expect(lines.find((l) => l['msg'] === 'tick completado')).toMatchObject({ descartados: 1 });
  });

  it('el lookup NO se paga en los otros motivos de descarte (sin_slug, slug_no_mapeado)', async () => {
    const space = await freshSpace();
    const { logger } = testLoggerWithCapture();
    const spy = spyOnSpace(space);

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
      spy.space,
    );

    // S-032: `sin_slug` no hace ningun `get()`; `slug_no_mapeado` hace UNO, el de su slug (`beta`),
    // que es lo que decide que no esta mapeado. Ninguno de los dos lee el Mapa de Hilos.
    expect(spy.gets).toEqual(['tickets.beta']);
    expect(spy.gets.filter((key) => key.startsWith('hilos.'))).toEqual([]);
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
    const space = await freshSpace();
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
      space,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    // Ni una mas, ni una menos.
    expect(counterKeys(tick)).toEqual(
      ['comentados', 'creados', 'descartados', 'fallidos', 'ingestados', 'parseados'],
    );
    expect(tick).toMatchObject({ ingestados: 3, parseados: 3, creados: 3, comentados: 0 });
  });

  // TS-31, INVERTIDO EN S-027: la respuesta con match ya no engrosa `descartados` sino `comentados`.
  //
  // Lo que este caso protege de verdad —y no cambio— es que los DOS contadores no se contaminan
  // entre si: un comentario NO es un alta, y sumarlos borraria la distincion en la unica linea de
  // metricas que el tick emite (ADR-006, no hay healthcheck ni exportador).
  it('TS-31: 2 mails nuevos + 1 respuesta con match dan creados:2, comentados:1, descartados:0', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    // Solo DOS ids para `requirements.new`: si el tick publicara un ALTA por la respuesta, el
    // responder se quedaria sin respuestas y el fallo se veria en los contadores.
    await coreRespondeExito([810, 811]);
    const comentarios = await respondTo(bus.connection, 'requirements.*.comment', {
      status: 'success' as const,
      data: { id: 900 },
    });

    await space.put(threadKey('<viejo@x>'), '77');

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
      space,
    );

    const tick = capture.lines().find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 2,
      comentados: 1,
      descartados: 0,
      fallidos: 0,
    });

    // La separacion, medida en el bus y no solo en los contadores: DOS altas y UN comentario, cada
    // uno por su subject. `creados` no se contamina con el comentario ni al reves.
    expect(responder?.count()).toBe(2);
    expect(comentarios.count()).toBe(1);

    await comentarios.stop();
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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([600]);

    // La entrada ya existe: si el conector usara el bucket para deduplicar, este mail se saltearia.
    await space.put(threadKey('<uid-1@fixtures.local>'), '77');

    const source = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source, BASE_CONFIG, logger, bus.client, space);

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
    expect(await valueOf(space, threadKey('<uid-1@fixtures.local>'))).toBe('600');
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
describe('runTick — el ciclo completo de punta a punta (TS-40)', () => {
  // INVERTIDO EN S-027: el mismo tick mixto, ahora con la salida por comentario construida. Los
  // cuatro mails ejercitan los cuatro caminos que el tick puede tomar, en un solo lote.
  it('TS-40: un tick mixto deja los seis contadores exactos, el bucket coherente y los 4 UIDs \\Seen', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    // Un solo id disponible para el ALTA: si el tick publicara un alta de mas, el responder se
    // quedaria sin respuestas y el fallo seria visible en los contadores.
    await coreRespondeExito([500]);
    const comentarios = await respondTo(bus.connection, 'requirements.*.comment', {
      status: 'success' as const,
      data: { id: 901 },
    });

    await space.put(threadKey('<viejo@x>'), '77');
    const spy = spyOnSpace(space);

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

    await runTick(source, BASE_CONFIG, logger, bus.client, spy.space);

    const lines = capture.lines();
    const tick = lines.find((l) => l['msg'] === 'tick completado');
    expect(tick).toMatchObject({
      ingestados: 4,
      parseados: 4,
      creados: 1,
      // La respuesta con match ahora se comenta: es el efecto que S-027 construye.
      comentados: 1,
      // Y quedan DOS descartes, no tres: la respuesta sin match y el slug no mapeado.
      descartados: 2,
      fallidos: 0,
    });

    // El Mapa de Hilos termina con TRES entradas: la sembrada, la del mail nuevo, y —la que cierra
    // el ciclo— la de la RESPUESTA que se comento. Esa ultima es la que hace que una respuesta a la
    // respuesta rutee aunque el cliente recorte `References`. El `KV` del SDK no lista claves
    // (S-032), asi que se leen las tres por su clave.
    expect(await valueOf(space, threadKey('<viejo@x>'))).toBe('77');
    expect(await valueOf(space, threadKey('<uid-4@fixtures.local>'))).toBe('500');
    expect(await valueOf(space, threadKey('<reply-3@fixtures.local>'))).toBe('77');
    // Y se escribieron EXACTAMENTE dos: la del alta (mail nuevo, uid 4) y la de LA RESPUESTA que se
    // comento (uid 3). La segunda usa el Message-Id de la RESPUESTA y no el de la referencia que
    // matcheo: es lo que hace que una respuesta a la respuesta rutee.
    expect(spy.puts.map((put) => put.key).sort()).toEqual(
      [`hilos.${sha256('<uid-4@fixtures.local>')}`, `hilos.${sha256('<reply-3@fixtures.local>')}`].sort(),
    );

    // Los cuatro UIDs quedan \Seen: el Mapa de Hilos NO participa de la idempotencia (CA-14).
    expect(source.markSeenCalls).toEqual([4, 3, 2, 1]);

    // El lookup del hilo corrio SOLO en las dos respuestas, en el orden del lote. Las otras dos
    // lecturas son las consultas del slug de los dos mails nuevos (S-032).
    expect(spy.gets.filter((key) => key.startsWith('hilos.'))).toEqual([
      `hilos.${sha256('<viejo@x>')}`,
      `hilos.${sha256('<nadie@x>')}`,
    ]);
    expect(spy.gets).toEqual([
      'tickets.alfa',
      `hilos.${sha256('<viejo@x>')}`,
      `hilos.${sha256('<nadie@x>')}`,
      'tickets.beta',
    ]);

    // UN alta y UN comentario, cada uno por su subject. Los dos efectos coexisten sin mezclarse.
    expect(responder?.count()).toBe(1);
    expect(comentarios.count()).toBe(1);
    expect(comentarios.subjects()[0]).toContain('requirements.77.comment');

    const motivos = lines
      .filter((l) => l['msg'] === 'mail descartado')
      .map((l) => l['motivo']);
    expect(motivos.sort()).toEqual(['hilo_desconocido', 'slug_no_mapeado']);

    await comentarios.stop();
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
    const space = await freshSpace();
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
      space,
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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await coreRespondeExito([701]);

    // Un `put()` que rechaza es el camino que emite el `warn` con el `messageIdHash`.
    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(space),
    );

    // El hash SOLO, sin el prefijo `hilos.` de la clave: es lo que el `warn` nombra.
    const hash = sha256('<uid-1@fixtures.local>');
    const warn = capture.lines().find((l) => l['messageIdHash'] !== undefined);

    expect(warn?.['messageIdHash']).toBe(hash);
    // El valor sale entero, 64 chars de hex. Si el campo se llamara `key`, `REDACT_PATHS` lo
    // habria censurado sin fallar y sin avisar.
    expect(capture.raw().join('\n')).toContain(hash);
    expect(warn?.['key']).toBeUndefined();
    expect(JSON.stringify(warn)).not.toContain('[REDACTED]');
  });
});
