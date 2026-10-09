import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { threadKey } from '#infra/kv/keys.js';
import { openKvSpace, type KvSpace } from '#infra/kv/space.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { startJetStreamNats, type JetStreamNats } from '../infra/kv/helpers.js';
import {
  spyOnSpace,
  switchableSpace,
  withEntryCreated,
  withFailingGet,
  withFailingPut,
} from '../infra/kv/space-doubles.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';
import { readSource } from '../shared/source-scan.js';

/**
 * S-033 Tareas 5 y 6 (CA-4, CA-7, CA-8, CA-9, CA-10): propiedades del sistema sobre `runTick()`
 * CABLEADO de punta a punta contra el `JIKU_KV` real. TS-15 a TS-25 del Story Plan de S-033.
 *
 * # POR QUE UN ARCHIVO NUEVO Y NO EXTENDER `tick-propiedades-kv.test.ts`
 *
 * Ese archivo ya tiene mas de 1600 lineas, y la story pide NO modificar lo de S-028 que se conserva
 * (la redaccion de su Tarea 1, los contadores, la idempotencia y el dedup siguen verdes ahi, sin
 * tocar). Es el mismo criterio con el que S-028 creo su archivo en vez de extender
 * `tick-redaction.test.ts`.
 *
 * # QUE SE DOBLA, Y POR QUE
 *
 * Nada del bus de comandos (`core` lo dobla `respondTo()` sobre el compartido) y nada del KV
 * salvo donde JetStream NO PUEDE producir el estado que el escenario necesita:
 *
 * - **Una entrada de 91 dias** (CA-4): JetStream no deja fechar una entrada hacia atras.
 *   `withEntryCreated()` devuelve la entrada real con `created` cambiado, y REGISTRA que lo hizo:
 *   un doble que nadie consulto haria pasar el escenario sin probar nada sobre la antiguedad.
 * - **Una caida controlada** (CA-7): tirar el contenedor abajo se llevaria al resto del archivo.
 *   `switchableSpace()` hace rechazar `get()` y `put()` del MISMO objeto, y despues los devuelve:
 *   el tick que sigue usa el mismo handle, sin reabrir nada.
 * - **Un `get()` o un `put()` que falla** (CA-8): `withFailingGet()` / `withFailingPut()`.
 *
 * Todos son objetos planos que DELEGAN en el handle real (nunca `Proxy`: ver `space-doubles.ts`).
 */

/** El `sub` de los escenarios se arma por contador: un espacio FRESCO por escenario. */
let spaceCounter = 0;

/** Los centinelas de la redaccion, distintos por fuente: si uno aparece, se sabe cual se filtro. */
const SECRETO_MAIL = 'CONTENIDO-SECRETO-DEL-CLIENTE';
const SECRETO_RESPUESTA = 'RESPUESTA-SECRETA-DEL-CLIENTE';
const SECRETO_ADJUNTO = 'BYTES-SECRETOS-DEL-ADJUNTO';
const VALOR_CRUDO = 'VALOR-CRUDO-DEL-KV';

const DAY_MS = 86_400_000;

/** El `AppConfig` de los escenarios, el de `tick-propiedades-kv.test.ts` (con `.txt` permitido). */
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
 * Un mail RFC 822 inline. Sin `inReplyTo`/`references` es un mail nuevo; `to` por defecto es
 * `tickets+alfa@grava.io`.
 */
function mail(opts: {
  messageId: string;
  to?: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
}): Buffer {
  const isReply = opts.inReplyTo !== undefined || opts.references !== undefined;
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      `To: ${opts.to ?? 'tickets+alfa@grava.io'}\r\n` +
      `Subject: ${isReply ? 'Re: Consulta' : 'Consulta'}\r\n` +
      (opts.inReplyTo === undefined ? '' : `In-Reply-To: ${opts.inReplyTo}\r\n`) +
      (opts.references === undefined ? '' : `References: ${opts.references}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `${opts.body ?? 'Texto del mensaje.'}\r\n`,
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

/** Un mail nuevo con adjuntos, al slug mapeado `alfa`. */
function mailConAdjuntos(opts: { messageId: string; body: string; parts: string[] }): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Cliente" <cliente@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta con adjunto\r\n' +
      'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--ATT-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      `${opts.body}\r\n` +
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

/** Un servidor HTTP local para el `PUT` prefirmado, que contesta 200. */
async function startHttpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}/upload`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

const tickLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

const discardLines = (capture: LogCapture): Record<string, unknown>[] =>
  capture.lines().filter((line) => line['msg'] === 'mail descartado');

let bus: TestBusContext;
let nats: JetStreamNats;
const openResponders: CoreResponder[] = [];

/** Un espacio FRESCO y propio, sembrado con `seed` (clave derecha -> valor). */
async function freshSpace(seed: Record<string, string> = {}): Promise<KvSpace> {
  spaceCounter += 1;
  const space = await nats.spaceFor(`s033-t${String(spaceCounter)}`);
  for (const [key, value] of Object.entries(seed)) {
    await space.put(key, value);
  }
  return space;
}

async function responderFor(
  command: string,
  replies: Parameters<typeof respondTo>[2],
): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  openResponders.push(responder);
  return responder;
}

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
 * TAREA 5 (CA-4) — LOS HILOS NO EXPIRAN
 * ========================================================================================== */
describe('runTick — una respuesta a un hilo de cualquier antiguedad comenta (CA-4)', () => {
  /** El armado de TS-15/TS-16: el hilo sembrado y envejecido, y una respuesta SIN `+slug`. */
  async function respuestaAHiloDe(days: number, tag: string) {
    const space = await freshSpace({ [threadKey(`<orig-${tag}@cliente.com>`)]: '1234' });
    const created = new Date(Date.now() - days * DAY_MS);
    const aged = withEntryCreated(space, created);
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 1 } });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 9100 },
    });
    const { logger, capture } = loggerWithCapture();

    await runTick(
      sourceWith(
        new Map([
          [
            1,
            mail({
              messageId: `<reply-${tag}@cliente.com>`,
              to: 'soporte@grava.io',
              inReplyTo: `<orig-${tag}@cliente.com>`,
            }),
          ],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      aged.space,
    );

    return { space, created, aged, altas, comentarios, capture };
  }

  it('TS-15: una respuesta a un hilo cuya entrada tiene 91 dias comenta en su requisito', async () => {
    const { space, created, aged, altas, comentarios, capture } = await respuestaAHiloDe(91, '91');

    expect(comentarios.count()).toBe(1);
    expect(comentarios.subjects()[0]).toContain('requirements.1234.comment');
    expect((comentarios.payloads()[0] as Record<string, unknown>)['visibilityLevel']).toBe('public');
    expect(tickLine(capture)).toMatchObject({ comentados: 1, creados: 0, descartados: 0, fallidos: 0 });
    expect(await valueOf(space, threadKey('<reply-91@cliente.com>'))).toBe('1234');
    expect(altas.count()).toBe(0);

    // El doble SE USO: devolvio la entrada del hilo con la fecha de hace 91 dias.
    expect(aged.reads).toContainEqual({ key: threadKey('<orig-91@cliente.com>'), created });
    expect(Date.now() - created.getTime()).toBeGreaterThanOrEqual(91 * DAY_MS);
  });

  it.each([10, 91, 3650])('TS-16: un hilo de %i dias comenta igual', async (days) => {
    const { aged, created, comentarios, capture } = await respuestaAHiloDe(days, `edad-${String(days)}`);

    expect(tickLine(capture)).toMatchObject({ comentados: 1 });
    expect(comentarios.subjects()[0]).toContain('requirements.1234.comment');
    expect(aged.reads).toContainEqual({ key: threadKey(`<orig-edad-${String(days)}@cliente.com>`), created });
  });
});

/* ==========================================================================================
 * TAREA 5 (CA-7) — LA CAIDA DEL KV EN CALIENTE, Y LA RECUPERACION SIN REINICIAR
 * ========================================================================================== */
describe('runTick — una caida del KV descarta con rastro y se recupera sola (CA-7)', () => {
  // TS-17, TS-18 y TS-19 en una sola cadena: TS-18 es el tick SIGUIENTE a la caida de TS-17, sobre
  // EL MISMO objeto, y TS-19 mira la linea de contadores de TS-17. Entre los dos ticks no hay
  // ninguna llamada a `openKvSpace()` ni a `spaceFor()`, ni otro `client`: si el tick de TS-18 crea
  // su requisito es porque no habia ningun estado que reconstruir.
  it('TS-17/TS-18/TS-19: la caida descarta todo con su motivo y el tick siguiente crea sin reiniciar', async () => {
    const space = await freshSpace({
      'tickets.alfa': '42',
      [threadKey('<conocido@cliente.com>')]: '600',
    });
    const sw = switchableSpace(space);
    // El espia va AFUERA del interruptor: registra lo que el codigo INTENTO, aunque el KV rechace.
    const spy = spyOnSpace(sw.space);
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 4242 } });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 1 },
    });

    // ---------- TS-17: el KV cae ----------
    sw.down();
    const { logger: l1, capture: c1 } = loggerWithCapture();
    // UID descendente: el doble devuelve las claves del `Map` en orden de insercion.
    const source = sourceWith(
      new Map([
        [5, mail({ messageId: '<n1@cliente.com>', to: 'tickets+alfa@grava.io' })],
        [4, mail({ messageId: '<n2@cliente.com>', to: 'tickets+beta@grava.io' })],
        [3, mail({ messageId: '<r1@cliente.com>', inReplyTo: '<conocido@cliente.com>' })],
        [2, mail({ messageId: '<r2@cliente.com>', inReplyTo: '<otro@cliente.com>' })],
        [1, mail({ messageId: '<s1@cliente.com>', to: 'soporte@grava.io' })],
      ]),
    );

    await runTick(source, BASE_CONFIG, l1, bus.client, spy.space);

    const discards = discardLines(c1);
    expect(discards).toEqual([
      expect.objectContaining({ messageId: '<n1@cliente.com>', motivo: 'slug_no_consultable', slug: 'alfa' }),
      expect.objectContaining({ messageId: '<n2@cliente.com>', motivo: 'slug_no_consultable', slug: 'beta' }),
      expect.objectContaining({ messageId: '<r1@cliente.com>', motivo: 'es_respuesta' }),
      expect.objectContaining({ messageId: '<r2@cliente.com>', motivo: 'es_respuesta' }),
      expect.objectContaining({ messageId: '<s1@cliente.com>', motivo: 'sin_slug' }),
    ]);
    const ticketWarns = c1
      .lines()
      .filter((line) => String(line['msg']).startsWith('no se pudo consultar el Mapa de Tickets'));
    expect(ticketWarns).toEqual([
      expect.objectContaining({ slug: 'alfa', errorClass: 'JikuError' }),
      expect.objectContaining({ slug: 'beta', errorClass: 'JikuError' }),
    ]);
    const threadWarns = c1
      .lines()
      .filter((line) => String(line['msg']).startsWith('no se pudo consultar el Mapa de Hilos'));
    // El `messageId` de estos `warn` es la REFERENCIA consultada (la clave que no se pudo leer),
    // con su hash: es lo que el operador cruza con el bucket.
    expect(threadWarns).toEqual([
      expect.objectContaining({ messageId: '<conocido@cliente.com>', messageIdHash: sha256('<conocido@cliente.com>') }),
      expect.objectContaining({ messageId: '<otro@cliente.com>', messageIdHash: sha256('<otro@cliente.com>') }),
    ]);
    expect(altas.count()).toBe(0);
    expect(comentarios.count()).toBe(0);
    expect(spy.puts).toEqual([]);
    // Todo quedo `\Seen`: nada se reintenta, el KV no es una marca de idempotencia (ADR-001).
    expect([...source.markSeenCalls].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const line = tickLine(c1);
    expect(line).toMatchObject({
      ingestados: 5,
      parseados: 5,
      creados: 0,
      comentados: 0,
      descartados: 5,
      fallidos: 0,
    });

    // ---------- TS-19: sin un septimo contador ----------
    const counters = Object.keys(line ?? {})
      .filter((key) => !['level', 'time', 'msg', 'env', 'service'].includes(key))
      .sort();
    expect(counters).toEqual(['comentados', 'creados', 'descartados', 'fallidos', 'ingestados', 'parseados']);
    expect(line).not.toHaveProperty('slug_no_consultable');
    expect(line).not.toHaveProperty('noConsultables');

    // ---------- TS-18: el KV vuelve; el MISMO objeto, el mismo client ----------
    sw.up();
    const { logger: l2, capture: c2 } = loggerWithCapture();

    await runTick(
      sourceWith(new Map([[6, mail({ messageId: '<n3@cliente.com>', to: 'tickets+alfa@grava.io' })]])),
      BASE_CONFIG,
      l2,
      bus.client,
      spy.space,
    );

    expect(altas.count()).toBe(1);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);
    expect(tickLine(c2)).toMatchObject({ creados: 1, descartados: 0 });
    expect(await valueOf(space, threadKey('<n3@cliente.com>'))).toBe('4242');
  });
});

/* ==========================================================================================
 * TAREA 5 (CA-9) — EL COSTO NO CRECE CON LOS SLUGS CARGADOS
 * ========================================================================================== */
describe('runTick — el tick lee solo las claves de sus mails (CA-9)', () => {
  it('TS-23: con 1 slug o con 301 slugs cargados, el tick hace exactamente los mismos gets', async () => {
    const chico = await freshSpace({ 'tickets.alfa': '42' });
    const grande = await freshSpace({ 'tickets.alfa': '42' });
    // En serie: es infraestructura, y no hace falta paralelizarla.
    for (let i = 0; i < 300; i += 1) {
      await grande.put(`tickets.s${String(i)}`, String(1000 + i));
    }
    await responderFor('requirements.new', { status: 'success' as const, data: { id: 77 } });

    const gets: string[][] = [];
    for (const space of [chico, grande]) {
      const spy = spyOnSpace(space);
      const { logger } = loggerWithCapture();
      await runTick(
        sourceWith(
          new Map([
            [4, mail({ messageId: '<costo-1@cliente.com>' })],
            [3, mail({ messageId: '<costo-2@cliente.com>' })],
            [2, mail({ messageId: '<costo-3@cliente.com>', to: 'tickets+beta@grava.io' })],
            [1, mail({ messageId: '<costo-4@cliente.com>', inReplyTo: '<nadie@cliente.com>' })],
          ]),
        ),
        BASE_CONFIG,
        logger,
        bus.client,
        spy.space,
      );
      gets.push(spy.gets);
    }

    const expected = ['tickets.alfa', 'tickets.alfa', 'tickets.beta', threadKey('<nadie@cliente.com>')];
    expect(gets[0]).toEqual(expected);
    expect(gets[1]).toEqual(expected);
    expect(gets[1]?.some((key) => key.startsWith('tickets.s'))).toBe(false);
  }, 60_000);

  // TS-24. NO duplica lo que ya esta afirmado: `infra/kv/source-properties.test.ts` TS-79 cubre
  // `new Map(`/`new Set(` en `tick.ts` y `tickets.ts`, y el `let` de modulo de `tickets.ts`; TS-75
  // cubre el `let` de modulo de `space.ts`. Lo que nadie afirmaba es: ninguna `Map`/`Set` en
  // `space.ts`, ningun `let` de modulo en `tick.ts`, y que el resultado de `lookupTicket()` se guarda
  // en una constante DEL CUERPO DEL `for` (por mail), no en algo declarado fuera de el.
  it('TS-24: ningun modulo del camino del slug guarda estado entre mails', () => {
    const space = readSource('infra/kv/space.ts');
    expect(/new\s+Map[^(]*\(/.test(space), 'space.ts declara un Map').toBe(false);
    expect(/new\s+Set[^(]*\(/.test(space), 'space.ts declara un Set').toBe(false);

    const tick = readSource('domain/ingesta/tick.ts');
    expect(/^let\s/m.test(tick), 'tick.ts declara un let de modulo').toBe(false);

    // El resultado de la consulta es una `const` declarada en la misma sentencia, DESPUES del
    // `for` por UID: vive lo que vive una iteracion.
    const assignment = /(const|let|var)\s+(\w+)\s*=\s*await\s+lookupTicket\s*\(/.exec(tick);
    expect(assignment, 'lookupTicket() se asigna a una variable declarada en la misma sentencia').not.toBeNull();
    expect(assignment?.[1]).toBe('const');
    const forIdx = tick.indexOf('for (const uid of');
    expect(forIdx).toBeGreaterThan(-1);
    expect(assignment?.index ?? -1).toBeGreaterThan(forIdx);
    // Y esa constante no se copia a ningun lado que sobreviva al mail.
    const name = assignment?.[2] ?? '';
    expect(new RegExp(`\\.(push|set|add)\\(\\s*${name}\\b`).test(tick), `${name} se acumula`).toBe(false);
    expect(new RegExp(`\\w+\\s*=\\s*${name}\\s*;`).test(tick), `${name} se reasigna a otra variable`).toBe(false);
  });
});

/* ==========================================================================================
 * TAREA 5 (CA-10, CA-4) — LOS DOS ORIGENES DE `hilo_desconocido`, Y EL HILO VIEJO QUE COMENTA
 * ========================================================================================== */
describe('runTick — hilo_desconocido tiene dos origenes y la expiracion ya no es uno (CA-10)', () => {
  it('TS-25: el reenvio interno y el hilo anterior al despliegue descartan; el hilo de 91 dias comenta', async () => {
    const space = await freshSpace({
      'tickets.alfa': '42',
      [threadKey('<viejo-91@cliente.com>')]: '1234',
    });
    const created = new Date(Date.now() - 91 * DAY_MS);
    const aged = withEntryCreated(space, created);
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 1 } });
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 9200 },
    });
    const { logger, capture } = loggerWithCapture();

    await runTick(
      sourceWith(
        new Map([
          // El reenvio interno: con `+alfa` MAPEADO. El slug no lo salva (invariante 26 al reves).
          [3, mail({ messageId: '<fwd-9@grava.io>', to: 'tickets+alfa@grava.io', references: '<interno-9@grava.io>' })],
          // La respuesta a un hilo anterior al despliegue: su entrada nunca se escribio.
          [2, mail({ messageId: '<resp-anterior@cliente.com>', inReplyTo: '<anterior-al-deploy@cliente.com>' })],
          // La respuesta a un hilo de 91 dias: comenta.
          [1, mail({ messageId: '<resp-viejo@cliente.com>', inReplyTo: '<viejo-91@cliente.com>' })],
        ]),
      ),
      BASE_CONFIG,
      logger,
      bus.client,
      aged.space,
    );

    const discards = discardLines(capture);
    expect(discards).toHaveLength(2);
    for (const discard of discards) {
      expect(discard['motivo']).toBe('hilo_desconocido');
      expect(discard).not.toHaveProperty('slug');
    }
    expect(discards.map((d) => d['messageId'])).toEqual(['<fwd-9@grava.io>', '<resp-anterior@cliente.com>']);
    expect(comentarios.count()).toBe(1);
    expect(comentarios.subjects()[0]).toContain('requirements.1234.comment');
    expect(altas.count()).toBe(0);
    expect(tickLine(capture)).toMatchObject({ descartados: 2, comentados: 1, creados: 0, fallidos: 0 });
    expect(aged.reads).toContainEqual({ key: threadKey('<viejo-91@cliente.com>'), created });
  });
});

/* ==========================================================================================
 * TAREA 6 (CA-8) — LA REDACCION SOBRE EL LOG COMPLETO DEL PROCESO: ARRANQUE + TICKS
 *
 * S-028 ya afirma la redaccion sobre el tick (`tick-propiedades-kv.test.ts`, Tarea 1). Lo que no
 * podia cubrir porque no existia: la linea de arranque `'espacio KV abierto'` y los descartes
 * `slug_no_mapeado` y `slug_no_consultable` EN EL MISMO LOG que las altas y las respuestas, con un
 * valor CRUDO del KV sembrado a proposito.
 *
 * Por eso el arranque se ejercita con `openKvSpace()` REAL sobre la MISMA captura que los ticks, y
 * las aserciones de ausencia van sobre `capture.raw()` —la linea SERIALIZADA—, nunca solo sobre
 * campos conocidos del objeto parseado: un secreto que se colo por un campo que nadie penso no se
 * ve mirando los campos que si se pensaron.
 * ========================================================================================== */
describe('runTick — la redaccion se conserva sobre el log completo, con el espacio real (CA-8)', () => {
  const USER_ID = 's033-redaccion';
  /** Cada `Message-Id` de los mails del escenario. */
  const MESSAGE_IDS = {
    alta: '<alta-secreta@cliente.com>',
    respuesta: '<resp-secreta@cliente.com>',
    noMapeado: '<beta-redaccion@cliente.com>',
    valorMalo: '<omega-redaccion@cliente.com>',
    altaSinKv: '<alta-sin-kv@cliente.com>',
    altaSinWrite: '<alta-sin-write@cliente.com>',
  } as const;

  let capture: LogCapture;
  let commentSent: string;

  beforeAll(async () => {
    const { logger, capture: c } = loggerWithCapture();
    capture = c;

    // El ARRANQUE, con la misma captura que los ticks.
    const space = await openKvSpace({
      client: Client.fromConnection(nats.connection, { instance: 'test', userId: USER_ID }),
      logger,
    });
    await space.put('tickets.alfa', '42');
    await space.put('tickets.omega', VALOR_CRUDO);
    await space.put(threadKey('<abc@cliente.com>'), '500');

    const http = await startHttpServer();
    const uploads = await respondTo(bus.connection, 'files.request-upload', {
      status: 'success' as const,
      data: { id: 7, uploadUrl: http.url },
    });
    const altas = await respondTo(bus.connection, 'requirements.new', [
      { status: 'success' as const, data: { id: 900 } },
      { status: 'success' as const, data: { id: 902 } },
    ]);
    const comentarios = await respondTo(bus.connection, 'requirements.*.comment', {
      status: 'success' as const,
      data: { id: 901 },
    });

    try {
      // ---------- TICK A: alta con adjunto, respuesta, slug no mapeado, valor malo ----------
      await runTick(
        sourceWith(
          new Map([
            [
              4,
              mailConAdjuntos({
                messageId: MESSAGE_IDS.alta,
                body: SECRETO_MAIL,
                parts: [
                  attachmentPart({
                    filename: 'informe.txt',
                    mimeType: 'text/plain',
                    base64: Buffer.from(SECRETO_ADJUNTO).toString('base64'),
                  }),
                ],
              }),
            ],
            [3, mail({ messageId: MESSAGE_IDS.respuesta, inReplyTo: '<abc@cliente.com>', body: SECRETO_RESPUESTA })],
            [2, mail({ messageId: MESSAGE_IDS.noMapeado, to: 'tickets+beta@grava.io' })],
            [1, mail({ messageId: MESSAGE_IDS.valorMalo, to: 'tickets+omega@grava.io' })],
          ]),
        ),
        BASE_CONFIG,
        logger,
        bus.client,
        space,
      );

      // ---------- TICK B: el KV no contesta -> slug_no_consultable ----------
      await runTick(
        sourceWith(new Map([[5, mail({ messageId: MESSAGE_IDS.altaSinKv, body: SECRETO_MAIL })]])),
        BASE_CONFIG,
        logger,
        bus.client,
        withFailingGet(space),
      );

      // ---------- TICK C: el write del hilo falla despues del alta (TS-21) ----------
      await runTick(
        sourceWith(new Map([[6, mail({ messageId: MESSAGE_IDS.altaSinWrite })]])),
        BASE_CONFIG,
        logger,
        bus.client,
        withFailingPut(space),
      );

      // Sanidad del escenario: cada rama corrio de verdad.
      expect(uploads.count()).toBe(1);
      expect(altas.count()).toBe(2);
      expect(comentarios.count()).toBe(1);
      commentSent = String((comentarios.payloads()[0] as Record<string, unknown>)['comment']);
    } finally {
      await uploads.stop();
      await altas.stop();
      await comentarios.stop();
      await http.close();
    }
  }, 90_000);

  it('TS-20: ninguna linea filtra el cuerpo, el comentario, el adjunto ni el valor crudo del KV', () => {
    const raw = capture.raw();
    expect(raw.length).toBeGreaterThan(10);
    // Las ramas que el escenario promete, en el log.
    const motivos = capture.lines().map((line) => line['motivo']);
    expect(motivos).toContain('slug_no_mapeado');
    expect(motivos).toContain('slug_no_consultable');
    expect(capture.lines().some((line) => line['msg'] === 'espacio KV abierto')).toBe(true);

    for (const [fuente, centinela] of [
      ['el cuerpo del mail', SECRETO_MAIL],
      ['el cuerpo de la respuesta', SECRETO_RESPUESTA],
      ['los bytes del adjunto', SECRETO_ADJUNTO],
      ['el valor crudo del KV', VALOR_CRUDO],
    ] as const) {
      for (const line of raw) {
        expect(line, `se filtro ${fuente}`).not.toContain(centinela);
      }
    }
    // El texto del comentario que VIAJO tampoco aparece.
    expect(commentSent.length).toBeGreaterThan(0);
    for (const line of raw) {
      expect(line, 'se filtro el texto del comentario').not.toContain(commentSent.trim());
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  // TS-21. El campo del hash es `messageIdHash` y el del espacio `kvPrefix`, NUNCA `key`: `key` esta
  // en los `REDACT_PATHS` del logger y saldria `[REDACTED]` en silencio — el operador perderia el
  // dato con el que cruza una linea de log con el bucket, sin que ningun test lo notara.
  it('TS-21: Message-Id en claro, messageIdHash solo en los warn del Mapa de Hilos, y kvPrefix solo en el arranque', () => {
    const lines = capture.lines();
    const raw = capture.raw();

    for (const messageId of Object.values(MESSAGE_IDS)) {
      expect(raw.some((line) => line.includes(messageId)), `${messageId} aparece en claro`).toBe(true);
    }

    const threadWarns = new Set([
      'no se pudo escribir la entrada del Mapa de Hilos; el requisito ya se creo y no se compensa',
      'no se pudo consultar el Mapa de Hilos; no se puede saber a que hilo apunta esta respuesta',
      'una entrada del Mapa de Hilos tiene un requirementId invalido y se saltea',
    ]);
    const withHash = lines.filter((line) => 'messageIdHash' in line);
    expect(withHash.length, 'el warn del write fallido del tick C lleva messageIdHash').toBeGreaterThan(0);
    for (const line of withHash) {
      expect(threadWarns.has(String(line['msg'])), `messageIdHash en "${String(line['msg'])}"`).toBe(true);
      expect(line['messageIdHash']).toBe(sha256(String(line['messageId'])));
    }

    const withPrefix = lines.filter((line) => 'kvPrefix' in line);
    expect(withPrefix).toEqual([
      expect.objectContaining({ msg: 'espacio KV abierto', kvPrefix: `test.${USER_ID}.` }),
    ]);

    for (const line of lines) {
      for (const field of ['key', 'value', 'entry']) {
        expect(line, `una linea tiene el campo ${field}`).not.toHaveProperty(field);
      }
    }
  });
});
