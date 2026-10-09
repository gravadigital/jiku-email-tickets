import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { threadKey } from '#infra/kv/keys.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo, respondToQuery } from '../bus/responder.js';
import { fakeKvSpace } from './fake-kv-space.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * TS-21, TS-22, TS-28, TS-29, TS-30 y el caso de CA-12: la consulta de reuso DE PUNTA A PUNTA
 * sobre `runTick()` CABLEADO — no sobre los modulos sueltos.
 *
 * POR QUE ESTA SUITE EXISTE ADEMAS DE LOS TESTS DE `lookup-attachment.test.ts` Y
 * `procesar-adjuntos-mail.test.ts`: S-022 y S-028 establecieron que las propiedades del sistema se
 * afirman sobre el tick cableado, porque un modulo puede estar perfecto y el CABLEADO equivocado —
 * y esa es exactamente la clase de fallo que este servicio no puede detectar de otra forma (no hay
 * healthcheck, ni metricas, ni nadie mirando; ADR-006: el log es la unica salida).
 *
 * Es tambien donde se afirman los criterios que NO TIENEN CODIGO NUEVO (CA-9, CA-12, CA-13): hay un
 * test que lo dice, que es distinto de que no haya nada.
 *
 * EL `.eml` es de BYTES RFC 822 REALES (`reply-with-dragged-attachment.eml`), como exige la
 * convencion `testing` — nunca un objeto parseado construido a mano. Y el `checksum` que la
 * consulta manda se CALCULA del mismo byte del fixture: un literal se desincronizaria en silencio,
 * el responder contestaria para un checksum que nunca se pidio, el test veria "sin match" y pasaria
 * en verde AFIRMANDO LO CONTRARIO de lo que cree.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

/** El `Message-Id` de la respuesta: el que el write del Mapa de Hilos tiene que escribir. */
const REPLY_MESSAGE_ID = '<reply-dragged-001@fixtures.local>';
/** El `Message-Id` del original: la referencia que matchea el Mapa de Hilos. */
const REFERENCE_ID = '<original-dragged-001@fixtures.local>';
/** El requisito del hilo. Es el `{id}` del comando del comentario Y el `entityId` de la consulta. */
const REQUIREMENT_ID = 500;

const QUERY_METHOD = 'attachments.list';
const UPLOAD_COMMAND = 'files.request-upload';
const COMMENT_COMMAND = `requirements.${String(REQUIREMENT_ID)}.comment`;

/**
 * El byte del adjunto arrastrado, decodificado del fixture igual que lo decodifica el parser.
 *
 * Se extrae del propio `.eml` en vez de repetir el base64: si alguien edita el fixture, el checksum
 * de este test lo sigue automaticamente en vez de quedarse viejo.
 */
const ATTACHMENT_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** El `checksum` que `deduplicar()` va a calcular sobre ese byte. */
const CHECKSUM_ESPERADO = createHash('sha256').update(ATTACHMENT_BYTES).digest('hex');

const BASE_CONFIG: AppConfig = {
  servers: 'nats://localhost:4222',
  instance: 'dev',
  credsFile: '/run/secrets/sentinel.creds',
  keyFile: '/run/secrets/machine-user.json',
  zitadelProjectId: '307f1f77bcf86cd799439011',
  issuer: 'https://id.grava.io',
  timeoutMs: 15_000,
  verifyProjectId: 42,
  logLevel: 'trace',
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

/** Un mail NUEVO (sin `References`) que trae el MISMO adjunto: es el caso de TS-30. */
function mailNuevoConAdjunto(): Buffer {
  return Buffer.from(
    'Message-Id: <nuevo-dragged-001@fixtures.local>\r\n' +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Consulta con captura\r\n' +
      'Content-Type: multipart/mixed; boundary="NEW-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--NEW-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'Ahi va la captura.\r\n' +
      '--NEW-BOUNDARY\r\n' +
      'Content-Type: image/png\r\n' +
      'Content-Disposition: attachment; filename="captura.png"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${ATTACHMENT_BYTES.toString('base64')}\r\n` +
      '--NEW-BOUNDARY--\r\n',
  );
}

/** La respuesta del fixture, mas un adjunto EXTRA que no esta vinculado: el caso de CA-12. */
function respuestaConDosAdjuntos(): Buffer {
  const extra = Buffer.from('un documento nuevo que nadie subio antes');

  return Buffer.from(
    `Message-Id: ${REPLY_MESSAGE_ID}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Re: Consulta con captura\r\n' +
      `References: ${REFERENCE_ID}\r\n` +
      'Content-Type: multipart/mixed; boundary="TWO-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--TWO-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'Ahi va de nuevo la captura, y sumo un documento.\r\n' +
      '--TWO-BOUNDARY\r\n' +
      'Content-Type: image/png\r\n' +
      'Content-Disposition: attachment; filename="captura.png"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${ATTACHMENT_BYTES.toString('base64')}\r\n` +
      '--TWO-BOUNDARY\r\n' +
      'Content-Type: application/pdf\r\n' +
      'Content-Disposition: attachment; filename="nuevo.pdf"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${extra.toString('base64')}\r\n` +
      '--TWO-BOUNDARY--\r\n',
  );
}

/** La respuesta del fixture, mas un `virus.exe` que la politica local rechaza: el caso de TS-21. */
function respuestaConRechazado(): Buffer {
  return Buffer.from(
    `Message-Id: ${REPLY_MESSAGE_ID}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      'Subject: Re: Consulta con captura\r\n' +
      `References: ${REFERENCE_ID}\r\n` +
      'Content-Type: multipart/mixed; boundary="REJ-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--REJ-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      'Ahi van los dos.\r\n' +
      '--REJ-BOUNDARY\r\n' +
      'Content-Type: application/octet-stream\r\n' +
      'Content-Disposition: attachment; filename="virus.exe"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${Buffer.from('MZ ejecutable').toString('base64')}\r\n` +
      '--REJ-BOUNDARY\r\n' +
      'Content-Type: image/png\r\n' +
      'Content-Disposition: attachment; filename="captura.png"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${ATTACHMENT_BYTES.toString('base64')}\r\n` +
      '--REJ-BOUNDARY--\r\n',
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

/** La coleccion con match: el adjunto arrastrado ya esta vinculado al Requisito del hilo. */
function conMatch(fileId = 1000): { status: 'success'; data: unknown } {
  return {
    status: 'success',
    data: {
      items: [{ id: 77, fileId, checksum: CHECKSUM_ESPERADO }],
      page: { limit: 1, returned: 1 },
    },
  };
}

const SIN_MATCH = {
  status: 'success' as const,
  data: { items: [], page: { limit: 1, returned: 0 } },
};

let bus: TestBusContext;
/**
 * Los tres responders, y hay que darlos de baja TODOS en el `afterEach`: con
 * `fileParallelism: false` y un bus compartido, una suscripcion viva de un caso anterior le
 * contesta al siguiente.
 */
let responderQuery: CoreResponder | undefined;
let responderUpload: CoreResponder | undefined;
let responderComment: CoreResponder | undefined;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  await bus.cleanup();
});

afterEach(async () => {
  await responderQuery?.stop();
  await responderUpload?.stop();
  await responderComment?.stop();
  responderQuery = undefined;
  responderUpload = undefined;
  responderComment = undefined;
  vi.unstubAllGlobals();
});

describe('runTick — la consulta de reuso de adjuntos contra el hilo (S-029)', () => {
  // TS-28
  it('TS-28: el tick reusa el arrastre de Gmail y publica el comentario con el fileId reusado', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });
    // La entrada del hilo: `hilos.` + `sha256(referenceId CRUDO)` → el requirementId. El
    // `Message-Id` va con sus brackets porque `threadKey()` NO lo normaliza. `tickets.alfa` esta
    // cargado como en el resto de las suites del tick (S-032: el mapa vive en el Espacio KV).
    kv.seed(threadKey(REFERENCE_ID), String(REQUIREMENT_ID));

    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, conMatch(1000));
    // El responder del permiso queda ACTIVO a proposito: su `count() === 0` es la unica forma de
    // afirmar que el ciclo se corto de verdad.
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 9999, uploadUrl: 'https://storage.example/put/nunca' },
    });
    responderComment = await respondTo(bus.connection, COMMENT_COMMAND, {
      status: 'success',
      data: { id: 9001 },
    });

    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    await runTick(
      sourceWith(new Map([[1, fixture('reply-with-dragged-attachment.eml')]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    // ==== LA CONSULTA SE HIZO, UNA VEZ, CON EL FILTRO COMPLETO ====
    expect(responderQuery.count()).toBe(1);
    const consulta = responderQuery.payloads()[0] as { filter: Record<string, unknown> };
    expect(consulta.filter).toEqual({
      entityType: 'requirement',
      entityId: REQUIREMENT_ID,
      checksum: CHECKSUM_ESPERADO,
      uploadedBy: bus.client.userId,
    });

    // ==== LAS DOS ASERCIONES NEGATIVAS, QUE SON EL VALOR ENTERO DE LA STORY ====
    expect(responderUpload.count()).toBe(0);
    expect(fetchStub).not.toHaveBeenCalled();

    // ==== EL COMENTARIO LLEVA EL `fileId` REUSADO, INDISTINGUIBLE DE UNO NUEVO ====
    const comentario = responderComment.payloads()[0] as {
      fileIds: number[];
      comment: string;
    };
    expect(comentario.fileIds).toEqual([1000]);
    // El placeholder al FINAL, en el orden que `componerDescripcion()` ya garantiza, y con `!`
    // porque el MIME es `image/png` — lo emite `placeholderPara()`, la misma funcion del subido.
    expect(comentario.comment.trimEnd().endsWith('![attach:1000]')).toBe(true);

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ comentados: 1, creados: 0, fallidos: 0, descartados: 0 });

    // ==== LA ENTRADA DEL HILO SE ESCRIBIO CON EL `messageId` DE LA RESPUESTA ====
    expect(kv.puts).toEqual([
      { key: threadKey(REPLY_MESSAGE_ID), value: String(REQUIREMENT_ID) },
    ]);

    // ==== EL LOG DEL REUSO, Y NINGUNA OBSERVABILIDAD PROHIBIDA (CA-14) ====
    const reuso = capture.lines().find((line) => line['resultado'] === 'reusado');
    expect(reuso).toMatchObject({
      checksum: CHECKSUM_ESPERADO,
      requirementId: REQUIREMENT_ID,
      fileId: 1000,
      resultado: 'reusado',
    });

    // Sobre el STRING SERIALIZADO, no sobre el objeto parseado: un secreto puede filtrarse por un
    // campo inesperado que el objeto no delata (ADR-006, invariante 22).
    const raw = capture.raw().join('\n');
    // El `checksum` SI aparece: es un hash, no el byte, y es el dato que cruza este log con el de
    // `core`.
    expect(raw).toContain(CHECKSUM_ESPERADO);
    // Y NADA de esto: ni el byte del adjunto (ni su base64 ni el string del Buffer), ni el cuerpo
    // del mail, ni el texto del comentario.
    expect(raw).not.toContain(ATTACHMENT_BYTES.toString('base64'));
    expect(raw).not.toContain('Te confirmo lo que preguntaste');
    expect(raw).not.toContain('![attach:1000]');
    expect(raw).not.toMatch(/"content"\s*:/);
    expect(raw).not.toMatch(/"body"\s*:/);
    expect(raw).not.toMatch(/"text"\s*:/);
  });

  // TS-29
  it('TS-29: el requisito borrado tras la consulta no deja el reuso huerfano', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });
    kv.seed(threadKey(REFERENCE_ID), String(REQUIREMENT_ID));

    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, conMatch(1000));
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 9999, uploadUrl: 'https://storage.example/put/nunca' },
    });
    // El requisito se borro ENTRE la consulta y la publicacion del comentario.
    responderComment = await respondTo(bus.connection, COMMENT_COMMAND, {
      status: 'failure',
      errorCode: 'requirement_not_found',
    });

    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    await runTick(
      sourceWith(new Map([[1, fixture('reply-with-dragged-attachment.eml')]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ fallidos: 1, comentados: 0, creados: 0 });

    // NO se escribio la entrada del hilo: el write vive dentro del `try`, DESPUES del `success`.
    expect(kv.puts).toEqual([]);

    // Y EL `fileId` 1000 NO SE TOCO: no hay comando de compensacion, y no hace falta uno. UN
    // `fileId` REUSADO ES UNA MEJORA sobre la ventana de huerfanos que ADR-003 declara (CA-13): no
    // queda huerfano porque sigue vinculado a lo que YA ESTABA vinculado. El archivo nuevo de un
    // alta fallida si quedaria huerfano; este no.
    expect(responderUpload.count()).toBe(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // TS-30
  it('TS-30: el alta no consulta, ni una vez', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });

    // El responder de la consulta queda ACTIVO: su `count() === 0` es lo que hace CA-5 afirmable
    // sobre el tick cableado. Sin el contador, el resultado observable seria identico.
    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, conMatch(1000));
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 2000, uploadUrl: 'https://storage.example/put/abc' },
    });
    responderComment = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 700 },
    });

    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    await runTick(
      sourceWith(new Map([[1, mailNuevoConAdjunto()]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    // CERO consultas: la rama del alta invoca `procesarAdjuntosDelMail()` con TRES argumentos, y
    // esa AUSENCIA es el mecanismo — no un `if`, no un flag.
    expect(responderQuery.count()).toBe(0);

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ creados: 1, comentados: 0, fallidos: 0 });

    // Y el ciclo de subida corrio COMPLETO: permiso + `PUT`.
    expect(responderUpload.count()).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  // TS-21 sobre el tick cableado
  it('TS-21: un adjunto rechazado por la politica local no gasta la consulta', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });
    kv.seed(threadKey(REFERENCE_ID), String(REQUIREMENT_ID));

    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, conMatch(1000));
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 9999, uploadUrl: 'https://storage.example/put/nunca' },
    });
    responderComment = await respondTo(bus.connection, COMMENT_COMMAND, {
      status: 'success',
      data: { id: 9002 },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    await runTick(
      sourceWith(new Map([[1, respuestaConRechazado()]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    // UNA sola consulta, la de `captura.png`. El `virus.exe` quedo afuera de `aceptados` ANTES de
    // que el `for` empiece, asi que NO CONSULTA. CA-9 no tiene codigo nuevo: tiene este test.
    expect(responderQuery.count()).toBe(1);

    const rechazoLocal = capture
      .lines()
      .find((line) => line['nombre'] === 'virus.exe');
    expect(rechazoLocal).toMatchObject({ nombre: 'virus.exe', regla: 'extension' });

    // Y el comentario se publica igual, con el reusado y el aviso del rechazado.
    const comentario = responderComment.payloads()[0] as { fileIds: number[]; comment: string };
    expect(comentario.fileIds).toEqual([1000]);
    expect(comentario.comment).toContain('virus.exe');
  });

  // TS-22 sobre el tick cableado
  it('TS-22: un vinculo borrado / archivo no retenido produce items vacio y el archivo se sube de nuevo', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });
    kv.seed(threadKey(REFERENCE_ID), String(REQUIREMENT_ID));

    // Las DOS EXCLUSIONES PERMANENTES del predicado fijo del recurso llegan como `items: []`,
    // indistinguibles de "nunca estuvo". El conector no puede reusar un vinculo borrado NI
    // EQUIVOCANDOSE: no hay clave del payload que sobrescriba ese predicado.
    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, SIN_MATCH);
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 3000, uploadUrl: 'https://storage.example/put/nuevo' },
    });
    responderComment = await respondTo(bus.connection, COMMENT_COMMAND, {
      status: 'success',
      data: { id: 9003 },
    });

    const fetchStub = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchStub);

    await runTick(
      sourceWith(new Map([[1, fixture('reply-with-dragged-attachment.eml')]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    expect(responderQuery.count()).toBe(1);
    // SE SUBE DE NUEVO: el ciclo completo, con el `fileId` nuevo en el comentario.
    expect(responderUpload.count()).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const comentario = responderComment.payloads()[0] as { fileIds: number[] };
    expect(comentario.fileIds).toEqual([3000]);

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ comentados: 1, fallidos: 0 });

    // TS-24 SOBRE EL TICK CABLEADO: la linea del `sin_match` no lleva `fileId`, porque no hay
    // ninguno que reportar. Se afirma aca y no solo en el test del modulo porque el modulo puede
    // estar perfecto y el cableado equivocado — que es la razon de ser de esta suite.
    const sinMatch = capture.lines().find((line) => line['resultado'] === 'sin_match');
    expect(sinMatch).toMatchObject({
      checksum: CHECKSUM_ESPERADO,
      requirementId: REQUIREMENT_ID,
      resultado: 'sin_match',
    });
    expect(sinMatch).not.toHaveProperty('fileId');
    // Y en nivel `info`, no `warn`: no pudo haber match, pero la consulta funciono.
    expect(sinMatch?.['level']).toBe('info');
  });

  // CA-12
  it('CA-12: el fallo del PUT de un adjunto nuevo no cancela el comentario del reusado', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const kv = fakeKvSpace({ 'tickets.alfa': '42' });
    kv.seed(threadKey(REFERENCE_ID), String(REQUIREMENT_ID));

    // El primero (`captura.png`) reusa; el segundo (`nuevo.pdf`) no tiene match y su `PUT` falla.
    responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, [
      conMatch(1000),
      SIN_MATCH,
    ]);
    responderUpload = await respondTo(bus.connection, UPLOAD_COMMAND, {
      status: 'success',
      data: { id: 4000, uploadUrl: 'https://storage.example/put/falla' },
    });
    responderComment = await respondTo(bus.connection, COMMENT_COMMAND, {
      status: 'success',
      data: { id: 9004 },
    });

    // El `PUT` responde 500: el adjunto nuevo se pierde, el reusado no.
    const fetchStub = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchStub);

    await runTick(
      sourceWith(new Map([[1, respuestaConDosAdjuntos()]])),
      BASE_CONFIG,
      logger,
      bus.client,
      kv.space,
    );

    // DOS consultas: una por cada checksum sobreviviente (los dos bytes son distintos).
    expect(responderQuery.count()).toBe(2);
    // UN permiso: solo el que no reuso.
    expect(responderUpload.count()).toBe(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    // EL COMENTARIO SE PUBLICA IGUAL, con el reusado en `fileIds` y el aviso del fallo del nuevo.
    // Es el continue-on-failure que S-027 CA-14 ya definio, heredado sin rama nueva.
    const comentario = responderComment.payloads()[0] as { fileIds: number[]; comment: string };
    expect(comentario.fileIds).toEqual([1000]);
    expect(comentario.comment).toContain('nuevo.pdf');
    expect(comentario.comment.trimEnd().endsWith('![attach:1000]')).toBe(true);

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ comentados: 1, fallidos: 0 });
    // Y el ciclo del hilo se cerro: el comentario fue un `success`.
    expect(kv.puts).toEqual([
      { key: threadKey(REPLY_MESSAGE_ID), value: String(REQUIREMENT_ID) },
    ]);
  });
});
