import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { JikuBucketFull, JikuError } from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick, type Normalize } from '#domain/ingesta/tick.js';
import { normalize as realNormalize } from '#domain/ingesta/normalize.js';
import { threadKey } from '#infra/kv/keys.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { respondTo, type CoreResponder } from '../bus/responder.js';
import { spyOnSpace, withFailingGet, withFailingPut } from '../infra/kv/space-doubles.js';
import { fakeKvSpace } from './fake-kv-space.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-54 a TS-65 del Story Plan de S-032: el tick con el Mapa de Tickets en el Espacio KV.
 *
 * `routeMail()` devuelve la INTENCION de alta y el tick la resuelve con `lookupTicket()` ANTES de
 * los adjuntos, con tres salidas: el alta, `slug_no_mapeado` y `slug_no_consultable`.
 *
 * Bus compartido con responders de `core` (la convencion `testing` no mockea el bus), `MailSource`
 * doble, y el espacio FAKE en memoria (`fakeKvSpace`): este archivo afirma el cableado del tick, no
 * el KV. Lo que el KV hace de verdad lo afirman `test/infra/kv/tickets.test.ts` y
 * `tick-propiedades-kv.test.ts`, contra `JIKU_KV` real.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

const UNQUERYABLE_MESSAGE =
  'no se pudo consultar el Mapa de Tickets; el mail se descarta como slug_no_consultable';
const MALFORMED_MESSAGE = 'una entrada del Mapa de Tickets tiene un projectId invalido y se ignora';

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
    allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
    maxSizeBytes: 10_485_760,
    putTimeoutMs: 30_000,
  },
};

function mailNuevo(uid: number, to: string): Buffer {
  return Buffer.from(
    `Message-Id: <uid-${String(uid)}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      `To: ${to}\r\n` +
      'Subject: Consulta\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      `Cuerpo del mail ${String(uid)}.\r\n`,
  );
}

function mailRespuesta(messageId: string, to: string, inReplyTo: string): Buffer {
  return Buffer.from(
    `Message-Id: ${messageId}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      `To: ${to}\r\n` +
      'Subject: Re: Consulta\r\n' +
      `In-Reply-To: ${inReplyTo}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Respondo lo que preguntaste.\r\n',
  );
}

/** `with-attachments.eml` con el `To:` reescrito (el patron de `withResolvableRecipient`). */
function withAttachmentsTo(to: string): Buffer {
  return Buffer.from(
    readFileSync(`${FIXTURES_DIR}with-attachments.eml`, 'utf8').replace('To: soporte@grava.io', `To: ${to}`),
  );
}

function sourceWith(mails: [number, Buffer][]): MailSource & { seen: number[] } {
  const byUid = new Map(mails);
  const seen: number[] = [];
  return {
    seen,
    searchUnseen: (): Promise<number[]> => Promise.resolve(mails.map(([uid]) => uid)),
    fetch: (uid: number): Promise<RawMessage> => {
      const source = byUid.get(uid);
      if (source === undefined) throw new Error(`no hay fuente para uid ${String(uid)}`);
      return Promise.resolve({ uid, source });
    },
    markSeen: (uid: number): Promise<void> => {
      seen.push(uid);
      return Promise.resolve();
    },
  };
}

function tickLine(lines: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return lines.find((line) => line['msg'] === 'tick completado');
}

function discards(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line['msg'] === 'mail descartado');
}

let bus: TestBusContext;
const responders: CoreResponder[] = [];

async function core(command: string, replies: Parameters<typeof respondTo>[2]): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  responders.push(responder);
  return responder;
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterEach(async () => {
  await Promise.all(responders.splice(0).map((responder) => responder.stop()));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await bus.cleanup();
});

describe('el tick resuelve el slug con lookupTicket()', () => {
  // TS-54
  it('TS-54: un slug cargado crea el requisito en su proyecto y escribe el hilo', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });
    const altas = await core('requirements.new', { status: 'success', data: { id: 1234 } });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+alfa@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);
    expect(tickLine(capture.lines())).toMatchObject({
      ingestados: 1,
      parseados: 1,
      creados: 1,
      descartados: 0,
      fallidos: 0,
      comentados: 0,
    });
    expect(fake.gets).toEqual(['tickets.alfa']);
    expect(fake.puts).toEqual([
      { key: 'hilos.a9ff163cb318d096973695bd43d84bec0dd16669bfb4dfe93386697e565687d0', value: '1234' },
    ]);
    expect(fake.puts[0]?.key).toBe(`hilos.${sha256('<uid-1@fixtures.local>')}`);
  });

  // TS-55
  it('TS-55: el slug se consulta en minusculas (invariante 4)', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });
    const altas = await core('requirements.new', { status: 'success', data: { id: 1234 } });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+Alfa@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    expect(fake.gets).toEqual(['tickets.alfa']);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);
    expect(tickLine(capture.lines())).toMatchObject({ creados: 1 });
  });

  // TS-63
  it('TS-63: un Mapa de Tickets vacio es valido: el mail se descarta como slug_no_mapeado', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace();

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+alfa@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    expect(discards(capture.lines())).toEqual([
      expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'alfa' }),
    ]);
    expect(tickLine(capture.lines())).toMatchObject({ creados: 0, descartados: 1 });
  });
});

describe('lo que nunca va a resolver es slug_no_mapeado', () => {
  // TS-56
  it('TS-56: un slug no cargado se descarta como slug_no_mapeado, sin publicar ni escribir', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });
    const altas = await core('requirements.new', { status: 'success', data: { id: 1234 } });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+beta@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    const lines = discards(capture.lines());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      messageId: '<uid-1@fixtures.local>',
      motivo: 'slug_no_mapeado',
      slug: 'beta',
      msg: 'mail descartado',
    });
    expect(tickLine(capture.lines())).toMatchObject({ descartados: 1 });
    expect(altas.count()).toBe(0);
    expect(fake.puts).toEqual([]);
  });

  // TS-57
  it('TS-57: un valor mal formado descarta como slug_no_mapeado sin volcar el valor', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': 'cuarenta-y-dos' });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+alfa@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    const lines = capture.lines();
    expect(lines.find((line) => line['msg'] === MALFORMED_MESSAGE)).toMatchObject({ level: 'warn', slug: 'alfa' });
    expect(discards(lines)).toEqual([expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'alfa' })]);
    for (const raw of capture.raw()) expect(raw).not.toContain('cuarenta-y-dos');
    expect(tickLine(lines)).toMatchObject({ creados: 0 });
  });

  // TS-58
  it('TS-58: un slug que no puede ser clave descarta como slug_no_mapeado SIN round-trip', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+a+b@grava.io')]]), BASE_CONFIG, logger, bus.client, fake.space);

    expect(discards(capture.lines())).toEqual([
      expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'a+b' }),
    ]);
    expect(fake.gets).toEqual([]);
  });
});

describe('una consulta que falla descarta como slug_no_consultable', () => {
  // TS-59
  it('TS-59: el get() que rechaza descarta cada mail con su motivo propio, y el lote sigue', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const space = withFailingGet(
      fakeKvSpace({ 'tickets.alfa': '42' }).space,
      new JikuError('jiku: kv: get "tickets.alfa": JetStream did not answer within 15000ms.'),
    );
    const altas = await core('requirements.new', { status: 'success', data: { id: 1234 } });
    const source = sourceWith([
      [3, mailNuevo(3, 'tickets+alfa@grava.io')],
      [2, mailNuevo(2, 'tickets+alfa@grava.io')],
      [1, mailNuevo(1, 'soporte@grava.io')],
    ]);

    await runTick(source, BASE_CONFIG, logger, bus.client, space);

    const lines = capture.lines();
    const unqueryable = lines.filter((line) => line['msg'] === UNQUERYABLE_MESSAGE);
    expect(unqueryable).toHaveLength(2);
    for (const line of unqueryable) {
      expect(line).toMatchObject({ level: 'warn', slug: 'alfa', errorClass: 'JikuError' });
    }
    expect(discards(lines)).toEqual([
      expect.objectContaining({ messageId: '<uid-3@fixtures.local>', motivo: 'slug_no_consultable', slug: 'alfa' }),
      expect.objectContaining({ messageId: '<uid-2@fixtures.local>', motivo: 'slug_no_consultable', slug: 'alfa' }),
      expect.objectContaining({ messageId: '<uid-1@fixtures.local>', motivo: 'sin_slug' }),
    ]);

    const tick = tickLine(lines);
    expect(tick).toMatchObject({
      ingestados: 3,
      parseados: 3,
      creados: 0,
      descartados: 3,
      fallidos: 0,
      comentados: 0,
    });
    // SEIS contadores exactos: `slug_no_consultable` suma en `descartados`, no es un septimo. Se
    // quitan SOLO los campos que pino agrega a toda linea, asi que un septimo contador con cualquier
    // nombre haria fallar el caso.
    const PINO_STRUCTURAL_FIELDS = new Set(['level', 'time', 'msg', 'env', 'service']);
    expect(
      Object.keys(tick ?? {})
        .filter((key) => !PINO_STRUCTURAL_FIELDS.has(key))
        .sort(),
    ).toEqual(['comentados', 'creados', 'descartados', 'fallidos', 'ingestados', 'parseados']);

    // Cada mail quedo \Seen (ADR-001), no se creo nada y el cuerpo no viajo al log.
    expect(source.seen).toEqual([3, 2, 1]);
    expect(altas.count()).toBe(0);
    for (const raw of capture.raw()) expect(raw).not.toContain('Cuerpo del mail');
  });
});

describe('la consulta del slug va antes de los adjuntos', () => {
  // TS-60
  it.each([
    ['slug_no_mapeado', 'tickets+beta@grava.io', false],
    ['slug_no_consultable', 'tickets+alfa@grava.io', true],
  ] as const)('TS-60: un mail con adjuntos que termina en %s no sube ningun byte', async (motivo, to, failing) => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });
    const space = failing ? withFailingGet(fake.space) : fake.space;
    // Un responder que PODIA contestar: el `count() === 0` afirma que nadie pidio, no que nadie
    // podia responder.
    const uploads = await core('files.request-upload', {
      status: 'success',
      data: { fileId: 900, uploadUrl: 'http://127.0.0.1:9/no-se-usa' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await runTick(sourceWith([[1, withAttachmentsTo(to)]]), BASE_CONFIG, logger, bus.client, space);

    expect(uploads.count()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(discards(capture.lines())).toEqual([expect.objectContaining({ motivo })]);
  });
});

describe('una consulta por mail, sin cache ni reintento', () => {
  // TS-61
  it('TS-61: tres mails al mismo slug hacen tres get(), y con el KV caido tambien tres', async () => {
    const mails: [number, Buffer][] = [3, 2, 1].map((uid) => [uid, mailNuevo(uid, 'tickets+alfa@grava.io')]);

    // Primera corrida: tres consultas, tres altas.
    {
      const { logger, capture } = testLoggerWithCapture();
      const fake = fakeKvSpace({ 'tickets.alfa': '42' });
      await core('requirements.new', [
        { status: 'success', data: { id: 1 } },
        { status: 'success', data: { id: 2 } },
        { status: 'success', data: { id: 3 } },
      ]);

      await runTick(sourceWith(mails), BASE_CONFIG, logger, bus.client, fake.space);

      expect(fake.gets).toEqual(['tickets.alfa', 'tickets.alfa', 'tickets.alfa']);
      expect(tickLine(capture.lines())).toMatchObject({ creados: 3 });
      await Promise.all(responders.splice(0).map((responder) => responder.stop()));
    }

    // Segunda corrida, con el get() fallando: exactamente tres intentos, uno por mail (sin
    // reintento y sin recordar el fallo del mail anterior).
    {
      const { logger, capture } = testLoggerWithCapture();
      const spy = spyOnSpace(withFailingGet(fakeKvSpace({ 'tickets.alfa': '42' }).space));

      await runTick(sourceWith(mails), BASE_CONFIG, logger, bus.client, spy.space);

      expect(spy.gets).toEqual(['tickets.alfa', 'tickets.alfa', 'tickets.alfa']);
      expect(tickLine(capture.lines())).toMatchObject({ descartados: 3 });
    }
  });

  // TS-62
  it('TS-62: un mail sin slug, una respuesta y un mail no parseable NO consultan el slug', async () => {
    const { logger } = testLoggerWithCapture();
    const fake = fakeKvSpace({ 'tickets.alfa': '42' });
    // El uid 1 rompe en `normalize`: el doble inyectable lanza solo para el.
    const normalize: Normalize = async (raw, log) => {
      if (raw.toString('utf8').includes('<rompe@fixtures.local>')) throw new Error('parse roto');
      return realNormalize(raw, log);
    };
    const roto = Buffer.from('Message-Id: <rompe@fixtures.local>\r\nTo: tickets+alfa@grava.io\r\n\r\nx\r\n');

    await runTick(
      sourceWith([
        [3, mailNuevo(3, 'soporte@grava.io')],
        [2, mailRespuesta('<reply-2@fixtures.local>', 'tickets+alfa@grava.io', '<r1@x>')],
        [1, roto],
      ]),
      BASE_CONFIG,
      logger,
      bus.client,
      fake.space,
      normalize,
    );

    expect(fake.gets.filter((key) => key.startsWith('tickets.'))).toEqual([]);
    // La respuesta SI consulta, pero el Mapa de Hilos.
    expect(fake.gets).toContain('hilos.f5e704b3f744e5aa2d287e872a9d8a11d41bd938e1165e0bd6902ceeb013bb99');
  });
});

describe('el Mapa de Hilos sigue igual con el espacio', () => {
  // TS-64
  it('TS-64: un write del hilo que falla (bucket lleno) no cancela el alta', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const space = withFailingPut(
      fakeKvSpace({ 'tickets.alfa': '42' }).space,
      new JikuBucketFull('jiku: kv: put "hilos.a9ff…" was refused because the bucket reached its limit.'),
    );
    await core('requirements.new', { status: 'success', data: { id: 1234 } });

    await runTick(sourceWith([[1, mailNuevo(1, 'tickets+alfa@grava.io')]]), BASE_CONFIG, logger, bus.client, space);

    const lines = capture.lines();
    expect(tickLine(lines)).toMatchObject({ creados: 1 });
    expect(lines.find((line) => line['msg'] === 'no se pudo escribir la entrada del Mapa de Hilos; el requisito ya se creo y no se compensa')).toMatchObject({
      messageId: '<uid-1@fixtures.local>',
      messageIdHash: 'a9ff163cb318d096973695bd43d84bec0dd16669bfb4dfe93386697e565687d0',
      requirementId: 1234,
      errorClass: 'JikuBucketFull',
    });
  });

  // TS-65
  it('TS-65: una respuesta con match y sin +slug comenta SIN consultar el slug', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const fake = fakeKvSpace({ [threadKey('<r1@x>')]: '77' });
    const comentarios = await core('requirements.*.comment', { status: 'success', data: { id: 900 } });

    await runTick(
      sourceWith([[1, mailRespuesta('<reply-1@fixtures.local>', 'soporte@grava.io', '<r1@x>')]]),
      BASE_CONFIG,
      logger,
      bus.client,
      fake.space,
    );

    expect(tickLine(capture.lines())).toMatchObject({ comentados: 1 });
    expect(comentarios.subjects()[0]).toContain('requirements.77.comment');
    expect(fake.gets.filter((key) => key.startsWith('tickets.'))).toEqual([]);
    expect(fake.puts).toEqual([{ key: `hilos.${sha256('<reply-1@fixtures.local>')}`, value: '77' }]);
  });
});
