import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AppConfig } from '#config/index.js';
import { MIN_TIMEOUT_MS } from '#config/schema.js';
import type { MailAttachment } from '#domain/ingesta/types.js';
import { procesarAdjuntosDelMail } from '#domain/publicacion/procesar-adjuntos-mail.js';
import { requestFileUpload as requestFileUploadReal } from '#domain/publicacion/upload-file.js';
import { uploadFileContent as uploadFileContentReal } from '#domain/publicacion/upload-byte.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, TEST_INSTANCE, TEST_USER_ID, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo, respondToQuery } from '../bus/responder.js';
import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * TS-1, TS-5, TS-6, TS-8, TS-9, TS-10, TS-16, TS-18 (Task 3): el orquestador del procesamiento de
 * adjuntos por mail, contra el NATS real del contenedor compartido (para `files.request-upload`) y
 * un servidor HTTP de prueba (para el `PUT`) -- mismo patron que `upload-file.test.ts` y
 * `upload-byte.test.ts` ya usan por separado, combinados aca porque el orquestador invoca ambos en
 * serie.
 */

const COMMAND = 'files.request-upload';
/**
 * S-029: el nombre COMPLETO de la operacion del plano de LECTURA, tal como el SDK lo arma desde
 * `client.list('attachments', ...)`.
 */
const QUERY_METHOD = 'attachments.list';

const CONFIG_ADJUNTOS = {
  allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
  maxSizeBytes: 10_485_760,
  putTimeoutMs: 30_000,
};

/**
 * El `content` default incluye SIEMPRE el `filename` para que dos adjuntos con nombres distintos
 * nunca colisionen por dedup (`deduplicar()` compara por checksum del contenido, no por nombre) --
 * a menos que un test pase `content` explicito para forzar la colision a proposito.
 */
function attachment(overrides: Partial<MailAttachment> = {}): MailAttachment {
  const filename = overrides.filename ?? 'captura.png';

  return {
    filename,
    mimeType: 'image/png',
    size: 100,
    content: Buffer.from(`contenido de prueba de ${filename}`),
    contentDisposition: 'attachment',
    ...overrides,
  };
}

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: TEST_INSTANCE,
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: 'proj-uuid',
    issuer: 'https://unreachable-issuer.invalid',
    timeoutMs: MIN_TIMEOUT_MS,
    verifyProjectId: 7,
    logLevel: 'trace',
    nodeEnv: 'test',
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
    adjuntos: CONFIG_ADJUNTOS,
    ...overrides,
  };
}

function loggerFor(sink: LogCapture): ReturnType<typeof createLogger> {
  return createLogger(configWith({ logLevel: 'trace' }), sink.stream);
}

let bus: TestBusContext;
let capture: LogCapture;
let responder: CoreResponder | undefined;
let httpServer: Server;
let uploadUrl: string;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));

  // Servidor HTTP real de prueba para el PUT -- mismo criterio que upload-byte.test.ts documenta
  // para su propia suite. Los tests que necesitan observar el ORDEN entrelazado de bus+HTTP (TS-5)
  // levantan su propio servidor local en vez de este, que solo resuelve el PUT con 200 para los
  // demas casos.
  httpServer = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.statusCode = 200;
      res.end();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  uploadUrl = `http://127.0.0.1:${String(address.port)}/upload`;
});

afterAll(async () => {
  await bus.cleanup();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

afterEach(async () => {
  await responder?.stop();
  responder = undefined;
});

describe('procesarAdjuntosDelMail', () => {
  // Adjuntos[] vacio: todas las listas vacias, ninguna llamada al bus ni al storage.
  it('con cero adjuntos, todas las listas quedan vacias y no se llama al bus ni al storage', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: {} });

    const resultado = await procesarAdjuntosDelMail([], CONFIG_ADJUNTOS, {
      client: bus.client,
      logger: loggerFor(capture),
    });

    expect(resultado).toEqual({
      fileIds: [],
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: [],
    });
    expect(responder.count()).toBe(0);
  });

  // TS-1: dos adjuntos aceptables suben ambos, fileIds con los dos ids, placeholders en orden.
  it('dos adjuntos aceptables suben ambos: fileIds con ambos ids y placeholders en orden', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, [
      { status: 'success', data: { fileId: 101, uploadUrl } },
      { status: 'success', data: { fileId: 102, uploadUrl } },
    ]);

    const resultado = await procesarAdjuntosDelMail(
      [
        attachment({ filename: 'captura.png', mimeType: 'image/png' }),
        attachment({ filename: 'datos.pdf', mimeType: 'application/pdf' }),
      ],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(resultado.fileIds).toEqual([101, 102]);
    expect(resultado.placeholders).toEqual(['![attach:101]', '[attach:102]']);
    expect(resultado.avisosDeRechazo).toEqual([]);
    expect(resultado.avisosDeFallo).toEqual([]);
  });

  // TS-5: orden par-por-archivo -- request-upload(A) -> PUT(A) -> request-upload(B) -> PUT(B),
  // nunca request-upload(A), request-upload(B), PUT(A), PUT(B).
  //
  // Se instrumenta un unico registro de eventos (`order`) compartido entre el responder del bus
  // (que anota "request-upload" al RECIBIR cada mensaje, antes de contestar) y el servidor HTTP
  // (que anota "PUT" al recibir cada PUT) -- el orden de aparicion en `order` es el orden real de
  // invocacion, sin inferencias posteriores por conteo.
  it('procesa en serie, par por archivo: request-upload y PUT de A antes de pedir el permiso de B', async () => {
    capture = createLogCapture();
    const order: string[] = [];

    // Server local (distinto del global `httpServer`) para poder anotar el nombre del archivo via
    // query string y compartir el mismo array `order` con el responder del bus.
    const localServer = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      order.push(`PUT ${url.searchParams.get('file') ?? ''}`);
      req.on('data', () => undefined);
      req.on('end', () => {
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    const urlFor = (file: string): string =>
      `http://127.0.0.1:${String(address.port)}/upload?file=${file}`;

    // El responder generico de bus/responder.ts no expone un callback por mensaje, asi que aca se
    // suscribe un responder AD HOC (mismo patron de bajo nivel que respondTo(), pero anotando el
    // nombre del archivo ANTES de contestar, leido del propio payload publicado).
    const subscription = bus.connection.subscribe(`*.*.jiku-commands.v1.${COMMAND}`);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let fileIdSeq = 700;
    void (async () => {
      for await (const message of subscription) {
        const payload = JSON.parse(decoder.decode(message.data)) as { fileName: string };
        order.push(`request-upload ${payload.fileName}`);
        fileIdSeq += 1;
        message.respond(
          encoder.encode(
            JSON.stringify({ status: 'success', data: { fileId: fileIdSeq, uploadUrl: urlFor(payload.fileName) } }),
          ),
        );
      }
    })();
    await bus.connection.flush();

    try {
      await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'a.png', mimeType: 'image/png' }),
          attachment({ filename: 'b.png', mimeType: 'image/png' }),
        ],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
      );
    } finally {
      await subscription.drain();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }

    expect(order).toEqual([
      'request-upload a.png',
      'PUT a.png',
      'request-upload b.png',
      'PUT b.png',
    ]);
  });

  // TS-6: 12 adjuntos unicos aceptables, el tope acepta los primeros 10 y rechaza los ultimos 2
  // (tope_excedido); de esos 10, el PUT de 3 falla. El requisito debe llevar 7 fileIds, SIN reponer
  // los 2 excedentes con ninguno de los fallidos -- el tope no se recalcula por los fallos de PUT
  // (CA-5).
  it('con 12 aceptables y 3 PUT fallidos entre los primeros 10, quedan 7 fileIds sin reponer los 2 excedentes', async () => {
    capture = createLogCapture();

    // Servidor local que hace fallar el PUT de los primeros 3 archivos (por indice de llegada) y
    // acepta el resto -- permite decidir cuales de los 10 aceptados (dentro del tope) fallan sin
    // depender del orden interno de aplicarTope()/procesarAdjuntos().
    let putCount = 0;
    const localServer = createServer((req, res) => {
      putCount += 1;
      req.on('data', () => undefined);
      req.on('end', () => {
        // Los primeros 3 PUT que llegan fallan (503); el resto sube con exito.
        res.statusCode = putCount <= 3 ? 503 : 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address() as AddressInfo;
    const localUploadUrl = `http://127.0.0.1:${String(address.port)}/upload`;

    // 12 adjuntos con contenido distinto (nunca colisionan por dedup): 10 dentro del tope, 2
    // excedentes que aplicarTope() rechaza ANTES de llegar al bus.
    const attachments = Array.from({ length: 12 }, (_, i) =>
      attachment({ filename: `archivo-${String(i)}.png`, mimeType: 'image/png' }),
    );

    responder = await respondTo(
      bus.connection,
      COMMAND,
      Array.from({ length: 10 }, (_, i) => ({
        status: 'success' as const,
        data: { fileId: 800 + i, uploadUrl: localUploadUrl },
      })),
    );

    try {
      const resultado = await procesarAdjuntosDelMail(attachments, CONFIG_ADJUNTOS, {
        client: bus.client,
        logger: loggerFor(capture),
      });

      // 10 - 3 fallidos = 7 fileIds vinculados.
      expect(resultado.fileIds).toHaveLength(7);
      // 3 avisos de fallo de subida (los PUT fallidos) + 2 avisos de rechazo (tope_excedido).
      expect(resultado.avisosDeFallo).toHaveLength(3);
      expect(resultado.avisosDeRechazo).toHaveLength(2);
      // Solo 10 request-upload publicados -- los 2 excedentes NUNCA piden permiso de subida.
      expect(responder.count()).toBe(10);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  // TS-8: failure de core (file_type_not_allowed) -> aviso de rechazo, mismo bloque que local.
  it('un failure de core (file_type_not_allowed) produce un aviso de rechazo, no de fallo', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_type_not_allowed',
    });

    const resultado = await procesarAdjuntosDelMail(
      [attachment({ filename: 'sospechoso.png', mimeType: 'image/png' })],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(resultado.fileIds).toEqual([]);
    expect(resultado.avisosDeRechazo).toHaveLength(1);
    expect(resultado.avisosDeRechazo[0]).toContain('sospechoso.png');
    expect(resultado.avisosDeFallo).toEqual([]);
  });

  // TS-9: PUT fallido -> aviso de fallo (bloque distinto del de rechazo).
  it('un PUT fallido produce un aviso de fallo de subida, sin el fileId de ese adjunto', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 301, uploadUrl: 'http://127.0.0.1:1/no-existe' },
    });

    const resultado = await procesarAdjuntosDelMail(
      [attachment({ filename: 'falla-put.png', mimeType: 'image/png' })],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(resultado.fileIds).toEqual([]);
    expect(resultado.avisosDeFallo).toHaveLength(1);
    expect(resultado.avisosDeFallo[0]).toContain('falla-put.png');
    expect(resultado.avisosDeRechazo).toEqual([]);
  });

  // TS-10: excepcion inesperada en el procesamiento de un adjunto no detiene a los siguientes.
  //
  // La implementacion real de requestFileUpload()/uploadFileContent() nunca lanza para un
  // resultado de negocio (siempre resuelve un valor tipado) -- por eso el Story Plan pide
  // explicitamente "un doble de requestFileUpload() ... que lanza una excepcion arbitraria" para
  // ejercitar el try/catch de PROGRAMACION del orquestador, distinto del try/catch de negocio que
  // ya cubren TS-8/TS-9. `requestFileUpload`/`uploadFileContent` son inyectables por parametro,
  // mismo patron que `Normalize` en tick.ts.
  it('una excepcion inesperada de programacion procesando un adjunto no detiene el procesamiento de los siguientes', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, [
      { status: 'success', data: { fileId: 401, uploadUrl } }, // el segundo adjunto sube normalmente
    ]);

    let llamadas = 0;
    const requestFileUploadDoble: typeof requestFileUploadReal = async (adjunto, deps) => {
      llamadas += 1;
      if (llamadas === 1) {
        throw new Error('excepcion de programacion no contemplada por los tipos de retorno');
      }
      return requestFileUploadReal(adjunto, deps);
    };

    const resultado = await procesarAdjuntosDelMail(
      [
        attachment({ filename: 'roto.png', mimeType: 'image/png' }),
        attachment({ filename: 'siguiente.png', mimeType: 'image/png' }),
      ],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture), requestFileUpload: requestFileUploadDoble },
    );

    // El primero (roto) termina en aviso de fallo, nunca escapa como excepcion; el segundo se
    // procesa igual, con su fileId presente.
    expect(resultado.avisosDeFallo).toHaveLength(1);
    expect(resultado.avisosDeFallo[0]).toContain('roto.png');
    expect(resultado.fileIds).toEqual([401]);

    const errorLine = capture.lines().find((l) => l['level'] === 'error' && l['nombre'] === 'roto.png');
    expect(errorLine).toBeDefined();
  });

  // TS-16: rechazo local + rechazo de core en el mismo mail, mismo bloque de descripcion, log
  // distinto por nivel y codigo.
  it('rechazo local (info) y rechazo de core (warn+code) van al mismo bloque, distintos en el log', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'file_too_large',
    });

    const resultado = await procesarAdjuntosDelMail(
      [
        attachment({ filename: 'virus.exe', mimeType: 'application/x-msdownload' }), // rechazo local
        attachment({ filename: 'grande.pdf', mimeType: 'application/pdf' }), // rechazo de core
      ],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(resultado.avisosDeRechazo).toHaveLength(2);
    expect(resultado.avisosDeRechazo.some((a) => a.includes('virus.exe'))).toBe(true);
    expect(resultado.avisosDeRechazo.some((a) => a.includes('grande.pdf'))).toBe(true);

    const infoLine = capture.lines().find((l) => l['level'] === 'info' && l['nombre'] === 'virus.exe');
    const warnLine = capture.lines().find((l) => l['level'] === 'warn' && l['nombre'] === 'grande.pdf');

    expect(infoLine).toBeDefined();
    expect(warnLine).toBeDefined();
    expect(warnLine?.['code']).toBe('file_too_large');
  });

  // TS-18: ninguna linea de log de la orquestacion completa incluye la uploadUrl.
  it('ninguna linea de log incluye la uploadUrl', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'success',
      data: { fileId: 501, uploadUrl },
    });

    await procesarAdjuntosDelMail(
      [attachment({ filename: 'con-url.png', mimeType: 'image/png' })],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain(uploadUrl);
    expect(raw).not.toContain('uploadUrl');
  });

  // S-022, Task 5 — TS-6 (CA-9): los CUATRO tipos de fallo de archivo combinados en el mismo mail
  // (rechazo local, failure de negocio de core, PUT fallido, y un error inesperado de
  // PROGRAMACION inyectado via `deps.uploadFileContent`) no cancelan el resultado: el orquestador
  // sigue procesando y termina con fileIds vacio, 2 avisos de rechazo y 2 avisos de fallo.
  it('S-022 TS-6: los cuatro tipos de fallo de archivo combinados no cancelan el procesamiento', async () => {
    capture = createLogCapture();

    // adjunto 2 (sospechoso.png): failure de negocio de core.
    // adjunto 3 (roto.pdf): permiso concedido, PUT falla (503).
    responder = await respondTo(bus.connection, COMMAND, [
      { status: 'failure', errorCode: 'file_type_not_allowed' },
      { status: 'success', data: { fileId: 850, uploadUrl: 'http://127.0.0.1:1/no-existe' } },
      { status: 'success', data: { fileId: 851, uploadUrl } },
    ]);

    // adjunto 4 (raro.png): un doble de uploadFileContent que lanza una excepcion arbitraria de
    // programacion, no contemplada por los tipos de retorno -- mismo patron que el test TS-10 de
    // arriba usa para requestFileUpload, aca aplicado a uploadFileContent para no interferir con
    // el permiso ya concedido del adjunto 3 (roto.pdf), que conserva su fallo real de PUT (503).
    const resultado = await procesarAdjuntosDelMail(
      [
        attachment({ filename: 'virus.exe', mimeType: 'application/x-msdownload' }), // rechazo LOCAL
        attachment({ filename: 'sospechoso.png', mimeType: 'image/png' }), // failure de core
        attachment({ filename: 'roto.pdf', mimeType: 'application/pdf' }), // PUT fallido (503)
        attachment({ filename: 'raro.png', mimeType: 'image/png' }), // excepcion de programacion
      ],
      CONFIG_ADJUNTOS,
      {
        client: bus.client,
        logger: loggerFor(capture),
        uploadFileContent: async (adjunto, deps) => {
          if (adjunto.filename === 'raro.png') {
            throw new Error('fallo inesperado de programacion');
          }
          return uploadFileContentReal(adjunto, deps);
        },
      },
    );

    expect(resultado.fileIds).toEqual([]);
    expect(resultado.avisosDeRechazo).toHaveLength(2); // virus.exe (local) + sospechoso.png (core)
    expect(resultado.avisosDeFallo).toHaveLength(2); // roto.pdf (PUT 503) + raro.png (excepcion)
    expect(resultado.avisosDeRechazo.some((a) => a.includes('virus.exe'))).toBe(true);
    expect(resultado.avisosDeRechazo.some((a) => a.includes('sospechoso.png'))).toBe(true);
    expect(resultado.avisosDeFallo.some((a) => a.includes('roto.pdf'))).toBe(true);
    expect(resultado.avisosDeFallo.some((a) => a.includes('raro.png'))).toBe(true);
  });

  // Placeholder de imagen vs no-imagen, segun adjunto.mimeType.
  it('adjunto image/png produce placeholder con !, adjunto application/pdf produce placeholder sin !', async () => {
    capture = createLogCapture();
    responder = await respondTo(bus.connection, COMMAND, [
      { status: 'success', data: { fileId: 601, uploadUrl } },
      { status: 'success', data: { fileId: 602, uploadUrl } },
    ]);

    const resultado = await procesarAdjuntosDelMail(
      [
        attachment({ filename: 'imagen.png', mimeType: 'image/png' }),
        attachment({ filename: 'documento.pdf', mimeType: 'application/pdf' }),
      ],
      CONFIG_ADJUNTOS,
      { client: bus.client, logger: loggerFor(capture) },
    );

    expect(resultado.placeholders).toEqual(['![attach:601]', '[attach:602]']);
  });

  // ==== S-029: LA CONSULTA DE REUSO CONTRA EL HILO ====
  //
  // Todos los casos de ARRIBA invocan con TRES argumentos, asi que ejercitan el camino del ALTA —
  // que es exactamente la regresion que hay que no tener. Los de abajo pasan el CUARTO.
  //
  // El `checksum` NUNCA se escribe a mano: se calcula del MISMO byte que `attachment()` produce.
  // Un literal se desincronizaria del fixture en silencio, el responder contestaria para un
  // checksum que nunca se pidio, y el test pasaria en verde afirmando lo contrario de lo que cree.
  describe('la consulta de reuso (S-029)', () => {
    let responderQuery: CoreResponder | undefined;

    afterEach(async () => {
      await responderQuery?.stop();
      responderQuery = undefined;
    });

    /** El checksum que `deduplicar()` va a calcular para ese nombre de archivo. */
    function checksumDe(filename: string): string {
      return createHash('sha256')
        .update(attachment({ filename }).content)
        .digest('hex');
    }

    function coleccionConMatch(
      fileId: number,
      checksum: string,
    ): { status: 'success'; data: unknown } {
      return {
        status: 'success',
        data: {
          items: [{ id: 77, fileId, checksum }],
          page: { limit: 1, returned: 1 },
        },
      };
    }

    const SIN_MATCH = {
      status: 'success' as const,
      data: { items: [], page: { limit: 1, returned: 0 } },
    };

    // TS-3
    it('el reuso corta el ciclo: no hay files.request-upload ni PUT', async () => {
      capture = createLogCapture();
      responderQuery = await respondToQuery(
        bus.connection,
        QUERY_METHOD,
        coleccionConMatch(1000, checksumDe('captura.png')),
      );
      // El responder del permiso queda ACTIVO a proposito: su `count() === 0` es la unica forma de
      // afirmar que el ciclo se corto. Sin el, un permiso pedido y no contestado se veria como un
      // timeout y el test diagnosticaria otra cosa.
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 9999, uploadUrl },
      });

      const resultado = await procesarAdjuntosDelMail(
        [attachment({ filename: 'captura.png', mimeType: 'image/png' })],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      expect(resultado).toEqual({
        fileIds: [1000],
        placeholders: ['![attach:1000]'],
        avisosDeRechazo: [],
        avisosDeFallo: [],
      });
      expect(responderQuery.count()).toBe(1);
      // LAS DOS ASERCIONES NEGATIVAS, que son las que de verdad prueban el reuso.
      expect(responder.count()).toBe(0);
    });

    // TS-4
    it('sin match, el ciclo completo de subida se ejecuta', async () => {
      capture = createLogCapture();
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, SIN_MATCH);
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 2000, uploadUrl },
      });

      const resultado = await procesarAdjuntosDelMail(
        [attachment({ filename: 'captura.png', mimeType: 'image/png' })],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      expect(resultado.fileIds).toEqual([2000]);
      expect(resultado.placeholders).toEqual(['![attach:2000]']);
      expect(resultado.avisosDeFallo).toEqual([]);
      expect(responderQuery.count()).toBe(1);
      expect(responder.count()).toBe(1);
    });

    // TS-5
    it('el placeholder de un reuso usa el MIME, igual que un subido', async () => {
      capture = createLogCapture();
      // Dos reusos, con el checksum de CADA archivo: son bytes distintos (el `content` default
      // incluye el nombre), asi que `deduplicar()` no los colapsa y hay DOS consultas.
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, [
        coleccionConMatch(1000, checksumDe('captura.png')),
        coleccionConMatch(1001, checksumDe('manual.pdf')),
      ]);

      const resultado = await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
          attachment({ filename: 'manual.pdf', mimeType: 'application/pdf' }),
        ],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      // `!` para el `image/*` y sin `!` para el resto — lo emite `placeholderPara()`, LA MISMA
      // funcion que usa el camino del subido, y por eso no hay rama nueva que mantener.
      expect(resultado.placeholders).toEqual(['![attach:1000]', '[attach:1001]']);
      expect(resultado.fileIds).toEqual([1000, 1001]);
      expect(responderQuery.count()).toBe(2);
    });

    // TS-7
    it('subido por otro actor: no matchea, y se sube con la identidad del conector', async () => {
      capture = createLogCapture();
      // El responder simula que el filtro `uploadedBy` excluyo la fila: el archivo existe en el
      // requisito, pero lo subio otra identidad.
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, SIN_MATCH);
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 3000, uploadUrl },
      });

      const resultado = await procesarAdjuntosDelMail(
        [attachment({ filename: 'captura.png', mimeType: 'image/png' })],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      expect(resultado.fileIds).toEqual([3000]);
      expect(responder.count()).toBe(1);
    });

    // TS-10
    it('el dedup intra-mail se aplica primero: UNA sola consulta para dos adjuntos identicos', async () => {
      capture = createLogCapture();
      responderQuery = await respondToQuery(
        bus.connection,
        QUERY_METHOD,
        coleccionConMatch(1000, checksumDe('captura.png')),
      );

      // Los dos con el MISMO `content` (mismo nombre → mismo byte): `deduplicar()` los colapsa
      // ANTES de que el `for` empiece, asi que la consulta se paga UNA vez.
      const resultado = await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
        ],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      // UNA, no dos. Es CA-4 y no requiere codigo nuevo: `procesarAdjuntos()` corre antes del `for`.
      expect(responderQuery.count()).toBe(1);
      expect(resultado.fileIds).toEqual([1000]);
      expect(resultado.placeholders).toEqual(['![attach:1000]']);
      // Y el colapsado NO deja aviso ni placeholder (ADR-003).
      expect(resultado.avisosDeRechazo).toEqual([]);
      expect(resultado.avisosDeFallo).toEqual([]);
    });

    // TS-11
    it('el mail nuevo no consulta: sin el cuarto argumento, count() es 0', async () => {
      capture = createLogCapture();
      // El responder de la consulta queda ACTIVO: su `count() === 0` es lo que hace CA-5
      // afirmable. Sin el contador, el resultado observable seria identico con y sin consulta.
      responderQuery = await respondToQuery(
        bus.connection,
        QUERY_METHOD,
        coleccionConMatch(1000, checksumDe('captura.png')),
      );
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 4000, uploadUrl },
      });

      // TRES ARGUMENTOS. Es la rama del alta, y su "no consultar" es ESTRUCTURAL.
      const resultado = await procesarAdjuntosDelMail(
        [attachment({ filename: 'captura.png', mimeType: 'image/png' })],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
      );

      expect(responderQuery.count()).toBe(0);
      expect(resultado.fileIds).toEqual([4000]);
      expect(responder.count()).toBe(1);
    });

    // TS-13
    it('con la consulta lanzando, el fileId nuevo aparece igual en fileIds', async () => {
      capture = createLogCapture();
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 5000, uploadUrl },
      });

      // LA CONSULTA REAL NUNCA LANZA (CA-11), asi que el unico modo de ejercitar el `try/catch` de
      // programacion del `for` con un fallo de la consulta es inyectar un doble que lance.
      const resultado = await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
          attachment({ filename: 'segundo.pdf', mimeType: 'application/pdf' }),
        ],
        CONFIG_ADJUNTOS,
        {
          client: bus.client,
          logger: loggerFor(capture),
          lookupAttachmentByChecksum: () => {
            throw new Error('boom');
          },
        },
        { requirementId: 500 },
      );

      // El `for` CONTINUA: los dos adjuntos dejan aviso de fallo y ninguno escapa hacia el
      // llamador. Es el continue-on-failure que S-021 ya definio, heredado sin rama nueva.
      expect(resultado.avisosDeFallo).toHaveLength(2);
      expect(resultado.fileIds).toEqual([]);
      // Con el doble lanzando para TODOS los adjuntos, ninguno llega al ciclo de subida — de ahi
      // `fileIds: []`. El caso hermano de abajo es el que afirma la otra mitad de TS-13: que
      // cuando la consulta lanza para UNO, el `fileId` nuevo del SIGUIENTE aparece igual.
      // Y el `error` del `for` se logueo SIN el contenido del adjunto.
      const errores = capture.lines().filter((line) => line['level'] === 'error');
      expect(errores).toHaveLength(2);
      expect(capture.raw().join('\n')).not.toMatch(/"content"\s*:/);
    });

    // TS-13 (la otra mitad): con la consulta lanzando para UN adjunto, el `fileId` NUEVO del
    // siguiente aparece igual en `fileIds`. Es lo que prueba que el `try/catch` del `for` aisla por
    // adjunto y no aborta el mail — el escenario literal del Story Plan.
    it('con la consulta lanzando para uno, el fileId nuevo del siguiente aparece igual en fileIds', async () => {
      capture = createLogCapture();
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 5100, uploadUrl },
      });

      // El doble lanza SOLO para `captura.png`; para el resto devuelve `sin_match` y el adjunto
      // sigue el ciclo completo.
      const resultado = await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
          attachment({ filename: 'segundo.pdf', mimeType: 'application/pdf' }),
        ],
        CONFIG_ADJUNTOS,
        {
          client: bus.client,
          logger: loggerFor(capture),
          lookupAttachmentByChecksum: ({ adjunto }) => {
            if (adjunto.filename === 'captura.png') throw new Error('boom');
            return Promise.resolve({ tipo: 'sin_match' as const });
          },
        },
        { requirementId: 500 },
      );

      // El primero deja aviso de fallo; el SEGUNDO sube y su `fileId` nuevo esta en `fileIds`.
      expect(resultado.avisosDeFallo).toHaveLength(1);
      expect(resultado.avisosDeFallo[0]).toContain('captura.png');
      expect(resultado.fileIds).toEqual([5100]);
      expect(resultado.placeholders).toEqual(['[attach:5100]']);
      // Un solo permiso: el del que no lanzo.
      expect(responder.count()).toBe(1);
    });

    // TS-19
    it('el tope corre antes de la consulta: los excedentes no pagan', async () => {
      capture = createLogCapture();
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, SIN_MATCH);
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 7000, uploadUrl },
      });

      // 12 adjuntos aceptables y DISTINTOS (nombres distintos → bytes distintos → sin dedup).
      const doce = Array.from({ length: 12 }, (_, index) =>
        attachment({ filename: `archivo-${String(index)}.png`, mimeType: 'image/png' }),
      );

      const resultado = await procesarAdjuntosDelMail(
        doce,
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      // 10, no 12: `aplicarTope()` corre ANTES del `for`, asi que los dos excedentes NO PAGAN
      // CONSULTA. Es CA-7 y tampoco requiere codigo nuevo.
      expect(responderQuery.count()).toBe(10);
      expect(resultado.fileIds.length).toBeLessThanOrEqual(10);
      expect(resultado.avisosDeRechazo).toHaveLength(2);
    });

    // TS-20
    it('el tope no se recalcula tras un reuso: 10 ids, reusados y nuevos indistinguibles', async () => {
      capture = createLogCapture();
      // Los 4 primeros reusan; del quinto en adelante, `items: []` y suben.
      const secuencia = [
        coleccionConMatch(1000, checksumDe('archivo-0.png')),
        coleccionConMatch(1001, checksumDe('archivo-1.png')),
        coleccionConMatch(1002, checksumDe('archivo-2.png')),
        coleccionConMatch(1003, checksumDe('archivo-3.png')),
        SIN_MATCH,
      ];
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, secuencia);
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 8000, uploadUrl },
      });

      const doce = Array.from({ length: 12 }, (_, index) =>
        attachment({ filename: `archivo-${String(index)}.png`, mimeType: 'image/png' }),
      );

      const resultado = await procesarAdjuntosDelMail(
        doce,
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      // EXACTAMENTE 10, con los 4 reusados adelante. NO SE REPONE NINGUNO de los 2 excedentes: el
      // tope ya se aplico y el reuso no libera cupo.
      expect(resultado.fileIds).toHaveLength(10);
      expect(resultado.fileIds.slice(0, 4)).toEqual([1000, 1001, 1002, 1003]);
      expect(resultado.avisosDeRechazo).toHaveLength(2);
      // 10 consultas, una por aceptado dentro del tope.
      expect(responderQuery.count()).toBe(10);
      // Y solo 6 permisos: los 4 reusados cortaron el ciclo.
      expect(responder.count()).toBe(6);
    });

    // TS-21
    it('un rechazado por la politica local no consulta', async () => {
      capture = createLogCapture();
      responderQuery = await respondToQuery(bus.connection, QUERY_METHOD, SIN_MATCH);
      responder = await respondTo(bus.connection, COMMAND, {
        status: 'success',
        data: { fileId: 6000, uploadUrl },
      });

      const resultado = await procesarAdjuntosDelMail(
        [
          attachment({ filename: 'virus.exe', mimeType: 'application/octet-stream' }),
          attachment({ filename: 'captura.png', mimeType: 'image/png' }),
        ],
        CONFIG_ADJUNTOS,
        { client: bus.client, logger: loggerFor(capture) },
        { requirementId: 500 },
      );

      // UNA sola consulta, y es la de `captura.png`: el `for` solo itera `aceptados`, asi que el
      // rechazado NO CONSULTA. Es CA-9, y no hay codigo nuevo para cumplirlo — hay este test.
      expect(responderQuery.count()).toBe(1);
      expect(resultado.avisosDeRechazo).toHaveLength(1);
      expect(resultado.avisosDeRechazo[0]).toContain('virus.exe');
      expect(resultado.fileIds).toEqual([6000]);

      const rechazoLocal = capture
        .lines()
        .find((line) => line['level'] === 'info' && line['nombre'] === 'virus.exe');
      expect(rechazoLocal).toMatchObject({ nombre: 'virus.exe', regla: 'extension' });
    });
  });
});
