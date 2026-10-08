import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { threadKey } from '#infra/kv/keys.js';
import type { KvSpace } from '#infra/kv/space.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, MUTE, respondTo } from '../bus/responder.js';
import { startJetStreamNats, type JetStreamNats } from '../infra/kv/helpers.js';
import {
  spyOnSpace,
  withFailingGet,
  withFailingPut,
  type SpaceSpy,
} from '../infra/kv/space-doubles.js';
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
 * `tick-redaction.test.ts` corre con `fakeKvSpace()` (el doble EN MEMORIA) y sin la rama del
 * comentario: extenderlo obligaria a cambiarle la infraestructura a una suite que ya esta bien.
 * `tick-hilos.test.ts` ya tiene 834 lineas. Es el mismo criterio con el que S-022 creo
 * `tick-adjuntos-propiedades.test.ts`.
 *
 * # QUE SE EXTIENDE Y QUE NO SE DUPLICA
 *
 * Esta suite NO reescribe lo que ya esta afirmado. La linea de base es:
 *
 * - `tick-hilos.test.ts` (S-026/S-027): el write tras el alta, el reenvio interno, el bucket
 *   inaccesible, los seis contadores, el hash logueable. **Lo que falta y se agrega aca:**
 *   el TERCER caso de `hilo_desconocido` (bucket vacio = hilo anterior al despliegue), la
 *   INDISTINGUIBILIDAD de los tres como propiedad afirmada, y el ORDEN del write respecto del
 *   `success`.
 * - `tick-memory.test.ts` (S-016/S-022): la propiedad de memoria por inspeccion de `tick.ts`. **NO
 *   SE MODIFICA** — es la linea de base de CA-3, y aca solo se EXTIENDE a la rama del comentario y a
 *   `threads.ts`.
 * - `tick-redaction.test.ts` (S-016/S-022): la redaccion con el doble en memoria. Aca la propiedad
 *   se afirma con el KV REAL y con el texto del comentario que EFECTIVAMENTE VIAJO AL BUS.
 * - `infra/kv/source-properties.test.ts` (S-024/S-026): el `create()` ausente, el `watch()` ausente
 *   sobre hilos, la copia en memoria ausente, la posicion de `markSeen`. No se duplica.
 *
 * # LOS DOBLES
 *
 * Sistemas REALES: el bus (contenedor compartido, con responders de `core`) y el KV (contenedor
 * PROPIO con `-js` y `JIKU_KV`, porque el compartido arranca sin JetStream — ver la cabecera de
 * `test/infra/kv/helpers.ts`; NO se le agrega `-js` al compartido y NO se unifican los tags).
 *
 * Desde S-032 el KV es el Espacio KV del conector: cada escenario usa un espacio FRESCO de una
 * identidad propia (el prefijo `{instance}.{userId}.` los aisla dentro del unico bucket), sembrado
 * con `tickets.alfa` → `42`, el mismo mapa que hasta S-032 viajaba en `config.ruteo.ticketMap`. El
 * `KV` del SDK no lista claves, asi que "el bucket quedo exactamente como estaba" se afirma con un
 * `get()` dirigido a cada clave en juego y con lo que el espia registro que se ESCRIBIO.
 *
 * Doblados solo en el BORDE: `MailSource` (IMAP) y el `PUT` prefirmado (servidor HTTP local). Y, en
 * los escenarios que lo exigen, un espacio cuyo `put()`/`get()` RECHAZA envolviendo el handle REAL
 * (`space-doubles.ts`): un KV inaccesible en caliente no se puede provocar contra un contenedor sano
 * sin tirarlo abajo.
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

/** La referencia que se siembra en el Mapa de Hilos para que una respuesta tenga match. */
const REFERENCIA_CON_MATCH = '<abc@cliente.com>';

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** El valor de una entrada del espacio como texto, o `undefined` si no esta. */
async function valueOf(space: KvSpace, key: string): Promise<string | undefined> {
  const entry = await space.get(key);
  return entry === undefined ? undefined : new TextDecoder().decode(entry.value);
}

/**
 * El `AppConfig` de los escenarios. Deliberadamente NO se reusa el `BASE_CONFIG` privado de
 * `test-logger.ts` (no se exporta) pero se le copia el bloque exacto que el Story Plan fija:
 * `subaddressPrefix = 'tickets'` y `maxPerTick = 50`. El mapa `{ alfa: 42 }` vive desde S-032 en el
 * Espacio KV de cada escenario (`freshSpace()`), no en la configuracion.
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
    allowedExtensions: ['.png', '.jpg', '.pdf', '.txt'],
    allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'],
    maxSizeBytes: 10_485_760,
    putTimeoutMs: 30_000,
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
 * `spyOnSpace()` con un RELOJ: ademas de las claves, registra el INSTANTE de cada `put()`.
 *
 * El instante (un contador monotonico propio, no el reloj) es lo que hace afirmable el ORDEN del
 * write respecto del `success` del comentario (TS-26) sin ningun sleep. Compone el espia de
 * `space-doubles.ts` sobre un objeto plano que delega (no un `Proxy`: ver su cabecera).
 */
function spyOnSpaceWithClock(space: KvSpace): SpaceSpy & { putTicks: number[]; tick: () => number } {
  const putTicks: number[] = [];
  let counter = 0;
  const tick = (): number => {
    counter += 1;
    return counter;
  };

  const spy = spyOnSpace({
    get: (key, options) => space.get(key, options),
    put: (key, value, options) => {
      putTicks.push(tick());
      return space.put(key, value, options);
    },
  });

  return { ...spy, putTicks, tick };
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
let spaceCounter = 0;
const openResponders: CoreResponder[] = [];

/**
 * Un espacio FRESCO y propio por escenario (S-032: hasta entonces, un bucket de hilos propio), con
 * `tickets.alfa` → `42` ya cargado.
 *
 * Sin aislamiento, las entradas de un escenario las veria el siguiente — y "el Mapa de Hilos no
 * tiene la entrada de esta respuesta" seria inafirmable. Es el patron de `tick-hilos.test.ts`.
 */
async function freshSpace(): Promise<KvSpace> {
  spaceCounter += 1;
  const space = await nats.spaceFor(`s028-t${String(spaceCounter)}`);
  await space.put('tickets.alfa', '42');
  return space;
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
});

afterAll(async () => {
  await nats?.stop();
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
    space: KvSpace;
  }> {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();

    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');

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
      space,
    );

    return { capture, comentarios, altas, space };
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
    const space = await freshSpace();
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
      await runTick(sourceWith(new Map([[1, mail]])), BASE_CONFIG, logger, bus.client, space);

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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 620 } });

    // El `put()` que rechaza es el camino que emite el `warn` con el `messageIdHash`.
    await runTick(
      sourceWith(new Map([[1, mailNuevo(1, SECRETO_MAIL)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(space),
    );

    // El hash SOLO, sin el prefijo `hilos.` de la clave: es lo que el `warn` nombra.
    const hash = sha256('<uid-1@fixtures.local>');
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
 * bloque la EXTIENDE a las piezas que REQ-005 agrego y que su escaneo no cubre: la rama del
 * comentario y el lookup del Mapa de Hilos. (Hasta S-032 tambien afirmaba el tamaño de la copia del
 * mapa de slugs; desde REQ-008 esa copia no existe —el slug se consulta una vez por mail— y que la
 * consulta no se guarde lo afirma `test/infra/kv/source-properties.test.ts`.)
 *
 * # POR QUE POR INSPECCION Y NO MIDIENDO EL HEAP (TS-14)
 *
 * Medir `heapUsed` sin `--expose-gc` no es fiable: el GC decide cuando corre, y el delta de dos
 * lotes de tamaños distintos varia entre corridas por razones que no tienen nada que ver con el
 * codigo bajo test. Un test intermitente en una suite cuyo valor entero es la CONFIANZA es peor que
 * no tenerlo: el primero que lo vea rojo sin causa lo va a marcar `skip`, y ahi se pierde tambien
 * la cobertura que si servia.
 *
 * Asi que TS-14 se resuelve por INSPECCION (TS-10 a TS-12), que es exactamente lo que S-016 y S-022
 * ya hacen para la misma propiedad.
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
    // S-032: `'intencion' in route` aparece DOS veces —la rama del alta tambien es una intencion
    // desde REQ-008—, asi que el ancla es el `else if` que abre la rama del comentario.
    const ramaIdx = TICK.indexOf("else if ('intencion' in route)");
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

    // Y no hay `watch(` en ninguna forma: es `get()` puntual sobre el espacio que llega por
    // parametro. Desde S-032 el Mapa de Tickets tambien lo es: ninguno de los dos mapas tiene copia.
    expect(THREADS).not.toMatch(/watch\s*\(/);
    expect(THREADS).toMatch(/space\s*\.\s*get\s*\(/);
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

});

/* ==========================================================================================
 * TAREA 3 (CA-4) — `hilo_desconocido` NO CREA NADA, EN LOS CASOS QUE LO PRODUCEN
 *
 * Son INDISTINGUIBLES A PROPOSITO: un reenvio de hilo interno y un hilo anterior al despliegue
 * significan lo mismo operativamente —"esta respuesta apunta a un hilo que no conozco"— y el arreglo
 * es el mismo.
 *
 * Hasta S-032 habia un TERCER caso, la entrada expirada por el TTL de 90 dias. Desde REQ-008 los
 * hilos no expiran (invariante 32), y sus escenarios se borraron con el TTL.
 *
 * `tick-hilos.test.ts` ya cubre el reenvio por separado (TS-25 de S-026). Lo que se agrega aca: el
 * hilo anterior al despliegue (espacio sin la entrada = despliegue nuevo), la afirmacion de que
 * ninguno CREA ni ESCRIBE nada, y la INDISTINGUIBILIDAD como propiedad afirmada comparando las lineas
 * entre si.
 * ========================================================================================== */
describe('runTick — los casos de hilo_desconocido no crean nada (CA-4)', () => {
  /** El resultado observable de un tick de un solo mail contra un espacio fresco. */
  async function correrUnMail(mail: Buffer): Promise<{
    line: Record<string, unknown> | undefined;
    tick: Record<string, unknown> | undefined;
    altas: CoreResponder;
    comentarios: CoreResponder;
    puts: string[];
    space: KvSpace;
  }> {
    const space = await freshSpace();

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

    const spy = spyOnSpace(space);

    await runTick(sourceWith(new Map([[1, mail]])), BASE_CONFIG, logger, bus.client, spy.space);

    return {
      line: discardLines(capture)[0],
      tick: tickLine(capture),
      altas,
      comentarios,
      puts: spy.puts.map((put) => put.key),
      space,
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

  // TS-18 — CASO 3: un hilo anterior al despliegue. Es el caso que faltaba.
  it('TS-18: caso 3 — un hilo anterior al despliegue (espacio SIN la entrada, el estado de todo despliegue nuevo)', async () => {
    const result = await correrUnMail(mailRespuesta(1, { inReplyTo: '<viejo@cliente.com>' }));

    // El espacio fresco sin la entrada ES el estado de un despliegue nuevo: no hace falta simular
    // nada mas.
    expect(await result.space.get(threadKey('<viejo@cliente.com>'))).toBeUndefined();
    expect(result.line).toMatchObject({ motivo: 'hilo_desconocido' });
    expect(result.tick).toMatchObject({ descartados: 1, creados: 0, comentados: 0, fallidos: 0 });
    expect(result.altas.count()).toBe(0);
    expect(result.comentarios.count()).toBe(0);
  });

  // TS-19 — LA INDISTINGUIBILIDAD, afirmada comparando las tres lineas ENTRE SI.
  it('TS-19: los casos son INDISTINGUIBLES — mismo msg, mismo motivo, ningun campo diferenciador', async () => {
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
    const anterior = await correrUnMail(mailRespuesta(3, { inReplyTo: '<viejo@cliente.com>' }));

    const lineas = [fwd.line, anterior.line];
    for (const line of lineas) expect(line).toBeDefined();

    // El mismo `msg` y el mismo `motivo` en los dos.
    expect(lineas.map((l) => l?.['msg'])).toEqual(['mail descartado', 'mail descartado']);
    expect(lineas.map((l) => l?.['motivo'])).toEqual(['hilo_desconocido', 'hilo_desconocido']);

    // Y NINGUN campo diferenciador: la FORMA de la linea es identica, salvo el `messageId` (que es
    // del mail, no del caso) y el `time` de pino. Se compara el juego de claves entre si, no cada
    // uno contra una constante: es lo que detecta que alguien agregue un campo "para ayudar al
    // diagnostico" y rompa la propiedad sin querer.
    //
    // ES DELIBERADO. Los dos significan lo mismo operativamente y el arreglo es el mismo; un
    // campo que los distinga invitaria a tratarlos distinto, y no hay nada distinto que hacer.
    const shape = (line: Record<string, unknown> | undefined): string[] =>
      Object.keys(line ?? {})
        .filter((key) => key !== 'time' && key !== 'messageId')
        .sort();
    expect(shape(anterior.line)).toEqual(shape(fwd.line));
  });

  // TS-20 — ninguno deja NADA escrito.
  it('TS-20: los casos no dejan nada escrito — put() no se invoca ni una vez', async () => {
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
    const anterior = await correrUnMail(mailRespuesta(5, { inReplyTo: '<viejo@cliente.com>' }));

    for (const result of [fwd, anterior]) {
      // El `put()` no se llamo: la asercion sobre el KV espia que envuelve el handle REAL, no sobre
      // un doble. El `KV` del SDK no lista claves (S-032), asi que "el espacio queda EXACTAMENTE
      // como estaba" se afirma sobre lo que el codigo PIDIO escribir.
      expect(result.puts).toEqual([]);
    }

    // Y ninguna de las claves en juego aparecio: ni la del propio mail ni las de sus referencias.
    for (const messageId of ['<fwd-3@grava.io>', '<interno-4@grava.io>']) {
      expect(await fwd.space.get(threadKey(messageId))).toBeUndefined();
    }
    // El caso del despliegue nuevo termina sin la entrada, como empezo.
    for (const messageId of ['<reply-5@fixtures.local>', '<viejo@cliente.com>']) {
      expect(await anterior.space.get(threadKey(messageId))).toBeUndefined();
    }
  });
});

/* ==========================================================================================
 * TAREA 3 (CA-10) — EL WRITE QUE FALLA NO CANCELA EL ALTA
 * ========================================================================================== */
describe('runTick — el write que falla NO cancela el alta (CA-10)', () => {
  // TS-21
  it('TS-21: creados NO se revierte, y el warn nombra messageId, messageIdHash, requirementId y errorClass', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 600 } });

    await runTick(
      sourceWith(new Map([[1, mailNuevo(1)]])),
      BASE_CONFIG,
      logger,
      bus.client,
      withFailingPut(space),
    );

    // El requisito YA EXISTE en Jiku y no hay comando de compensacion (invariante 9): revertir el
    // contador mentiria sobre lo que paso.
    expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0, descartados: 0 });

    const warn = capture
      .lines()
      .find((line) => line['level'] === 'warn' && line['requirementId'] === 600);
    expect(warn).toBeDefined();
    expect(warn?.['messageId']).toBe('<uid-1@fixtures.local>');
    expect(warn?.['messageIdHash']).toBe(sha256('<uid-1@fixtures.local>'));
    // S-032: la CLASE del error del SDK (el timeout de `withFailingPut()` es un `JikuError`).
    expect(warn?.['errorClass']).toBe('JikuError');
    expect(String(warn?.['msg'])).toContain('no se pudo escribir la entrada del Mapa de Hilos');
  });

  // TS-22
  it('TS-22: el tick sigue con el resto del lote — tres altas, tres warns, tres publicaciones', async () => {
    const space = await freshSpace();
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

    await runTick(source, BASE_CONFIG, logger, bus.client, withFailingPut(space));

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
    // Y el Mapa de Hilos quedo sin ninguna de las tres entradas: los tres writes fallaron.
    for (const uid of [3, 2, 1]) {
      expect(await space.get(threadKey(`<uid-${String(uid)}@fixtures.local>`))).toBeUndefined();
    }
  });

  // TS-23
  it('TS-23: con el bucket inaccesible una RESPUESTA es es_respuesta, NO hilo_desconocido', async () => {
    const space = await freshSpace();
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
      withFailingGet(space),
    );

    // LA DISTINCION IMPORTA, y es la razon de que `ThreadLookupResult` tenga TRES estados y no
    // `number | undefined`: `hilo_desconocido` se arregla CARGANDO EL HILO (o aceptando que es
    // anterior al despliegue: desde REQ-008 los hilos no expiran); `es_respuesta` se arregla
    // ARREGLANDO EL BUCKET. Colapsarlos mandaria al operador al lugar equivocado.
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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');
    const spy = spyOnSpace(space);

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
      spy.space,
    );

    // NO existe la entrada de la respuesta.
    expect(await space.get(threadKey('<reply-1@fixtures.local>'))).toBeUndefined();
    // Y el Mapa de Hilos sigue teniendo SOLO la sembrada: intacta, y ningun write en todo el tick.
    expect(await valueOf(space, threadKey(REFERENCIA_CON_MATCH))).toBe('500');
    expect(spy.puts).toEqual([]);

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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');
    const spy = spyOnSpace(space);

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

    await runTick(source, BASE_CONFIG, logger, bus.client, spy.space);

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

    // El Mapa de Hilos tiene la sembrada, la del alta y la de LA RESPUESTA QUE SI COMENTO. La de la
    // que fallo no esta: son tres, no cuatro. El `KV` del SDK no lista claves (S-032): se leen por
    // su clave, y se afirma que se escribieron EXACTAMENTE las dos nuevas.
    expect(await valueOf(space, threadKey(REFERENCIA_CON_MATCH))).toBe('500');
    expect(await valueOf(space, threadKey('<uid-2@fixtures.local>'))).toBe('604');
    expect(await valueOf(space, threadKey('<reply-1@fixtures.local>'))).toBe('500');
    expect(await space.get(threadKey('<reply-3@fixtures.local>'))).toBeUndefined();
    expect(spy.puts.map((put) => put.key).sort()).toEqual(
      [`hilos.${sha256('<uid-2@fixtures.local>')}`, `hilos.${sha256('<reply-1@fixtures.local>')}`].sort(),
    );
  });

  // TS-26 — EL ORDEN, sin sleeps: un contador monotonico en el espia y en el handler.
  it('TS-26: el put() ocurre DESPUES de que el responder contesto; con el responder mudo no hay put()', async () => {
    const space = await freshSpace();
    const { logger } = testLoggerWithCapture();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');
    const spy = spyOnSpaceWithClock(space);

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
        spy.space,
      );

      // El `put()` de la RESPUESTA ocurrio, y DESPUES de que el responder recibio y contesto.
      expect(spy.puts).toEqual([{ key: `hilos.${sha256('<reply-1@fixtures.local>')}`, value: '500' }]);
      expect(recepcionTick).toBeDefined();
      expect(spy.putTicks[0]).toBeGreaterThan(Number(recepcionTick));
    } finally {
      await subscription.drain();
    }

    // Y la contracara: con el responder MUDO (recibe y no contesta) no hay NINGUN put() de la
    // clave de la respuesta. Es lo que prueba que el write depende del `success` y no de haber
    // llegado a publicar.
    const space2 = await freshSpace();
    await space2.put(threadKey(REFERENCIA_CON_MATCH), '500');
    const spy2 = spyOnSpace(space2);
    const { logger: logger2, capture: capture2 } = testLoggerWithCapture();

    const mudo = await responderFor('requirements.*.comment', MUTE);

    await runTick(
      sourceWith(new Map([[1, mailRespuesta(2, { inReplyTo: REFERENCIA_CON_MATCH })]])),
      // El timeout se baja SOLO en el config del test: esperar los 15 s del default por un timeout
      // deliberado seria la mitad del presupuesto del `testTimeout` gastado en no hacer nada.
      { ...BASE_CONFIG, timeoutMs: 1_500 },
      logger2,
      bus.client,
      spy2.space,
    );

    expect(mudo.count()).toBe(1);
    expect(spy2.puts).toEqual([]);
    expect(await space2.get(threadKey('<reply-2@fixtures.local>'))).toBeUndefined();
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
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');

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
      space,
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
    const space = await freshSpace();
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
      space,
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
    // (ADR-006). Sin el, el operador sabe que algo se descarto pero no que cargar en el espacio.
    const noMapeado = capture.lines().find((line) => line['motivo'] === 'slug_no_mapeado');
    expect(noMapeado?.['slug']).toBe('beta');
  });

  // TS-29
  it('TS-29: la linea trae EXACTAMENTE las seis claves, ni una mas ni una menos', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');
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
      space,
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
    const space = await freshSpace();
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
    await expect(runTick(source, BASE_CONFIG, logger, bus.client, space)).rejects.toThrow();

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
    const space = await freshSpace();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 640 } });

    // TICK 1: el mail se procesa, queda \Seen, y el write FALLA — que es exactamente el estado que
    // deja "el proceso murio antes de escribir la entrada".
    const { logger: l1, capture: c1 } = testLoggerWithCapture();
    const source1 = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source1, BASE_CONFIG, l1, bus.client, withFailingPut(space));

    expect(tickLine(c1)).toMatchObject({ ingestados: 1, creados: 1 });
    expect(source1.markSeenCalls).toEqual([1]);
    // La entrada NO esta: el hilo quedo sin ruteo.
    expect(await space.get(threadKey('<uid-1@fixtures.local>'))).toBeUndefined();

    // TICK 2: el mail esta \Seen, asi que `searchUnseen()` no lo devuelve.
    const { logger: l2, capture: c2 } = testLoggerWithCapture();
    const spy2 = spyOnSpace(space);
    await runTick(sourceWith(new Map()), BASE_CONFIG, l2, bus.client, spy2.space);

    // LA ASERCION CENTRAL ES NEGATIVA: no se reprocesa. Y lo que lo evito fue el `\Seen`, NO el KV
    // —el espacio no tiene su entrada, asi que si el conector consultara el KV para decidir, este
    // mail se habria reprocesado y habria creado un requisito DUPLICADO.
    expect(tickLine(c2)).toMatchObject({ ingestados: 0, parseados: 0, creados: 0 });
    // El tick 2 no toco el KV en absoluto, y la entrada sigue sin estar.
    expect(spy2.gets).toEqual([]);
    expect(spy2.puts).toEqual([]);
    expect(await space.get(threadKey('<uid-1@fixtures.local>'))).toBeUndefined();
  });

  // TS-52
  it('TS-52: un mail cuyo hash YA esta en el espacio se procesa igual, y un mail nuevo paga CERO get() al Mapa de Hilos', async () => {
    const space = await freshSpace();
    const { logger, capture } = testLoggerWithCapture();
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 641 } });

    // La entrada ya existe: si el conector usara el KV para deduplicar, este mail se saltearia.
    await space.put(threadKey('<uid-1@fixtures.local>'), '999');
    const spy = spyOnSpace(space);

    const source = sourceWith(new Map([[1, mailNuevo(1)]]));
    await runTick(source, BASE_CONFIG, logger, bus.client, spy.space);

    expect(tickLine(capture)).toMatchObject({ ingestados: 1, creados: 1, descartados: 0 });
    expect(source.markSeenCalls).toEqual([1]);

    // CERO `get()` al Mapa de Hilos: un mail NUEVO no paga ningun round-trip de lectura del hilo. Es
    // la mitad de la propiedad que hace que el Mapa de Hilos no sea un costo por mail sino por
    // RESPUESTA. Su UNICA lectura es la consulta de su slug, una sola (S-032).
    expect(spy.gets.filter((key) => key.startsWith('hilos.'))).toEqual([]);
    expect(spy.gets).toEqual(['tickets.alfa']);
    // Y el write PISA la entrada con el requisito nuevo: la ultima escritura vale, sin ninguna
    // rama de "ya existia".
    expect(spy.puts).toEqual([{ key: `hilos.${sha256('<uid-1@fixtures.local>')}`, value: '641' }]);
    expect(await valueOf(space, threadKey('<uid-1@fixtures.local>'))).toBe('641');
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
    // S-032: desde REQ-008 el alta TAMBIEN es una intencion (`route.intencion === 'alta'`), asi que
    // las anclas son las dos ramas: la del alta abre con su discriminante, la de la respuesta con el
    // `else if` que la sigue.
    const altaIdx = code.indexOf("route.intencion === 'alta'");
    const ramaIdx = code.indexOf("else if ('intencion' in route)");
    const lookupIdx = code.indexOf('lookupThread(');
    const publishRequirementIdx = code.indexOf('publishRequirementFromMail(');

    expect(markSeenIdx).toBeGreaterThan(-1);
    expect(altaIdx).toBeGreaterThan(-1);
    // DESPUES del markSeen: ninguna consulta al KV puede saltear un mail.
    expect(lookupIdx).toBeGreaterThan(markSeenIdx);
    // Y DENTRO de la rama de la respuesta, que empieza despues de la del alta (y de su publicacion).
    expect(publishRequirementIdx).toBeGreaterThan(altaIdx);
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
    const space = await freshSpace();
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
        space,
      );

      expect(tickLine(c1)).toMatchObject({ creados: 1, fallidos: 0 });
      expect((altas.payloads()[0] as Record<string, unknown>)['fileIds']).toEqual([7]);
      expect(uploads.count()).toBe(1);
      expect(http.requestCount()).toBe(1);

      // TICK 2: la respuesta arrastra EL MISMO pdf (mismo checksum), que es lo que hace Gmail.
      const { logger: l2, capture: c2 } = testLoggerWithCapture();
      const spy = spyOnSpace(space);
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
        spy.space,
      );

      expect(tickLine(c2)).toMatchObject({ comentados: 1, creados: 0, fallidos: 0 });

      // Se pidio permiso IGUAL y se hizo el `PUT` IGUAL.
      expect(uploads.count()).toBe(2);
      expect(http.requestCount()).toBe(2);
      // Y el `fileId` NUEVO va en el `fileIds` del comentario.
      const comentario = comentarios.payloads()[0] as Record<string, unknown>;
      expect(comentario['fileIds']).toEqual([8]);

      // NO SE CONSULTA NADA AL HILO ANTES DE SUBIR: el unico `get()` del tick es el del LOOKUP del
      // hilo, no uno por adjunto. Si hubiera dedup contra el hilo, aca habria dos o mas. (Y la
      // respuesta tampoco consulta su slug: se comenta sin evaluarlo, invariante 26.)
      expect(spy.gets).toEqual([`hilos.${sha256('<orig-pdf@cliente.com>')}`]);
      // El write de la respuesta si esta: cierra el ciclo del hilo.
      expect(spy.puts).toEqual([{ key: `hilos.${sha256('<reply-pdf@cliente.com>')}`, value: '650' }]);
    } finally {
      await http.close();
    }
  }, 60_000);

  // TS-56 — el dedup INTRA-mail sigue vigente. Es el que NO se toca: colapsa adjuntos identicos
  // del MISMO mail, sin ninguna consulta a ningun lado.
  it('TS-56: el dedup INTRA-mail sigue existiendo — 3 adjuntos, 2 iguales, dan 2 permisos y 2 PUT', async () => {
    const space = await freshSpace();
    await space.put(threadKey(REFERENCIA_CON_MATCH), '500');
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
        space,
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
