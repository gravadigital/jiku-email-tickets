import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { KV } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { startTicketMapWatch, type TicketMapWatch } from '#infra/kv/ticket-map.js';
import { sha256hex } from '#infra/kv/threads.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondTo } from '../bus/responder.js';
import { startJetStreamNats, type JetStreamNats } from '../infra/kv/helpers.js';
import { readSource } from '../shared/source-scan.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * S-028: las PROPIEDADES DEL SISTEMA afirmadas sobre `runTick()` cableado de punta a punta con el
 * KV real, no sobre modulos puros.
 *
 * Tarea 1 (CA-1, CA-2, TS-1 a TS-8) · Tarea 2 (CA-3, TS-10 a TS-15) · Tarea 3 (CA-4, CA-10, CA-11,
 * CA-12, TS-16 a TS-30) · Tarea 6 (CA-13, CA-14, TS-51 a TS-56).
 *
 * # POR QUE UN ARCHIVO NUEVO Y NO UNA EXTENSION
 *
 * `tick-redaction.test.ts` corre con `fakeThreadsKv()` (el doble EN MEMORIA) y sin la rama del
 * comentario: extenderlo obligaria a cambiarle la infraestructura a una suite que ya esta bien.
 * `tick-hilos.test.ts` ya tiene 834 lineas. Es el mismo criterio con el que S-022 creo
 * `tick-adjuntos-propiedades.test.ts`.
 *
 * # QUE SE EXTIENDE Y QUE NO SE DUPLICA
 *
 * Esta suite NO reescribe lo que ya esta afirmado. La linea de base es:
 *
 * - `tick-hilos.test.ts` (S-026/S-027): el write tras el alta, el reenvio interno, el TTL expirado,
 *   el bucket inaccesible, los seis contadores, el hash logueable. **Lo que falta y se agrega aca:**
 *   el TERCER caso de `hilo_desconocido` (bucket vacio = hilo anterior al despliegue), la
 *   INDISTINGUIBILIDAD de los tres como propiedad afirmada, y el ORDEN del write respecto del
 *   `success`.
 * - `tick-memory.test.ts` (S-016/S-022): la propiedad de memoria por inspeccion de `tick.ts`. **NO
 *   SE MODIFICA** — es la linea de base de CA-3, y aca solo se EXTIENDE a la rama del comentario, a
 *   `threads.ts` y al tamaño de la copia del mapa de slugs.
 * - `tick-redaction.test.ts` (S-016/S-022): la redaccion con el doble en memoria. Aca la propiedad
 *   se afirma con el KV REAL y con el texto del comentario que EFECTIVAMENTE VIAJO AL BUS.
 * - `infra/kv/source-properties.test.ts` (S-024/S-026): el `create()` ausente, el `watch()` ausente
 *   sobre hilos, la copia en memoria ausente, la posicion de `markSeen`. No se duplica.
 *
 * # LOS DOBLES
 *
 * Sistemas REALES: el bus (contenedor compartido, con responders de `core`) y el KV (contenedor
 * PROPIO con `-js`, porque el compartido arranca sin JetStream — ver la cabecera de
 * `test/infra/kv/helpers.ts`; NO se le agrega `-js` al compartido y NO se unifican los tags).
 *
 * Doblados solo en el BORDE: `MailSource` (IMAP) y el `PUT` prefirmado (servidor HTTP local). Y, en
 * los escenarios que lo exigen, un `KV` cuyo `put()`/`get()` RECHAZA envolviendo el handle REAL: un
 * bucket inaccesible en caliente no se puede provocar contra un contenedor sano sin tirarlo abajo.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

/** El texto sensible canonico del cuerpo de un mail nuevo. */
const SECRETO_MAIL = 'CONTENIDO-SECRETO-DEL-CLIENTE';
/** El texto sensible canonico del cuerpo de una respuesta (el que se vuelve el comentario). */
const SECRETO_RESPUESTA = 'RESPUESTA-SECRETA-DEL-CLIENTE';
/** El byte sensible canonico de un adjunto. */
const SECRETO_ADJUNTO = 'BYTES-SECRETOS-DEL-ADJUNTO';

/** La referencia que se siembra en el bucket para que una respuesta tenga match. */
const REFERENCIA_CON_MATCH = '<abc@cliente.com>';

/**
 * El `AppConfig` de los escenarios. Deliberadamente NO se reusa el `BASE_CONFIG` privado de
 * `test-logger.ts` (no se exporta) pero se le copia el bloque exacto que el Story Plan fija:
 * `ticketMap = { alfa: 42 }`, `subaddressPrefix = 'tickets'`, `maxPerTick = 50`, y el bloque `kv`.
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
    allowedExtensions: ['.png', '.jpg', '.pdf', '.txt'],
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
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

/** Un mail NUEVO (sin referencias) al slug mapeado `alfa`, con el cuerpo que se le indique. */
function mailNuevo(uid: number, body = `Cuerpo del mail ${String(uid)}.`): Buffer {
  return Buffer.from(
    `Message-Id: <uid-${String(uid)}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `${body}\r\n`,
  );
}

/** Una RESPUESTA al slug mapeado `alfa`, con los headers de hilo y el cuerpo indicados. */
function mailRespuesta(
  uid: number,
  headers: { inReplyTo?: string; references?: string },
  body = 'Respondo lo que preguntaste.',
): Buffer {
  return Buffer.from(
    `Message-Id: <reply-${String(uid)}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Re: Consulta\r\n' +
      (headers.inReplyTo === undefined ? '' : `In-Reply-To: ${headers.inReplyTo}\r\n`) +
      (headers.references === undefined ? '' : `References: ${headers.references}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `${body}\r\n`,
  );
}

/** Un mail al slug NO mapeado `beta`. */
function mailSlugNoMapeado(uid: number): Buffer {
  return Buffer.from(
    `Message-Id: <beta-${String(uid)}@fixtures.local>\r\n` +
      'From: cliente@cliente.com\r\n' +
      'To: tickets+beta@grava.io\r\n' +
      'Subject: Consulta\r\n\r\n' +
      'Cuerpo.\r\n',
  );
}

/** Un mail sin subaddress: cae en `sin_slug`. */
function mailSinSlug(uid: number): Buffer {
  return Buffer.from(
    `Message-Id: <sin-slug-${String(uid)}@fixtures.local>\r\n` +
      'From: cliente@cliente.com\r\n' +
      'To: soporte@grava.io\r\n' +
      'Subject: Consulta\r\n\r\n' +
      'Cuerpo.\r\n',
  );
}

/** Un bloque MIME de adjunto, con el boundary fijo que usa `mailConAdjuntos`. */
function attachmentPart(opts: { filename: string; mimeType: string; base64: string }): string {
  return (
    '--ATT-BOUNDARY\r\n' +
    `Content-Type: ${opts.mimeType}\r\n` +
    `Content-Disposition: attachment; filename="${opts.filename}"\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    `${opts.base64}\r\n`
  );
}

/** Un mail (nuevo o respuesta) con adjuntos, al slug mapeado `alfa`. */
function mailConAdjuntos(opts: {
  messageId: string;
  body?: string;
  parts: string[];
  inReplyTo?: string;
}): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Cliente" <cliente@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta con adjunto\r\n' +
      (opts.inReplyTo === undefined ? '' : `In-Reply-To: ${opts.inReplyTo}\r\n`) +
      'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--ATT-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      `${opts.body ?? 'Cuerpo del mail.'}\r\n` +
      opts.parts.join('') +
      '--ATT-BOUNDARY--\r\n',
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

/**
 * Envuelve el handle REAL y registra la clave y el INSTANTE de cada `get()`/`put()`.
 *
 * El instante (un contador monotonico propio, no el reloj) es lo que hace afirmable el ORDEN del
 * write respecto del `success` del comentario (TS-26) sin ningun sleep.
 */
function spyOn(real: KV): {
  kv: KV;
  gets: string[];
  puts: string[];
  putTicks: number[];
  tick: () => number;
} {
  const gets: string[] = [];
  const puts: string[] = [];
  const putTicks: number[] = [];
  let counter = 0;
  const tick = (): number => {
    counter += 1;
    return counter;
  };

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
          putTicks.push(tick());
          return target.put(key, value);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as KV;

  return { kv, gets, puts, putTicks, tick };
}

/** Un `KV` cuyo `put()` rechaza siempre; el `get()` sigue contra el real. */
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

/** Levanta un servidor HTTP local para el `PUT` prefirmado; el status lo decide el llamador. */
async function startHttpServer(
  onRequest: (requestIndex: number) => number,
): Promise<{ url: string; close: () => Promise<void>; requestCount: () => number }> {
  let requestCount = 0;
  const server: Server = createServer((req, res) => {
    const status = onRequest(requestCount);
    requestCount += 1;
    req.on('data', () => undefined);
    req.on('end', () => {
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}/upload`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requestCount: () => requestCount,
  };
}

let bus: TestBusContext;
let nats: JetStreamNats;
let bucketCounter = 0;
const openResponders: CoreResponder[] = [];
const openWatches: TicketMapWatch[] = [];

/**
 * Un bucket de hilos VACIO y propio por escenario.
 *
 * Sin aislamiento, el conteo de claves de un escenario ve las del anterior — y "el bucket tiene
 * exactamente las claves que tenia antes" (TS-20) seria inafirmable. Es el patron de
 * `tick-hilos.test.ts`.
 */
async function freshThreads(): Promise<KV> {
  bucketCounter += 1;
  const name = `S028_THREADS_${String(bucketCounter)}`;
  await nats.seedBucket(name);
  return nats.openBucket(name);
}

async function countKeys(threads: KV): Promise<number> {
  let count = 0;
  for await (const _key of await threads.keys()) count += 1;
  return count;
}

async function keysOf(threads: KV): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of await threads.keys()) keys.push(key);
  return keys.sort();
}

/** Da de alta un responder y lo registra para el teardown del escenario. */
async function responderFor(
  command: string,
  replies: Parameters<typeof respondTo>[2],
): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  openResponders.push(responder);
  return responder;
}

const tickLine = (capture: { lines(): Record<string, unknown>[] }): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

const discardLines = (capture: { lines(): Record<string, unknown>[] }): Record<string, unknown>[] =>
  capture.lines().filter((line) => line['msg'] === 'mail descartado');

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
  while (openWatches.length > 0) {
    openWatches.pop()?.stop();
  }
});

afterAll(async () => {
  await nats.stop();
  await bus.cleanup();
});

/* ==========================================================================================
 * TAREA 1 (CA-1, CA-2) — LA REDACCION SOBRE EL TICK COMPLETO
 *
 * Una filtracion aparece en la COMPOSICION de los modulos, no dentro de uno.
 * `test/publicacion/source-properties.test.ts` ya afirma que el publicador no loguea el payload ni
 * la description; lo que no puede afirmar es que la linea que emite el tick, la del write del
 * hilo, o la del descarte, no arrastren contenido por un campo INESPERADO.
 *
 * Por eso la asercion va sobre `capture.raw()` —la linea SERIALIZADA— y no sobre campos conocidos
 * del objeto parseado: un secreto que se colo por un campo que nadie penso no se ve mirando los
 * campos que si se pensaron.
 * ========================================================================================== */
describe('runTick — ninguna linea de log filtra contenido del cliente, con el KV real (CA-1, CA-2)', () => {
  /**
   * El lote MIXTO que los escenarios de esta seccion comparten: un mail nuevo, una respuesta CON
   * match, `sensitive-body.eml` con datos sensibles reales, y una respuesta SIN match.
   *
   * Los cuatro caminos del tick en un solo lote es lo que hace que la propiedad valga sobre la
   * composicion y no sobre un camino aislado.
   */
  async function correrLoteMixto(): Promise<{
    capture: ReturnType<typeof testLoggerWithCapture>['capture'];
    comentarios: CoreResponder;
    altas: CoreResponder;
    threads: KV;
  }> {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();

    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');

    // Dos ids para `requirements.new`: el mail nuevo y `sensitive-body`. Si el tick publicara un
    // alta de mas (por ejemplo si un `hilo_desconocido` cayera de vuelta al alta), el responder
    // repetiria la ultima respuesta y el exceso se veria en los contadores.
    const altas = await responderFor('requirements.new', [
      { status: 'success' as const, data: { id: 600 } },
      { status: 'success' as const, data: { id: 601 } },
    ]);
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 900 },
    });

    // `sensitive-body.eml` va a `soporte@grava.io` (sin subaddress): se le reescribe el
    // destinatario al slug mapeado para que llegue hasta el alta y ejercite el write del hilo. Es
    // el patron de `tick-hilos.test.ts` TS-38.
    const sensitive = fixture('sensitive-body.eml')
      .toString('utf8')
      .replace('To: soporte@grava.io', 'To: tickets+alfa@grava.io');

    await runTick(
      sourceWith(
        new Map([
          [4, mailNuevo(4, SECRETO_MAIL)],
          [3, mailRespuesta(3, { inReplyTo: REFERENCIA_CON_MATCH }, SECRETO_RESPUESTA)],
          [2, Buffer.from(sensitive)],
          [1, mailRespuesta(1, { inReplyTo: '<nadie@cliente.com>' })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    return { capture, comentarios, altas, threads };
  }

  // TS-1
  it('TS-1: un lote MIXTO no filtra el cuerpo del mail, el de la respuesta ni datos sensibles reales', async () => {
    const { capture } = await correrLoteMixto();

    // La asercion va sobre la linea SERIALIZADA, no sobre campos conocidos.
    const raw = capture.raw().join('\n');

    expect(raw).not.toContain(SECRETO_MAIL);
    expect(raw).not.toContain(SECRETO_RESPUESTA);
    expect(raw).not.toContain('mi tarjeta es');
    expect(raw).not.toContain('4111 1111 1111 1111');
  });

  // TS-2
  it('TS-2: ninguna linea contiene el texto del comentario que EFECTIVAMENTE VIAJO al bus', async () => {
    const { capture, comentarios } = await correrLoteMixto();

    expect(comentarios.count()).toBe(1);
    const payload = comentarios.payloads()[0] as Record<string, unknown>;
    const comment = payload['comment'];

    // La forma FUERTE de la propiedad: se afirma contra el texto que el BUS RECIBIO, no contra una
    // constante del test. Asi el escenario no puede pasar por casualidad si la composicion del
    // comentario cambia (un prefijo, un recorte, un placeholder distinto).
    expect(typeof comment).toBe('string');
    expect(String(comment).length).toBeGreaterThan(0);
    expect(capture.raw().join('\n')).not.toContain(String(comment));

    // Y linea por linea, no solo sobre el join: una linea sola no lo contiene tampoco.
    for (const line of capture.raw()) {
      expect(line).not.toContain(String(comment));
    }
  });

  // TS-3
  it('TS-3: ninguna linea filtra el contenido de un adjunto ni la uploadUrl', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    const http = await startHttpServer(() => 200);

    await responderFor('files.request-upload', {
      status: 'success' as const,
      data: { fileId: 7, uploadUrl: http.url },
    });
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 610 } });

    const mail = mailConAdjuntos({
      messageId: '<con-adjunto@fixtures.local>',
      body: SECRETO_MAIL,
      parts: [
        attachmentPart({
          filename: 'informe.txt',
          mimeType: 'text/plain',
          base64: Buffer.from(SECRETO_ADJUNTO).toString('base64'),
        }),
      ],
    });

    try {
      await runTick(sourceWith(new Map([[1, mail]])), BASE_CONFIG, logger, bus.client, threads);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });
      // El `PUT` se hizo: la propiedad se afirma sobre un camino que de verdad subio el byte.
      expect(http.requestCount()).toBe(1);

      const raw = capture.raw().join('\n');
      expect(raw).not.toContain(SECRETO_ADJUNTO);
      expect(raw).not.toContain(http.url);
      // Ni el cuerpo del mail que lo acompaña.
      expect(raw).not.toContain(SECRETO_MAIL);
    } finally {
      await http.close();
    }
  });

  // TS-4
  it('TS-4: cada linea es JSON valido y lines() cuenta lo mismo que raw()', async () => {
    const { capture } = await correrLoteMixto();

    // Una filtracion por INTERPOLACION en el texto del mensaje rompe el JSON, o mete el dato en
    // `msg`. Las dos cosas se detectan aca.
    for (const line of capture.raw()) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(capture.lines()).toHaveLength(capture.raw().length);
    expect(capture.raw().length).toBeGreaterThan(4);
  });

  // TS-5
  it('TS-5: cada uno de los cuatro Message-Id aparece en al menos una linea (ningun mail sin rastro)', async () => {
    const { capture } = await correrLoteMixto();
    const raw = capture.raw().join('\n');

    // ADR-006: "cada mail procesado MUST dejar al menos una linea de log con su messageId y su
    // resultado. Ningun mail termina sin rastro."
    for (const messageId of [
      '<uid-4@fixtures.local>',
      '<reply-3@fixtures.local>',
      '<sensitive-body-001@fixtures.local>',
      '<reply-1@fixtures.local>',
    ]) {
      expect(raw, `${messageId} debe dejar rastro en el log`).toContain(messageId);
    }
  });

  // TS-6
  it('TS-6: el Message-Id sale EN CLARO — el hash no lo reemplaza en el log, solo en la clave', async () => {
    const { capture } = await correrLoteMixto();
    const lines = capture.lines();

    const conMessageId = lines.filter((line) => typeof line['messageId'] === 'string');
    expect(conMessageId.length).toBeGreaterThan(0);

    for (const line of conMessageId) {
      const value = String(line['messageId']);
      // En claro: con sus brackets, y sin censurar.
      expect(value).toMatch(/^<.+>$/);
      expect(value).not.toBe('[REDACTED]');
      // Y NO es el hash: 64 chars de hex serian el hash puesto en el lugar del identificador.
      expect(value).not.toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // TS-7 (CA-2)
  it('TS-7: el messageIdHash sale LITERAL, sin censurar, y el campo NO se llama key', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 620 } });

    // El `put()` que rechaza es el camino que emite el `warn` con el `messageIdHash`.
    await runTick(
      sourceWith(new Map([[1, mailNuevo(1, SECRETO_MAIL)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(threads),
    );

    const hash = sha256hex('<uid-1@fixtures.local>');
    const warn = capture.lines().find((line) => line['messageIdHash'] !== undefined);

    expect(warn).toBeDefined();
    expect(warn?.['messageIdHash']).toBe(hash);
    // 64 chars de hex, enteros. Que el hash aparezca NO es una violacion: es un hash, no contenido
    // del cliente (REQ-005 §Seguridad).
    expect(String(warn?.['messageIdHash'])).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.raw().join('\n')).toContain(hash);

    // Y el campo NO se llama `key`: `REDACT_PATHS` incluye `'key'` y `'*.key'` para cubrir la clave
    // privada del machine user, asi que un campo llamado `key` saldria `[REDACTED]` SIN FALLAR Y
    // SIN AVISAR — el hash se perderia del log y nadie se enteraria.
    expect(warn?.['key']).toBeUndefined();
    expect(JSON.stringify(warn)).not.toContain('[REDACTED]');
    // Y el cuerpo del mail sigue sin filtrarse por este camino.
    expect(capture.raw().join('\n')).not.toContain(SECRETO_MAIL);
  });

  // TS-8: la CONTRACARA. Sin este caso, los de arriba pasarian igual con la redaccion apagada.
  it('TS-8: la contracara — un comment logueado a proposito SI sale censurado, en las dos formas', async () => {
    const { logger, capture } = testLoggerWithCapture();

    logger.info({ comment: SECRETO_RESPUESTA }, 'prueba de redaccion, forma plana');
    logger.info({ payload: { comment: SECRETO_RESPUESTA } }, 'prueba de redaccion, forma anidada');

    const raw = capture.raw().join('\n');

    // Las DOS formas: `'comment'` y `'*.comment'` estan en `REDACT_PATHS` desde S-027.
    expect(raw).not.toContain(SECRETO_RESPUESTA);
    expect(raw).toContain('[REDACTED]');
    // Dos lineas, las dos censuradas: si solo una lo estuviera, la lista tendria un hueco.
    expect(capture.raw().filter((line) => line.includes('[REDACTED]'))).toHaveLength(2);
  });
});

/* ==========================================================================================
 * TAREA 2 (CA-3) — EL PICO DE MEMORIA DE UN MAIL A LA VEZ
 *
 * `test/ingesta/tick-memory.test.ts` es la LINEA DE BASE de S-016/S-022 y NO SE MODIFICA. Este
 * bloque la EXTIENDE a las tres piezas que REQ-005 agrego y que su escaneo no cubre: la rama del
 * comentario, el lookup del Mapa de Hilos, y el tamaño de la copia del mapa de slugs.
 *
 * # POR QUE POR INSPECCION Y NO MIDIENDO EL HEAP (TS-14)
 *
 * Medir `heapUsed` sin `--expose-gc` no es fiable: el GC decide cuando corre, y el delta de dos
 * lotes de tamaños distintos varia entre corridas por razones que no tienen nada que ver con el
 * codigo bajo test. Un test intermitente en una suite cuyo valor entero es la CONFIANZA es peor que
 * no tenerlo: el primero que lo vea rojo sin causa lo va a marcar `skip`, y ahi se pierde tambien
 * la cobertura que si servia.
 *
 * Asi que TS-14 se resuelve por INSPECCION (TS-10 a TS-13), que es exactamente lo que S-016 y S-022
 * ya hacen para la misma propiedad, mas la asercion de COMPORTAMIENTO de TS-13 —el tamaño de la
 * copia del mapa no depende del lote—, que si es determinista.
 * ========================================================================================== */
describe('la propiedad de memoria se EXTIENDE a la rama del comentario y al KV (CA-3)', () => {
  const TICK = readSource('domain/ingesta/tick.ts');
  const THREADS = readSource('infra/kv/threads.ts');
  const COMMENT = readSource('domain/publicacion/publish-comment.ts');

  it('sanity: los tres archivos se pudieron leer y tienen contenido real', () => {
    // Sin esto, un path roto haria pasar todo lo de abajo contra strings vacios, en verde y sin
    // verificar nada. Es la regla del repo para todo escaner.
    expect(TICK.length).toBeGreaterThan(500);
    expect(THREADS.length).toBeGreaterThan(500);
    expect(COMMENT.length).toBeGreaterThan(500);
    expect(TICK).toContain('export async function runTick');
    expect(THREADS).toContain('export async function lookupThread');
    expect(COMMENT).toContain('export async function publishCommentFromMail');
  });

  // TS-10
  it('TS-10: la rama del comentario no declara ningun acumulador y corre DENTRO del for del lote', () => {
    const ramaIdx = TICK.indexOf("'intencion' in route");
    const publishIdx = TICK.indexOf('publishCommentFromMail(');
    const lookupIdx = TICK.indexOf('lookupThread(');
    const adjuntosIdx = TICK.indexOf('procesarAdjuntosDelMail(');

    expect(ramaIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(ramaIdx);
    expect(publishIdx).toBeGreaterThan(lookupIdx);

    // El escaneo se ACOTA a la region, no al archivo entero: `tick.ts` menciona "array" y "acumula"
    // en sus comentarios explicando lo que NO hace, y aunque el helper ya los stripea, afirmar
    // sobre todo el archivo afirmaria sobre la rama equivocada.
    const rama = TICK.slice(ramaIdx, TICK.indexOf('recordThreadEntry(', publishIdx));
    expect(rama.length).toBeGreaterThan(200);

    expect(rama).not.toMatch(/=\s*\[\s*\]/);
    expect(rama).not.toMatch(/new\s+Array\s*\(/);
    expect(rama).not.toMatch(/\.push\s*\(/);

    // Y la rama entera vive DENTRO del `for (const uid of batch)`: el `for` abre antes que ella.
    const forIdx = TICK.search(/for\s*\(\s*const\s+uid\s+of\s+batch\s*\)/);
    expect(forIdx).toBeGreaterThan(-1);
    expect(forIdx).toBeLessThan(ramaIdx);

    // `procesarAdjuntosDelMail()` de la rama del comentario tambien: entre el lookup y el publish.
    const adjuntosEnRama = TICK.indexOf('procesarAdjuntosDelMail(', lookupIdx);
    expect(adjuntosEnRama).toBeGreaterThan(lookupIdx);
    expect(adjuntosEnRama).toBeLessThan(publishIdx);
    // (y el del alta sigue antes, que es lo que `tick-memory.test.ts` ya afirma)
    expect(adjuntosIdx).toBeGreaterThan(-1);
    expect(adjuntosIdx).toBeLessThan(lookupIdx);
  });

  // TS-11
  it('TS-11: el lookup NO acumula — sin Promise.all sobre las referencias, y CORTA en el primer hit', () => {
    expect(THREADS).not.toMatch(/Promise\.all\s*\(/);
    expect(THREADS).not.toMatch(/Promise\.allSettled\s*\(/);

    // El bucle es secuencial y sobre las referencias.
    expect(THREADS).toMatch(/for\s*\(\s*const\s+referenceId\s+of\s+referenceIds\s*\)/);

    // Y CORTA dentro del loop: es el `return { found: true, ... }`. Sin el corte se pagarian N
    // round-trips donde el diseño paga 1, y se borraria el ORDEN que hace ganar a `In-Reply-To`.
    const loopIdx = THREADS.search(/for\s*\(\s*const\s+referenceId\s+of\s+referenceIds\s*\)/);
    const finalReturnIdx = THREADS.indexOf('return { found: false, consultable: true }');
    expect(finalReturnIdx).toBeGreaterThan(loopIdx);
    const loopBody = THREADS.slice(loopIdx, finalReturnIdx);
    expect(loopBody).toMatch(/return\s*\{\s*found:\s*true/);

    // Ningun acumulador dentro del loop tampoco.
    expect(loopBody).not.toMatch(/\.push\s*\(/);
    expect(loopBody).not.toMatch(/=\s*\[\s*\]/);
  });

  // TS-12 — el complemento del que `infra/kv/source-properties.test.ts` ya afirma (TS-34 de S-026):
  // alla se afirma la AUSENCIA de `Map`/`Set`/`Record`/`let` de modulo; aca la razon POSITIVA, que
  // es que el unico estado del modulo llega por parametro. Un `Map` aca seria un mapa creciendo
  // sin techo: el bucket de hilos tiene una entrada POR MAIL.
  it('TS-12: el Mapa de Hilos no tiene copia en memoria — su unico estado llega por parametro', () => {
    // Ninguna variable de modulo: todo `const`/`let` de columna 0 que no sea un `import`, un
    // `export` de funcion o de tipo, seria estado del modulo.
    const moduleLevelDeclarations = THREADS.split('\n').filter((line) =>
      /^(?:const|let|var)\s/.test(line),
    );
    expect(moduleLevelDeclarations).toEqual([]);

    // Y no hay `watch(` en ninguna forma: es `get()` puntual, deliberadamente distinto del Mapa de
    // Tickets, que si tiene copia porque son decenas de entradas que administra un humano.
    expect(THREADS).not.toMatch(/watch\s*\(/);
    expect(THREADS).toMatch(/threads\s*\.\s*get\s*\(/);
  });

  // TS-15
  it('TS-15: ni el tick, ni el lookup, ni el publicador del comentario usan Promise.all sobre el lote (ADR-001)', () => {
    for (const [name, code] of [
      ['tick.ts', TICK],
      ['threads.ts', THREADS],
      ['publish-comment.ts', COMMENT],
    ] as const) {
      expect(code, `${name} usa Promise.all`).not.toMatch(/Promise\.all\s*\(/);
      expect(code, `${name} usa Promise.allSettled`).not.toMatch(/Promise\.allSettled\s*\(/);
    }
  });

  // TS-13 — la mitad de COMPORTAMIENTO, y la unica medicion de esta seccion que es determinista.
  it('TS-13: la copia del mapa de slugs es del tamaño del MAPA, no del lote (30 mails, mapa de 3)', async () => {
    bucketCounter += 1;
    const bucket = `S028_TICKETS_${String(bucketCounter)}`;
    await nats.seedBucket(bucket);
    const tickets = await nats.openBucket(bucket);
    for (const [slug, projectId] of [
      ['alfa', '42'],
      ['beta', '7'],
      ['gamma', '13'],
    ] as const) {
      await tickets.put(slug, new TextEncoder().encode(projectId));
    }

    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();

    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket } },
      logger,
    });
    openWatches.push(watch);

    // El `config` FINAL, cuyo `ruteo.ticketMap` ES el `Map` vivo del watch.
    const config: AppConfig = {
      ...BASE_CONFIG,
      ruteo: { ...BASE_CONFIG.ruteo, ticketMap: watch.ticketMap },
    };

    expect(watch.ticketMap.size).toBe(3);
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 630 } });

    // 30 mails: diez veces el tamaño del mapa. Si el tick copiara algo por mail al mapa, o si el
    // mapa fuera del tamaño del lote, esto se veria.
    const lote = new Map<number, Buffer>();
    for (let uid = 30; uid >= 1; uid -= 1) lote.set(uid, mailNuevo(uid));

    await runTick(sourceWith(lote), config, logger, bus.client, threads);

    expect(tickLine(capture)).toMatchObject({ ingestados: 30, parseados: 30, creados: 30 });

    // El tamaño del mapa NO cambio: el tick no agrega ni saca entradas. La unica mutacion del mapa
    // es la del watch, y aca no llego ninguna.
    expect(watch.ticketMap.size).toBe(3);
    expect(config.ruteo.ticketMap.size).toBe(3);
    // Y es EL MISMO objeto: si el tick lo hubiera reemplazado por una copia, la propiedad de
    // ADR-004 (la copia se muta, nunca se reemplaza) estaria rota y el ruteo en caliente muerto.
    expect(config.ruteo.ticketMap).toBe(watch.ticketMap);
  }, 60_000);
});

/* ==========================================================================================
 * TAREA 3 (CA-4) — `hilo_desconocido` NO CREA NADA, EN LOS TRES CASOS QUE LO PRODUCEN
 *
 * Los tres son INDISTINGUIBLES A PROPOSITO: un reenvio de hilo interno, una entrada expirada por
 * el TTL, y un hilo anterior al despliegue significan lo mismo operativamente —"esta respuesta
 * apunta a un hilo que no conozco"— y el arreglo es el mismo.
 *
 * `tick-hilos.test.ts` ya cubre los DOS primeros por separado (TS-25 y TS-26 de S-026). Lo que se
 * agrega aca: el TERCERO (bucket vacio = despliegue nuevo), la afirmacion de que ninguno de los
 * tres CREA ni ESCRIBE nada, y la INDISTINGUIBILIDAD como propiedad afirmada comparando las tres
 * lineas entre si.
 * ========================================================================================== */
describe('runTick — los TRES casos de hilo_desconocido no crean nada (CA-4)', () => {
  /** El resultado observable de un tick de un solo mail contra un bucket dado. */
  async function correrUnMail(
    mail: Buffer,
    prepararBucket?: (threads: KV) => Promise<void>,
  ): Promise<{
    line: Record<string, unknown> | undefined;
    tick: Record<string, unknown> | undefined;
    altas: CoreResponder;
    comentarios: CoreResponder;
    puts: string[];
    clavesAntes: string[];
    clavesDespues: string[];
  }> {
    const threads = await freshThreads();
    await prepararBucket?.(threads);

    const { logger, capture } = testLoggerWithCapture();
    // Los DOS responders con exito disponible: si el tick publicara algo, se veria. Afirmar
    // `count() === 0` con un responder que PODIA contestar es mas fuerte que sin responder.
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 999 },
    });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 998 },
    });

    const clavesAntes = await keysOf(threads);
    const spy = spyOn(threads);

    await runTick(sourceWith(new Map([[1, mail]])), BASE_CONFIG, logger, bus.client, spy.kv);

    return {
      line: discardLines(capture)[0],
      tick: tickLine(capture),
      altas,
      comentarios,
      puts: spy.puts,
      clavesAntes,
      clavesDespues: await keysOf(threads),
    };
  }

  // TS-16 — CASO 1: el reenvio de un hilo interno, con slug mapeado y `References` poblado.
  it('TS-16: caso 1 — el reenvio de un hilo interno; el slug mapeado NO lo salva', async () => {
    const result = await correrUnMail(
      Buffer.from(
        'Message-Id: <fwd-1@grava.io>\r\n' +
          'From: "Interno" <empleado@grava.io>\r\n' +
          'To: tickets+alfa@grava.io\r\n' +
          'Subject: Fwd: hilo interno\r\n' +
          'References: <interno-1@grava.io> <interno-2@grava.io>\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
          'Reenvio esto.\r\n',
      ),
    );

    expect(result.line).toMatchObject({
      messageId: '<fwd-1@grava.io>',
      motivo: 'hilo_desconocido',
    });
    expect(result.tick).toMatchObject({
      descartados: 1,
      creados: 0,
      comentados: 0,
      fallidos: 0,
    });
    // La rama de la RESPUESTA se evalua ANTES de tocar el slug: `alfa` esta mapeado y aun asi no
    // se crea nada. Es la aserción que distingue "no se creo porque no habia slug" de "no se creo
    // porque es una respuesta a un hilo que no conozco".
    expect(result.altas.count()).toBe(0);
    expect(result.comentarios.count()).toBe(0);
  });

  // TS-17 — CASO 2: la entrada expiro por el TTL. Y NO crea un Requisito duplicado.
  it('TS-17: caso 2 — la entrada expiro por el TTL, y NO crea un Requisito duplicado', async () => {
    const result = await correrUnMail(
      mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH }),
      async (threads) => {
        // El TTL de 90 dias no se puede esperar en un test. Lo que el `get()` ve al expirar una
        // entrada es EXACTAMENTE lo que ve tras un `delete()`: la clave no esta. Se siembra y se
        // borra, que es la unica forma honesta de expresarlo.
        await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
        await threads.delete(sha256hex(REFERENCIA_CON_MATCH));
      },
    );

    expect(result.line).toMatchObject({ motivo: 'hilo_desconocido' });
    expect(result.tick).toMatchObject({ descartados: 1, creados: 0, comentados: 0 });
    // LA ASERCION CENTRAL DEL CASO: un `hilo_desconocido` NO cae de vuelta al alta. Si lo hiciera,
    // cada respuesta a un hilo viejo crearia un requisito DUPLICADO, que es el modo de falla que
    // el motivo propio existe para evitar.
    expect(result.altas.count()).toBe(0);
    expect(result.comentarios.count()).toBe(0);
  });

  // TS-18 — CASO 3: un hilo anterior al despliegue. Es el caso que faltaba.
  it('TS-18: caso 3 — un hilo anterior al despliegue (bucket VACIO, el estado de todo despliegue nuevo)', async () => {
    const result = await correrUnMail(mailRespuesta(1, { inReplyTo: '<viejo@cliente.com>' }));

    // El bucket vacio ES el estado de un despliegue nuevo: no hace falta simular nada mas.
    expect(result.clavesAntes).toEqual([]);
    expect(result.line).toMatchObject({ motivo: 'hilo_desconocido' });
    expect(result.tick).toMatchObject({ descartados: 1, creados: 0, comentados: 0, fallidos: 0 });
    expect(result.altas.count()).toBe(0);
    expect(result.comentarios.count()).toBe(0);
  });

  // TS-19 — LA INDISTINGUIBILIDAD, afirmada comparando las tres lineas ENTRE SI.
  it('TS-19: los tres casos son INDISTINGUIBLES — mismo msg, mismo motivo, ningun campo diferenciador', async () => {
    const fwd = await correrUnMail(
      Buffer.from(
        'Message-Id: <fwd-2@grava.io>\r\n' +
          'From: "Interno" <empleado@grava.io>\r\n' +
          'To: tickets+alfa@grava.io\r\n' +
          'Subject: Fwd: hilo interno\r\n' +
          'References: <interno-3@grava.io>\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
          'Reenvio.\r\n',
      ),
    );
    const expirada = await correrUnMail(
      mailRespuesta(2, { inReplyTo: REFERENCIA_CON_MATCH }),
      async (threads) => {
        await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
        await threads.delete(sha256hex(REFERENCIA_CON_MATCH));
      },
    );
    const anterior = await correrUnMail(mailRespuesta(3, { inReplyTo: '<viejo@cliente.com>' }));

    const lineas = [fwd.line, expirada.line, anterior.line];
    for (const line of lineas) expect(line).toBeDefined();

    // El mismo `msg` y el mismo `motivo` en los tres.
    expect(lineas.map((l) => l?.['msg'])).toEqual([
      'mail descartado',
      'mail descartado',
      'mail descartado',
    ]);
    expect(lineas.map((l) => l?.['motivo'])).toEqual([
      'hilo_desconocido',
      'hilo_desconocido',
      'hilo_desconocido',
    ]);

    // Y NINGUN campo diferenciador: la FORMA de la linea es identica, salvo el `messageId` (que es
    // del mail, no del caso) y el `time` de pino. Se compara el juego de claves entre si, no cada
    // uno contra una constante: es lo que detecta que alguien agregue un campo "para ayudar al
    // diagnostico" y rompa la propiedad sin querer.
    //
    // ES DELIBERADO. Los tres significan lo mismo operativamente y el arreglo es el mismo; un
    // campo que los distinga invitaria a tratarlos distinto, y no hay nada distinto que hacer.
    const shape = (line: Record<string, unknown> | undefined): string[] =>
      Object.keys(line ?? {})
        .filter((key) => key !== 'time' && key !== 'messageId')
        .sort();
    expect(shape(expirada.line)).toEqual(shape(fwd.line));
    expect(shape(anterior.line)).toEqual(shape(fwd.line));
  });

  // TS-20 — ninguno de los tres deja NADA escrito.
  it('TS-20: los tres casos no dejan nada escrito — put() no se invoca ni una vez', async () => {
    const fwd = await correrUnMail(
      Buffer.from(
        'Message-Id: <fwd-3@grava.io>\r\n' +
          'From: "Interno" <empleado@grava.io>\r\n' +
          'To: tickets+alfa@grava.io\r\n' +
          'Subject: Fwd\r\n' +
          'References: <interno-4@grava.io>\r\n\r\n' +
          'Reenvio.\r\n',
      ),
    );
    const expirada = await correrUnMail(
      mailRespuesta(4, { inReplyTo: REFERENCIA_CON_MATCH }),
      async (threads) => {
        await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
        await threads.delete(sha256hex(REFERENCIA_CON_MATCH));
      },
    );
    const anterior = await correrUnMail(mailRespuesta(5, { inReplyTo: '<viejo@cliente.com>' }));

    for (const result of [fwd, expirada, anterior]) {
      // El bucket queda EXACTAMENTE como estaba.
      expect(result.clavesDespues).toEqual(result.clavesAntes);
      // Y el `put()` no se llamo: la asercion sobre el KV espia que envuelve el handle REAL, no
      // sobre un doble. Sin esto, un `put()` que escribiera y borrara pasaria inadvertido.
      expect(result.puts).toEqual([]);
    }

    // Y el caso del despliegue nuevo termina con el bucket vacio, como empezo.
    expect(anterior.clavesDespues).toEqual([]);
  });
});

/* ==========================================================================================
 * TAREA 3 (CA-10) — EL WRITE QUE FALLA NO CANCELA EL ALTA
 * ========================================================================================== */
describe('runTick — el write que falla NO cancela el alta (CA-10)', () => {
  // TS-21
  it('TS-21: creados NO se revierte, y el warn nombra messageId, messageIdHash y requirementId', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 600 } });

    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(threads),
    );

    // El requisito YA EXISTE en Jiku y no hay comando de compensacion (invariante 9): revertir el
    // contador mentiria sobre lo que paso.
    expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0, descartados: 0 });

    const warn = capture
      .lines()
      .find((line) => line['level'] === 'warn' && line['requirementId'] === 600);
    expect(warn).toBeDefined();
    expect(warn?.['messageId']).toBe('<uid-1@fixtures.local>');
    expect(warn?.['messageIdHash']).toBe(sha256hex('<uid-1@fixtures.local>'));
    expect(String(warn?.['msg'])).toContain('no se pudo escribir la entrada del Mapa de Hilos');
  });

  // TS-22
  it('TS-22: el tick sigue con el resto del lote — tres altas, tres warns, tres publicaciones', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    const altas = await responderFor('requirements.new', [
      { status: 'success' as const, data: { id: 601 } },
      { status: 'success' as const, data: { id: 602 } },
      { status: 'success' as const, data: { id: 603 } },
    ]);

    const source = sourceWith(
      new Map([
        [3, mailNuevo(3)],
        [2, mailNuevo(2)],
        [1, mailNuevo(1)],
      ]),
    );

    await runTick(source, BASE_CONFIG, logger, bus.client, withFailingPut(threads));

    expect(tickLine(capture)).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 3,
      fallidos: 0,
      descartados: 0,
    });
    // Un warn POR MAIL: el fallo del write no corta el `for`.
    expect(
      capture
        .lines()
        .filter((line) => String(line['msg']).includes('no se pudo escribir la entrada')),
    ).toHaveLength(3);
    expect(altas.count()).toBe(3);
    expect(source.markSeenCalls).toEqual([3, 2, 1]);
    // Y el bucket quedo vacio: los tres writes fallaron.
    expect(await countKeys(threads)).toBe(0);
  });

  // TS-23
  it('TS-23: con el bucket inaccesible una RESPUESTA es es_respuesta, NO hilo_desconocido', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 999 },
    });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 998 },
    });

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingGet(threads),
    );

    // LA DISTINCION IMPORTA, y es la razon de que `ThreadLookupResult` tenga TRES estados y no
    // `number | undefined`: `hilo_desconocido` se arregla CARGANDO EL HILO (o aceptando que expiro);
    // `es_respuesta` se arregla ARREGLANDO EL BUCKET. Colapsarlos mandaria al operador al lugar
    // equivocado.
    expect(discardLines(capture)[0]).toMatchObject({
      messageId: '<reply-1@fixtures.local>',
      motivo: 'es_respuesta',
    });
    expect(discardLines(capture)[0]?.['motivo']).not.toBe('hilo_desconocido');
    expect(tickLine(capture)).toMatchObject({ descartados: 1, comentados: 0, creados: 0 });

    // Y la linea del fallo de la consulta esta, que es la que dice DONDE mirar.
    expect(
      capture
        .lines()
        .some((line) => String(line['msg']).includes('no se pudo consultar el Mapa de Hilos')),
    ).toBe(true);

    expect(altas.count()).toBe(0);
    expect(comentarios.count()).toBe(0);
  });
});

/* ==========================================================================================
 * TAREA 3 (CA-11) — EL WRITE DEL COMENTARIO CONDICIONADO AL `success`
 *
 * Un write anticipado dejaria el bucket apuntando a UN COMENTARIO QUE NO EXISTE, y la proxima
 * respuesta rutearia a un hilo cuyo ultimo eslabon se perdio.
 * ========================================================================================== */
describe('runTick — el write del comentario esta condicionado al success (CA-11)', () => {
  // TS-24
  it('TS-24: si el comentario FALLA, la entrada del Message-Id de la respuesta NO existe', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');

    await responderFor('requirements.new', { status: 'success' as const, data: { id: 999 } });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'failure' as const,
      errorCode: 'requirement_not_found',
    });

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH })]])),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    // NO existe la entrada de la respuesta.
    expect(await threads.get(sha256hex('<reply-1@fixtures.local>'))).toBeNull();
    // Y el bucket sigue teniendo SOLO la sembrada.
    expect(await keysOf(threads)).toEqual([sha256hex(REFERENCIA_CON_MATCH)]);

    expect(tickLine(capture)).toMatchObject({ fallidos: 1, comentados: 0, creados: 0 });
    expect(comentarios.count()).toBe(1);

    // La linea del rechazo lleva el `code` literal y su diagnostico, sin mapearlo a otro error.
    const error = capture.lines().find((line) => line['level'] === 'error');
    expect(error).toBeDefined();
    expect(error?.['code']).toBe('requirement_not_found');
    expect(error?.['diagnosis']).toBe('core_rechazo_desconocido');
  });

  // TS-25
  it('TS-25: y el tick continua con los mails restantes del lote', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');

    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 604 },
    });
    // El PRIMERO falla, el segundo tiene exito: la secuencia del responder lo expresa sin
    // resuscribir a mitad del test.
    const comentarios = await responderFor('requirements.*.comment', [
      { status: 'failure' as const, errorCode: 'requirement_not_found' },
      { status: 'success' as const, data: { id: 901 } },
    ]);

    const source = sourceWith(
      new Map([
        [3, mailRespuesta(3, { inReplyTo: REFERENCIA_CON_MATCH })],
        [2, mailNuevo(2)],
        [1, mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH })],
      ]),
    );

    await runTick(source, BASE_CONFIG, logger, bus.client, threads);

    expect(tickLine(capture)).toMatchObject({
      ingestados: 3,
      parseados: 3,
      fallidos: 1,
      creados: 1,
      comentados: 1,
      descartados: 0,
    });
    expect(altas.count()).toBe(1);
    expect(comentarios.count()).toBe(2);
    // Los tres UIDs quedaron \Seen: el `\Seen` es INMEDIATO y anterior a todo, y un comentario
    // fallido no lo revierte (no hay forma de revertirlo, y ADR-001 lo asume).
    expect(source.markSeenCalls).toEqual([3, 2, 1]);

    // El bucket tiene la sembrada, la del alta y la de LA RESPUESTA QUE SI COMENTO. La de la que
    // fallo no esta: son tres, no cuatro.
    expect(await keysOf(threads)).toEqual(
      [
        sha256hex(REFERENCIA_CON_MATCH),
        sha256hex('<uid-2@fixtures.local>'),
        sha256hex('<reply-1@fixtures.local>'),
      ].sort(),
    );
  });

  // TS-26 — EL ORDEN, sin sleeps: un contador monotonico en el espia y en el handler.
  it('TS-26: el put() ocurre DESPUES de que el responder contesto; con el responder mudo no hay put()', async () => {
    const threads = await freshThreads();
    const { logger } = testLoggerWithCapture();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
    const spy = spyOn(threads);

    // El instante de la recepcion se toma del MISMO contador monotonico que el espia del `put()`.
    //
    // Y se toma DENTRO del handler de la suscripcion, no poll-eando `count()` desde afuera: entre
    // que el responder recibe y que un poll de 15 ms lo observa, el tick ya hizo el `put()`, asi
    // que la comparacion daria al reves y el test seria un falso rojo. Comparar `Date.now()` no
    // sirve tampoco: tiene resolucion de milisegundo y los dos eventos caen en el mismo valor.
    //
    // Por eso este escenario NO usa `respondTo()`: necesita un punto de instrumentacion que el
    // helper compartido no expone, y ensancharselo por un solo caso le agregaria superficie a algo
    // que usan diez suites.
    let recepcionTick: number | undefined;
    const encoder = new TextEncoder();
    const subscription = bus.connection.subscribe('*.*.jiku-commands.v1.requirements.*.comment');
    void (async () => {
      for await (const message of subscription) {
        recepcionTick = spy.tick();
        message.respond(
          encoder.encode(JSON.stringify({ status: 'success', data: { id: 902 } })),
        );
      }
    })();
    await bus.connection.flush();

    try {
      await runTick(
        sourceWith(new Map([[1, mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH })]])),
        BASE_CONFIG,
        logger,
        bus.client,
        spy.kv,
      );

      // El `put()` de la RESPUESTA ocurrio, y DESPUES de que el responder recibio y contesto.
      expect(spy.puts).toEqual([sha256hex('<reply-1@fixtures.local>')]);
      expect(recepcionTick).toBeDefined();
      expect(spy.putTicks[0]).toBeGreaterThan(Number(recepcionTick));
    } finally {
      await subscription.drain();
    }

    // Y la contracara: con el responder MUDO (recibe y no contesta) no hay NINGUN put() de la
    // clave de la respuesta. Es lo que prueba que el write depende del `success` y no de haber
    // llegado a publicar.
    const threads2 = await freshThreads();
    await threads2.put(sha256hex(REFERENCIA_CON_MATCH), '500');
    const spy2 = spyOn(threads2);
    const { logger: logger2, capture: capture2 } = testLoggerWithCapture();

    const mudo = await responderFor('requirements.*.comment', MUTE);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(2, { inReplyTo: REFERENCIA_CON_MATCH })]])),
      // El timeout se baja SOLO en el config del test: esperar los 15 s del default por un timeout
      // deliberado seria la mitad del presupuesto del `testTimeout` gastado en no hacer nada.
      { ...BASE_CONFIG, timeoutMs: 1_500 },
      logger2,
      bus.client,
      spy2.kv,
    );

    expect(mudo.count()).toBe(1);
    expect(spy2.puts).toEqual([]);
    expect(await threads2.get(sha256hex('<reply-2@fixtures.local>'))).toBeNull();
    expect(tickLine(capture2)).toMatchObject({ fallidos: 1, comentados: 0 });
  }, 60_000);
});

/* ==========================================================================================
 * TAREA 3 (CA-12) — LOS CONTADORES DISTINGUEN ALTAS DE COMENTARIOS
 *
 * La linea `'tick completado'` con sus SEIS contadores es la UNICA señal operativa del tick: no
 * hay healthcheck, ni exportador de metricas, ni alertas (ADR-006, fuera de alcance v1). Sumar
 * `creados` y `comentados` borraria la distincion en el unico lugar donde se puede ver.
 * ========================================================================================== */
describe('runTick — los seis contadores distinguen altas de comentarios (CA-12)', () => {
  /** Los campos que pino agrega a TODA linea y que no son contadores de negocio. */
  const PINO_STRUCTURAL_FIELDS = new Set(['level', 'time', 'msg', 'env', 'service']);

  const counterKeys = (line: Record<string, unknown> | undefined): string[] =>
    Object.keys(line ?? {})
      .filter((key) => !PINO_STRUCTURAL_FIELDS.has(key))
      .sort();

  // TS-27
  it('TS-27: 2 altas + 1 comentario + 1 descarte dan creados:2 y comentados:1 — NO se suman', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');

    // SOLO DOS ids para el alta: si el tick publicara un alta de mas, el responder repetiria la
    // ultima y el exceso se veria en `count()`.
    const altas = await responderFor('requirements.new', [
      { status: 'success' as const, data: { id: 610 } },
      { status: 'success' as const, data: { id: 611 } },
    ]);
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 903 },
    });

    await runTick(
      sourceWith(
        new Map([
          [4, mailNuevo(4)],
          [3, mailNuevo(3)],
          [2, mailRespuesta(2, { inReplyTo: REFERENCIA_CON_MATCH })],
          [1, mailRespuesta(1, { inReplyTo: '<nadie@cliente.com>' })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    expect(tickLine(capture)).toMatchObject({
      ingestados: 4,
      parseados: 4,
      creados: 2,
      descartados: 1,
      fallidos: 0,
      comentados: 1,
    });
    // Ni `creados: 3` ni `comentados: 3`: son efectos distintos.
    expect(tickLine(capture)?.['creados']).not.toBe(3);
    expect(tickLine(capture)?.['comentados']).not.toBe(3);

    // Medido tambien EN EL BUS, no solo en los contadores: dos altas y un comentario, cada uno por
    // su subject.
    expect(altas.count()).toBe(2);
    expect(comentarios.count()).toBe(1);
    expect(comentarios.subjects()[0]).toContain('requirements.500.comment');
  });

  // TS-28
  it('TS-28: descartados absorbe hilo_desconocido junto con los otros tres motivos', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 999 },
    });

    await runTick(
      sourceWith(
        new Map([
          [4, mailRespuesta(4, { inReplyTo: '<nadie@cliente.com>' })], // hilo_desconocido
          [3, mailSinSlug(3)], //                                         sin_slug
          [2, mailSlugNoMapeado(2)], //                                   slug_no_mapeado
          [1, fixture('no-message-id.eml')], //                           sin_message_id
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    expect(tickLine(capture)).toMatchObject({
      ingestados: 4,
      descartados: 4,
      creados: 0,
      comentados: 0,
      fallidos: 0,
    });
    expect(altas.count()).toBe(0);

    // Una linea por mail, con los CUATRO motivos distintos. `sin_message_id` lo emite
    // `normalize()`, asi que se busca el motivo en todas las lineas, no solo en las de descarte.
    const motivos = capture
      .lines()
      .filter((line) => typeof line['motivo'] === 'string')
      .map((line) => String(line['motivo']));
    expect([...new Set(motivos)].sort()).toEqual([
      'hilo_desconocido',
      'sin_message_id',
      'sin_slug',
      'slug_no_mapeado',
    ]);

    // Y la de `slug_no_mapeado` incluye EL SLUG BUSCADO: es el dato que hace falta para cargarlo
    // (ADR-006). Sin el, el operador sabe que algo se descarto pero no que poner en el bucket.
    const noMapeado = capture.lines().find((line) => line['motivo'] === 'slug_no_mapeado');
    expect(noMapeado?.['slug']).toBe('beta');
  });

  // TS-29
  it('TS-29: la linea trae EXACTAMENTE las seis claves, ni una mas ni una menos', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 612 } });
    await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 904 },
    });

    await runTick(
      sourceWith(
        new Map([
          [2, mailNuevo(2)],
          [1, mailRespuesta(1, { inReplyTo: REFERENCIA_CON_MATCH })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      threads,
    );

    expect(counterKeys(tickLine(capture))).toEqual([
      'comentados',
      'creados',
      'descartados',
      'fallidos',
      'ingestados',
      'parseados',
    ]);
  });

  // TS-30
  it('TS-30: la linea se emite igual cuando el tick FALLA, con los seis en 0', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();

    const source: MailSource = {
      searchUnseen: (): Promise<number[]> => Promise.reject(new Error('IMAP se cayo')),
      fetch: (): Promise<RawMessage> => {
        throw new Error('no deberia llegar aca');
      },
      markSeen: (): Promise<void> => Promise.resolve(),
    };

    // Los contadores se declaran FUERA del `try`, y la linea sale en el `finally`: es lo que
    // permite que la unica señal operativa del tick exista incluso cuando el tick no hizo nada.
    await expect(runTick(source, BASE_CONFIG, logger, bus.client, threads)).rejects.toThrow();

    expect(tickLine(capture)).toMatchObject({
      ingestados: 0,
      parseados: 0,
      creados: 0,
      descartados: 0,
      fallidos: 0,
      comentados: 0,
    });
    // Y sin credenciales de IMAP en ninguna linea.
    expect(capture.raw().join('\n')).not.toContain('app-password-de-prueba');
  });
});

/* ==========================================================================================
 * TAREA 6 (CA-13) — LA IDEMPOTENCIA NO CAMBIA: EL `\Seen` ES LA UNICA MARCA
 *
 * El KV NO PARTICIPA de la idempotencia. Es la propiedad que se afirma explicitamente para que
 * nadie "mejore" el conector consultando el bucket antes de procesar: seria un round-trip por mail
 * NUEVO (que es la mayoria) para resolver un problema que el `\Seen` ya resuelve, y ademas
 * cambiaria el modo de falla — un bucket caido dejaria de procesar mails en vez de dejar de rutear
 * respuestas.
 * ========================================================================================== */
describe('runTick — el KV NO participa de la idempotencia (CA-13)', () => {
  // TS-51
  it('TS-51: un mail ya \\Seen NO se reprocesa, aunque su entrada del hilo nunca se haya escrito', async () => {
    const threads = await freshThreads();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 640 } });

    // TICK 1: el mail se procesa, queda \Seen, y el write FALLA — que es exactamente el estado que
    // deja "el proceso murio antes de escribir la entrada".
    const { logger: l1, capture: c1 } = testLoggerWithCapture();
    const source1 = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source1, BASE_CONFIG, l1, bus.client, withFailingPut(threads));

    expect(tickLine(c1)).toMatchObject({ ingestados: 1, creados: 1 });
    expect(source1.markSeenCalls).toEqual([1]);
    // La entrada NO esta: el hilo quedo sin ruteo.
    expect(await threads.get(sha256hex('<uid-1@fixtures.local>'))).toBeNull();

    // TICK 2: el mail esta \Seen, asi que `searchUnseen()` no lo devuelve.
    const { logger: l2, capture: c2 } = testLoggerWithCapture();
    await runTick(sourceWith(new Map()), BASE_CONFIG, l2, bus.client, threads);

    // LA ASERCION CENTRAL ES NEGATIVA: no se reprocesa. Y lo que lo evito fue el `\Seen`, NO el KV
    // —el bucket no tiene su entrada, asi que si el conector consultara el bucket para decidir,
    // este mail se habria reprocesado y habria creado un requisito DUPLICADO.
    expect(tickLine(c2)).toMatchObject({ ingestados: 0, parseados: 0, creados: 0 });
    expect(await countKeys(threads)).toBe(0);
  });

  // TS-52
  it('TS-52: un mail cuyo hash YA esta en el bucket se procesa igual, y un mail nuevo paga CERO get()', async () => {
    const threads = await freshThreads();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 641 } });

    // La entrada ya existe: si el conector usara el bucket para deduplicar, este mail se saltearia.
    await threads.put(sha256hex('<uid-1@fixtures.local>'), '999');
    const spy = spyOn(threads);

    const source = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source, BASE_CONFIG, logger, bus.client, spy.kv);

    expect(tickLine(capture)).toMatchObject({ ingestados: 1, creados: 1, descartados: 0 });
    expect(source.markSeenCalls).toEqual([1]);

    // CERO `get()`: un mail NUEVO no paga NINGUN round-trip de lectura. Es la mitad de la propiedad
    // que hace que el KV no sea un costo por mail sino por RESPUESTA.
    expect(spy.gets).toEqual([]);
    // Y el write PISA la entrada con el requisito nuevo: la ultima escritura vale, sin ninguna
    // rama de "ya existia".
    expect(spy.puts).toEqual([sha256hex('<uid-1@fixtures.local>')]);
    const entry = await threads.get(sha256hex('<uid-1@fixtures.local>'));
    expect(Number.parseInt(entry?.string() ?? '', 10)).toBe(641);
  });

  // TS-53 — la propiedad de CODIGO. El complemento del TS-37 de
  // `infra/kv/source-properties.test.ts` (que afirma las posiciones relativas de `markSeen`): aca
  // se afirma que `lookupThread(` aparece SOLO en la rama de la respuesta.
  it('TS-53: lookupThread aparece SOLO en la rama de la respuesta, nunca como guarda del alta', () => {
    const code = readSource('domain/ingesta/tick.ts');

    // Una sola invocacion en todo el archivo: si hubiera dos, una podria ser la guarda.
    const invocaciones = code.match(/lookupThread\s*\(/g) ?? [];
    expect(invocaciones).toHaveLength(1);

    const markSeenIdx = code.indexOf('mailSource.markSeen(uid)');
    const ramaIdx = code.indexOf("'intencion' in route");
    const lookupIdx = code.indexOf('lookupThread(');
    const publishRequirementIdx = code.indexOf('publishRequirementFromMail(');

    expect(markSeenIdx).toBeGreaterThan(-1);
    // DESPUES del markSeen: ninguna consulta al KV puede saltear un mail.
    expect(lookupIdx).toBeGreaterThan(markSeenIdx);
    // Y DENTRO de la rama de la respuesta, que empieza despues del alta.
    expect(ramaIdx).toBeGreaterThan(publishRequirementIdx);
    expect(lookupIdx).toBeGreaterThan(ramaIdx);
  });
});

/* ==========================================================================================
 * TAREA 6 (CA-14) — EL DEDUP CONTRA EL HILO NO EXISTE, Y ES DELIBERADO
 *
 * ===================== POR QUE ESTO NO ES UN BUG. NO LO "ARREGLES". =====================
 *
 * Gmail arrastra los adjuntos del original en la respuesta, asi que un mismo archivo se sube de
 * nuevo y se vincula al comentario. Deduplicarlo contra el hilo serian N+1 CONSULTAS POR RESPUESTA
 * (una por adjunto, mas la del hilo) y obligaria a tocar el PLANO DE CONSULTAS de Jiku, que
 * ADR-003 mantiene cerrado en este REQ: el conector escribe SOLO publicando comandos.
 *
 * El costo aceptado es el byte duplicado en el storage. Lo que NO se acepta es el costo de la
 * alternativa. Si alguien lee esto porque este test se puso rojo: el arreglo no es borrar el test.
 * ========================================================================================== */
describe('runTick — el dedup contra el hilo NO existe, y es DELIBERADO (CA-14)', () => {
  const PDF_BYTES = 'contenido-del-informe-pdf';

  // TS-54 y TS-55: el escenario, con el porque escrito en el nombre y en el bloque de arriba.
  it('TS-54/TS-55: el mismo adjunto del alta se sube DE NUEVO en la respuesta, sin consultar el hilo', async () => {
    const threads = await freshThreads();
    const http = await startHttpServer(() => 200);

    const uploads = await responderFor('files.request-upload', [
      { status: 'success' as const, data: { fileId: 7, uploadUrl: http.url } },
      { status: 'success' as const, data: { fileId: 8, uploadUrl: http.url } },
    ]);
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 650 },
    });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 905 },
    });

    const parts = [
      attachmentPart({
        filename: 'informe.pdf',
        mimeType: 'application/pdf',
        base64: Buffer.from(PDF_BYTES).toString('base64'),
      }),
    ];

    try {
      // TICK 1: el alta sube `informe.pdf` y vincula `fileId: 7`.
      const { logger: l1, capture: c1 } = testLoggerWithCapture();
      await runTick(
        sourceWith(
          new Map([[1, mailConAdjuntos({ messageId: '<orig-pdf@cliente.com>', parts })]]),
        ),
        BASE_CONFIG,
        l1,
        bus.client,
        threads,
      );

      expect(tickLine(c1)).toMatchObject({ creados: 1, fallidos: 0 });
      expect((altas.payloads()[0] as Record<string, unknown>)['fileIds']).toEqual([7]);
      expect(uploads.count()).toBe(1);
      expect(http.requestCount()).toBe(1);

      // TICK 2: la respuesta arrastra EL MISMO pdf (mismo checksum), que es lo que hace Gmail.
      const { logger: l2, capture: c2 } = testLoggerWithCapture();
      const spy = spyOn(threads);
      await runTick(
        sourceWith(
          new Map([
            [
              2,
              mailConAdjuntos({
                messageId: '<reply-pdf@cliente.com>',
                inReplyTo: '<orig-pdf@cliente.com>',
                parts,
              }),
            ],
          ]),
        ),
        BASE_CONFIG,
        l2,
        bus.client,
        spy.kv,
      );

      expect(tickLine(c2)).toMatchObject({ comentados: 1, creados: 0, fallidos: 0 });

      // Se pidio permiso IGUAL y se hizo el `PUT` IGUAL.
      expect(uploads.count()).toBe(2);
      expect(http.requestCount()).toBe(2);
      // Y el `fileId` NUEVO va en el `fileIds` del comentario.
      const comentario = comentarios.payloads()[0] as Record<string, unknown>;
      expect(comentario['fileIds']).toEqual([8]);

      // NO SE CONSULTA NADA AL HILO ANTES DE SUBIR: el unico `get()` del tick es el del LOOKUP del
      // hilo, no uno por adjunto. Si hubiera dedup contra el hilo, aca habria dos o mas.
      expect(spy.gets).toEqual([sha256hex('<orig-pdf@cliente.com>')]);
      // El write de la respuesta si esta: cierra el ciclo del hilo.
      expect(spy.puts).toEqual([sha256hex('<reply-pdf@cliente.com>')]);
    } finally {
      await http.close();
    }
  }, 60_000);

  // TS-56 — el dedup INTRA-mail sigue vigente. Es el que NO se toca: colapsa adjuntos identicos
  // del MISMO mail, sin ninguna consulta a ningun lado.
  it('TS-56: el dedup INTRA-mail sigue existiendo — 3 adjuntos, 2 iguales, dan 2 permisos y 2 PUT', async () => {
    const threads = await freshThreads();
    await threads.put(sha256hex(REFERENCIA_CON_MATCH), '500');
    const http = await startHttpServer(() => 200);

    const uploads = await responderFor('files.request-upload', [
      { status: 'success' as const, data: { fileId: 20, uploadUrl: http.url } },
      { status: 'success' as const, data: { fileId: 21, uploadUrl: http.url } },
    ]);
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 906 },
    });

    const repetido = Buffer.from('adjunto-repetido').toString('base64');
    const distinto = Buffer.from('adjunto-distinto').toString('base64');

    try {
      const { logger, capture } = testLoggerWithCapture();
      await runTick(
        sourceWith(
          new Map([
            [
              1,
              mailConAdjuntos({
                messageId: '<reply-dedup@cliente.com>',
                inReplyTo: REFERENCIA_CON_MATCH,
                parts: [
                  attachmentPart({ filename: 'a.pdf', mimeType: 'application/pdf', base64: repetido }),
                  attachmentPart({ filename: 'b.pdf', mimeType: 'application/pdf', base64: repetido }),
                  attachmentPart({ filename: 'c.pdf', mimeType: 'application/pdf', base64: distinto }),
                ],
              }),
            ],
          ]),
        ),
        BASE_CONFIG,
        logger,
        bus.client,
        threads,
      );

      expect(tickLine(capture)).toMatchObject({ comentados: 1, fallidos: 0 });

      // DOS permisos y DOS PUT, no tres: el dedup intra-mail colapso los dos identicos.
      expect(uploads.count()).toBe(2);
      expect(http.requestCount()).toBe(2);

      const comentario = comentarios.payloads()[0] as Record<string, unknown>;
      expect(comentario['fileIds']).toEqual([20, 21]);

      // Y el colapsado NO deja aviso ni placeholder en el texto: a diferencia de un RECHAZADO (que
      // si deja aviso, porque el cliente mando algo que no se acepto), un duplicado colapsado no es
      // informacion para nadie — el archivo esta, una vez.
      const comment = String(comentario['comment']);
      expect(comment).not.toMatch(/duplicad/i);
      expect(comment).not.toMatch(/repetid/i);
      expect(comment).not.toMatch(/No se pudo subir/);
      // Los dos placeholders de los archivos que si viajaron. El prefijo `!` es SOLO para
      // imagenes (`procesar-adjuntos-mail.ts`: `mimeType.startsWith('image/')`), y estos son PDF:
      // el placeholder correcto es `[attach:N]` sin el `!`, que es como Jiku renderiza un adjunto
      // no-imagen.
      expect(comment).toContain('[attach:20]');
      expect(comment).toContain('[attach:21]');
      expect(comment).not.toContain('![attach:20]');
    } finally {
      await http.close();
    }
  }, 60_000);
});
