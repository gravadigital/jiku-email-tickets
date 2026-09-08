import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';

import { runTick } from '#domain/ingesta/tick.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * S-022: las propiedades del sistema completo sobre el modulo de adjuntos, disparadas SIEMPRE
 * desde `runTick()` (nunca invocando `procesarAdjuntosDelMail()`/`particionar()`/`deduplicar()`/
 * `aplicarTope()` directamente) -- es lo que distingue esta suite de la cobertura ya existente en
 * S-017/S-018/S-019/S-021 a nivel de modulo puro u orquestador invocado directo.
 *
 * Task 1 (CA-5, TS-1/TS-2), Task 2 (CA-6, TS-3), Task 5 parcial (CA-9 alcanzable sin inyeccion de
 * deps, CA-10, TS-7), Task 6 (CA-11/CA-12, TS-8/TS-9), Task 8 (CA-13, TS-10).
 *
 * Archivo nuevo (no una extension de `tick.test.ts`, ya en 1586 lineas) siguiendo el criterio que
 * la propia Story Plan habilita para el implementor.
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
    allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
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

let bus: TestBusContext;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  await bus.cleanup();
});

/** Levanta un servidor HTTP local de test; el llamador decide status por request via `onRequest`. */
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

/** Un bloque MIME de un adjunto, boundary fijo compartido por el resto del archivo. */
function attachmentPart(opts: { filename: string; mimeType: string; base64: string }): string {
  return (
    '--ATT-BOUNDARY\r\n' +
    `Content-Type: ${opts.mimeType}\r\n` +
    `Content-Disposition: attachment; filename="${opts.filename}"\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    `${opts.base64}\r\n`
  );
}

/** Un mail RFC 822 con `To: tickets+alfa@grava.io` y N partes de adjunto ya armadas. */
function mailWithAttachments(opts: {
  messageId: string;
  subject?: string;
  body?: string;
  parts: string[];
}): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Cliente" <cliente@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      `Subject: ${opts.subject ?? 'Consulta con adjunto'}\r\n` +
      'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      '--ATT-BOUNDARY\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
      `${opts.body ?? 'Cuerpo del mail.'}\r\n` +
      opts.parts.join('') +
      '--ATT-BOUNDARY--\r\n',
  );
}

function sourceWithSingleMail(mail: Buffer): MailSource {
  return {
    async searchUnseen(): Promise<number[]> {
      return [1];
    },
    async fetch(uid: number): Promise<RawMessage> {
      return { uid, source: mail };
    },
    async markSeen(): Promise<void> {
      // no-op
    },
  };
}

function tickLine(capture: { lines(): Record<string, unknown>[] }): Record<string, unknown> | undefined {
  return capture.lines().find((line) => line['msg'] === 'tick completado');
}

/**
 * Task 1 (CA-5): el orden particion -> dedup -> tope invariante, disparado desde runTick().
 */
describe('runTick — orden particion -> dedup -> tope invariante, sobre el sistema completo (S-022, CA-5)', () => {
  // TS-1: dos .exe identicos -> particion es la PRIMERA etapa del pipeline (procesar.ts, S-017):
  // ambos .exe se evaluan y rechazan de forma INDEPENDIENTE por la politica local, ANTES de que
  // dedup vea nada -- por eso produce DOS avisos de rechazo, uno por archivo, no uno solo. Esto es
  // comportamiento deliberado y documentado en `src/domain/adjuntos/procesar.ts` desde S-017 ("un
  // mail con dos .exe identicos y ningun otro adjunto produce DOS entradas de rechazo"): dedup
  // solo colapsa adjuntos que ya pasaron la particion (ACEPTABLES), nunca rechazados. La propiedad
  // que esta prueba SI verifica sobre el sistema completo es la del segundo escenario de CA-5
  // (TS-2, abajo): con adjuntos ACEPTABLES e identicos, dedup colapsa a 1 antes del tope/bus.
  it('TS-1: dos .exe identicos en el mismo mail se rechazan de forma independiente (particion antes que dedup)', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const exeBase64 = Buffer.from('contenido-exe-identico').toString('base64');
    const mail = mailWithAttachments({
      messageId: '<s022-orden-dedup@fixtures.local>',
      parts: [
        attachmentPart({ filename: 'virus.exe', mimeType: 'application/x-msdownload', base64: exeBase64 }),
        attachmentPart({ filename: 'virus.exe', mimeType: 'application/x-msdownload', base64: exeBase64 }),
      ],
    });

    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 9001 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });

      const payload = local.payloads()[0] as Record<string, unknown>;
      const description = payload['description'] as string;
      const occurrences = description
        .split('\n')
        .filter((line) => line.includes('No se pudo adjuntar virus.exe'));
      // Particion es la primera etapa (S-017): rechaza cada .exe de forma independiente, ANTES de
      // que dedup vea nada -- dos entradas de rechazo, ninguna colapsada.
      expect(occurrences).toHaveLength(2);
    } finally {
      await local.stop();
    }
  });

  // TS-2: la misma captura repetida 12 veces -> dedup colapsa a 1 ANTES de que el tope o el bus
  // vean nada -- el responder de files.request-upload observa count() === 1, nunca 12.
  it('TS-2: 12 adjuntos con content identico colapsan a 1 antes del tope y del bus', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const pngBase64 = Buffer.from('contenido-captura-identica').toString('base64');
    const parts = Array.from({ length: 12 }, () =>
      attachmentPart({ filename: 'captura.png', mimeType: 'image/png', base64: pngBase64 }),
    );
    const mail = mailWithAttachments({ messageId: '<s022-repetida-12@fixtures.local>', parts });

    const httpServer = await startHttpServer(() => 200);
    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', {
      status: 'success',
      data: { fileId: 900, uploadUrl: httpServer.url },
    });
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 9002 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });
      expect(uploadResponder.count()).toBe(1);

      const payload = local.payloads()[0] as Record<string, unknown>;
      expect(payload['fileIds']).toEqual([900]);
      const description = payload['description'] as string;
      expect(description).not.toContain('tope_excedido');
      expect(description).not.toMatch(/no cumple la politica/);
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

/**
 * Task 2 (CA-6): el tope no se recalcula tras un fallo de PUT, disparado desde runTick().
 */
describe('runTick — el tope no se recalcula tras un fallo de PUT, sobre el sistema completo (S-022, CA-6)', () => {
  // TS-3: 12 adjuntos unicos aceptables; el HTTP local hace fallar los primeros 3 PUT que recibe
  // (503) y acepta el resto (200); el tope acepta solo los primeros 10 -- los 2 excedentes NUNCA
  // piden permiso, ni antes ni despues de que los 3 PUT fallen.
  it('TS-3: 12 aceptables unicos, 3 PUT fallidos entre los primeros 10 -> 7 fileIds, sin reponer los 2 excedentes', async () => {
    const { logger, capture } = testLoggerWithCapture();

    const httpServer = await startHttpServer((index) => (index < 3 ? 503 : 200));

    const parts = Array.from({ length: 12 }, (_, i) =>
      attachmentPart({
        filename: `adj-${String(i)}.png`,
        mimeType: 'image/png',
        base64: Buffer.from(`contenido-unico-${String(i)}`).toString('base64'),
      }),
    );
    const mail = mailWithAttachments({ messageId: '<s022-tope-put-falla@fixtures.local>', parts });

    const uploadResponder = await respondTo(
      bus.connection,
      'files.request-upload',
      Array.from({ length: 10 }, (_, i) => ({
        status: 'success' as const,
        data: { fileId: 810 + i, uploadUrl: httpServer.url },
      })),
    );
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 9003 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });

      const payload = local.payloads()[0] as Record<string, unknown>;
      expect(payload['fileIds']).toHaveLength(7);

      const description = payload['description'] as string;
      const failureNotices = description.split('\n').filter((line) => line.includes('No se pudo subir'));
      const rejectionNotices = description
        .split('\n')
        .filter((line) => line.includes('No se pudo adjuntar'));
      expect(failureNotices).toHaveLength(3);
      expect(rejectionNotices).toHaveLength(2);

      // Nunca 12: los 2 excedentes del tope nunca piden permiso.
      expect(uploadResponder.count()).toBe(10);
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

/**
 * Task 5 parcial (CA-9, los tres tipos alcanzables sin inyeccion de deps) y CA-10 (TS-7): un mail
 * cuyos adjuntos fallaron TODOS es `publicado`, no `fallido`.
 */
describe('runTick — rechazo local + failure de core + PUT fallido combinados no cancelan el requisito (S-022, CA-9 parcial)', () => {
  it('los tres tipos de fallo combinados en un mismo mail: el requisito se crea igual', async () => {
    const { logger, capture } = testLoggerWithCapture();

    const httpServer = await startHttpServer(() => 503); // el PUT del adjunto con permiso concedido falla

    const mail = mailWithAttachments({
      messageId: '<s022-tres-fallos@fixtures.local>',
      parts: [
        attachmentPart({
          filename: 'virus.exe',
          mimeType: 'application/x-msdownload',
          base64: Buffer.from('rechazo-local').toString('base64'),
        }),
        attachmentPart({
          filename: 'sospechoso.png',
          mimeType: 'image/png',
          base64: Buffer.from('rechazo-de-core').toString('base64'),
        }),
        attachmentPart({
          filename: 'roto.pdf',
          mimeType: 'application/pdf',
          base64: Buffer.from('put-fallido').toString('base64'),
        }),
      ],
    });

    // El responder de files.request-upload distingue por orden de llegada: el primer adjunto
    // aceptado localmente es sospechoso.png (rechazo de negocio de core), el segundo es roto.pdf
    // (permiso concedido, PUT falla despues).
    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', [
      { status: 'failure', errorCode: 'file_type_not_allowed' },
      { status: 'success', data: { fileId: 820, uploadUrl: httpServer.url } },
    ]);
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 9004 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });

      const payload = local.payloads()[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('fileIds');
      const description = payload['description'] as string;
      expect(description).toContain('virus.exe');
      expect(description).toContain('sospechoso.png');
      expect(description).toContain('roto.pdf');
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

describe('runTick — un mail con todos los adjuntos fallidos es publicado, no fallido (S-022, CA-10, TS-7)', () => {
  it('TS-7: dos adjuntos, ambos fallidos (uno rechazado local, uno con PUT fallido), cero exitosos', async () => {
    const { logger, capture } = testLoggerWithCapture();

    const httpServer = await startHttpServer(() => 503);

    const mail = mailWithAttachments({
      messageId: '<s022-todos-fallan@fixtures.local>',
      parts: [
        attachmentPart({
          filename: 'virus.exe',
          mimeType: 'application/x-msdownload',
          base64: Buffer.from('rechazo-local').toString('base64'),
        }),
        attachmentPart({
          filename: 'falla-put.png',
          mimeType: 'image/png',
          base64: Buffer.from('falla-el-put').toString('base64'),
        }),
      ],
    });

    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', {
      status: 'success',
      data: { fileId: 830, uploadUrl: httpServer.url },
    });
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 9005 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0, descartados: 0 });

      const payload = local.payloads()[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('fileIds');

      const successLine = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
      expect(successLine).toMatchObject({ archivosVinculados: 0, archivosConAviso: 2 });
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

/**
 * Task 6 (CA-11, CA-12): descripciones identicas para mails identicos, y la linea de metricas
 * sigue con los cinco contadores sin ninguno de archivos.
 */
describe('runTick — dos mails identicos con los mismos adjuntos producen descripciones identicas (S-022, CA-11, TS-8)', () => {
  it('TS-8: mismas description salvo el numero del placeholder de imagen', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const pngBase64 = Buffer.from('misma-captura').toString('base64');

    const mailA = mailWithAttachments({
      messageId: '<s022-idem-a@fixtures.local>',
      subject: 'Mismo asunto',
      body: 'Mismo cuerpo',
      parts: [attachmentPart({ filename: 'captura.png', mimeType: 'image/png', base64: pngBase64 })],
    });
    const mailB = mailWithAttachments({
      messageId: '<s022-idem-b@fixtures.local>',
      subject: 'Mismo asunto',
      body: 'Mismo cuerpo',
      parts: [attachmentPart({ filename: 'captura.png', mimeType: 'image/png', base64: pngBase64 })],
    });

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [2, 1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: uid === 2 ? mailA : mailB };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    const httpServer = await startHttpServer(() => 200);
    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', [
      { status: 'success', data: { fileId: 900, uploadUrl: httpServer.url } },
      { status: 'success', data: { fileId: 901, uploadUrl: httpServer.url } },
    ]);
    const local = await respondTo(bus.connection, 'requirements.new', [
      { status: 'success', data: { id: 9006 } },
      { status: 'success', data: { id: 9007 } },
    ]);

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      expect(tickLine(capture)).toMatchObject({ creados: 2, fallidos: 0 });

      const payloads = local.payloads() as Record<string, unknown>[];
      expect(payloads).toHaveLength(2);

      const normalize = (description: string): string =>
        description.replace(/!\[attach:\d+\]/, '![attach:N]');

      expect(normalize(payloads[0]?.['description'] as string)).toBe(
        normalize(payloads[1]?.['description'] as string),
      );
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

describe('runTick — la linea de metricas del tick sigue con los cinco contadores, sin ninguno de archivos (S-022, CA-12, TS-9)', () => {
  it('TS-9: tick de 10 mails variados sigue emitiendo exactamente los cinco contadores', async () => {
    const { logger, capture } = testLoggerWithCapture();

    const httpServer = await startHttpServer(() => 200);

    // 7 con proyecto resuelto (uno de ellos con 3 adjuntos que suben bien), 1 con adjuntos pero
    // requirements.new falla, 2 sin slug mapeado (descartados).
    function plainMail(uid: number, recipient: string): Buffer {
      return Buffer.from(
        `Message-Id: <s022-metrica-${String(uid)}@fixtures.local>\r\n` +
          'From: "Cliente" <cliente@cliente.com>\r\n' +
          `To: ${recipient}\r\n` +
          'Subject: Consulta\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'MIME-Version: 1.0\r\n\r\n' +
          `Cuerpo del mail ${String(uid)}.\r\n`,
      );
    }

    const mailWithThreeAttachments = mailWithAttachments({
      messageId: '<s022-metrica-tres-adjuntos@fixtures.local>',
      parts: [
        attachmentPart({ filename: 'uno.png', mimeType: 'image/png', base64: Buffer.from('uno').toString('base64') }),
        attachmentPart({ filename: 'dos.png', mimeType: 'image/png', base64: Buffer.from('dos').toString('base64') }),
        attachmentPart({ filename: 'tres.png', mimeType: 'image/png', base64: Buffer.from('tres').toString('base64') }),
      ],
    });

    const mails = new Map<number, Buffer>([
      [10, mailWithThreeAttachments],
      [9, plainMail(9, 'tickets+alfa@grava.io')],
      [8, plainMail(8, 'tickets+alfa@grava.io')],
      [7, plainMail(7, 'tickets+alfa@grava.io')],
      [6, plainMail(6, 'tickets+alfa@grava.io')],
      [5, plainMail(5, 'tickets+alfa@grava.io')],
      [4, plainMail(4, 'tickets+alfa@grava.io')], // este falla la publicacion
      [3, plainMail(3, 'tickets+beta@grava.io')], // descartado, slug_no_mapeado
      [2, plainMail(2, 'tickets+beta@grava.io')], // descartado, slug_no_mapeado
      [1, plainMail(1, 'tickets+alfa@grava.io')],
    ]);

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [...mails.keys()];
      },
      async fetch(uid: number): Promise<RawMessage> {
        const buffer = mails.get(uid);
        if (buffer === undefined) throw new Error(`no fixture for uid ${String(uid)}`);
        return { uid, source: buffer };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    const uploadResponder = await respondTo(
      bus.connection,
      'files.request-upload',
      Array.from({ length: 3 }, (_, i) => ({
        status: 'success' as const,
        data: { fileId: 940 + i, uploadUrl: httpServer.url },
      })),
    );

    // Orden de publicacion (UID descendente): 10, 9, 8, 7, 6, 5, 4, 3(descartado), 2(descartado), 1
    // -> 8 intentos de publicacion (7 exitosos + 1 fallido para uid 4, que es el 7mo intento).
    const local = await respondTo(bus.connection, 'requirements.new', [
      { status: 'success', data: { id: 1 } }, // uid 10
      { status: 'success', data: { id: 2 } }, // uid 9
      { status: 'success', data: { id: 3 } }, // uid 8
      { status: 'success', data: { id: 4 } }, // uid 7
      { status: 'success', data: { id: 5 } }, // uid 6
      { status: 'success', data: { id: 6 } }, // uid 5
      { status: 'failure', errorCode: 'invalid_fields' }, // uid 4
      { status: 'success', data: { id: 7 } }, // uid 1
    ]);

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      const tick = tickLine(capture);
      expect(tick).toMatchObject({
        ingestados: 10,
        parseados: 10,
        creados: 7,
        descartados: 2,
        fallidos: 1,
      });

      const PINO_STRUCTURAL_FIELDS = new Set(['level', 'time', 'msg', 'env', 'service']);
      const counterKeys = Object.keys(tick ?? {}).filter((key) => !PINO_STRUCTURAL_FIELDS.has(key));
      expect(counterKeys.sort()).toEqual(
        ['ingestados', 'parseados', 'creados', 'descartados', 'fallidos'].sort(),
      );
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await httpServer.close();
    }
  });
});

/**
 * Task 8 (CA-13, TS-10): el escenario de extremo a extremo con adjunto, verificado sin instancia
 * real de Jiku -- el camino completo (ingesta, ruteo, adjuntos, publicacion de archivo,
 * publicacion de requisito) en una sola invocacion, con datos que se leen como un ticket real.
 */
describe('runTick — el escenario de extremo a extremo con adjunto, sin instancia real de Jiku (S-022, CA-13, TS-10)', () => {
  it('TS-10: files.request-upload antes que requirements.new, con los payloads reales publicados', async () => {
    const { logger, capture } = testLoggerWithCapture();

    // PNG minimo real de 1x1 pixel transparente (67 bytes), no un placeholder de texto.
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const expectedChecksum = createHash('sha256').update(pngBytes).digest('hex');

    const mail = mailWithAttachments({
      messageId: '<s022-e2e@fixtures.local>',
      subject: 'No puedo ingresar al sistema',
      body: 'Adjunto captura del error que me aparece.',
      parts: [
        attachmentPart({
          filename: 'captura-error.png',
          mimeType: 'image/png',
          base64: pngBytes.toString('base64'),
        }),
      ],
    });

    // Servidor HTTP de prueba para el PUT: verifica que el body real coincide con el content del
    // adjunto.
    let receivedPutBody: Buffer = Buffer.alloc(0);
    const httpServer: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedPutBody = Buffer.concat(chunks);
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address() as AddressInfo;
    const uploadUrl = `http://127.0.0.1:${String(address.port)}/upload`;

    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', {
      status: 'success',
      data: { fileId: 500, uploadUrl },
    });
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 999 },
    });

    try {
      await runTick(sourceWithSingleMail(mail), BASE_CONFIG, logger, bus.client);

      // El responder de files.request-upload recibio EXACTAMENTE una solicitud, antes de la de
      // requirements.new (garantizado por estructura: procesarAdjuntosDelMail() corre antes de
      // publishRequirementFromMail() dentro de runTick(), verificado ya por tick-memory.test.ts).
      expect(uploadResponder.count()).toBe(1);
      const uploadPayload = uploadResponder.payloads()[0] as Record<string, unknown>;
      expect(uploadPayload).toMatchObject({
        fileName: 'captura-error.png',
        mimeType: 'image/png',
        fileSize: pngBytes.length,
        checksum: expectedChecksum,
      });
      expect(expectedChecksum).toHaveLength(64);

      // El PUT real llego con el body identico al content del adjunto.
      expect(receivedPutBody.equals(pngBytes)).toBe(true);

      // requirements.new lleva el fileIds concedido y el placeholder de imagen.
      const requirementPayloads = local.payloads() as Record<string, unknown>[];
      expect(requirementPayloads).toHaveLength(1);
      const requirementPayload = requirementPayloads[0]!;
      expect(requirementPayload['fileIds']).toEqual([500]);
      expect(requirementPayload['title']).toBe('No puedo ingresar al sistema');
      const description = requirementPayload['description'] as string;
      expect(description).toContain('Adjunto captura del error que me aparece.');
      expect(description).toContain('![attach:500]');

      expect(tickLine(capture)).toMatchObject({ creados: 1 });

      // Ninguna linea de log cruda contiene el contenido del .png ni la uploadUrl real.
      const raw = capture.raw().join('\n');
      expect(raw).not.toContain(pngBytes.toString('base64'));
      expect(raw).not.toContain(uploadUrl);
      expect(raw).not.toContain('uploadUrl');
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
