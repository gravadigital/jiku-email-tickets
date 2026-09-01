import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { Client } from '@gravadigital/jiku';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runIngestaTick, runTick } from '#domain/ingesta/tick.js';
import type { ImapFlowCtor, ImapFlowLike } from '#infra/imap/client.js';

import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';
import { testLoggerWithCapture } from './test-logger.js';

/**
 * Tarea 4 — TS-25, TS-26, TS-27: un tick completo con mails, adjuntos y un fallo de credenciales
 * no filtra nada sensible por stdout, cada linea es JSON valido, y el tick nunca loguea metadatos
 * de adjunto en este alcance.
 *
 * Desde S-015, el mail exitoso de esta suite (`alfa`, mapeado) dispara una publicacion real: bus
 * real + responder de exito permanente, mismo criterio que `tick.test.ts`. El escenario de fallo de
 * credenciales IMAP (`runIngestaTick` con `failingCtor`) nunca llega a normalizar ningun mail, asi
 * que no depende del responder.
 */

let bus: TestBusContext;
let responder: CoreResponder | undefined;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  responder = await respondTo(bus.connection, 'requirements.new', {
    status: 'success',
    data: { id: 1 },
  });
});

afterAll(async () => {
  await responder?.stop();
  await bus.cleanup();
});

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

/** S-022, Task 4: la linea de metricas del tick, mismo helper que usa `tick.test.ts`. */
function tickLine(capture: { lines(): Record<string, unknown>[] }): Record<string, unknown> | undefined {
  return capture.lines().find((line) => line['msg'] === 'tick completado');
}

/**
 * `with-attachments.eml` trae `To: soporte@grava.io`, que con `routeMail()` cableado en el tick
 * (S-014) resuelve como `sin_slug` (no matchea el subaddress). Esta suite no es sobre ruteo (es
 * CA-17/CA-18: nada sensible se filtra en un ciclo con adjuntos) y su intencion original era un mail
 * EXITOSO, asi que se reescribe el recipient a un slug mapeado (`alfa`, ya declarado en
 * `BASE_CONFIG.ruteo.ticketMap` de este archivo) sin tocar el fixture compartido por otras suites.
 */
function withResolvableRecipient(raw: Buffer): Buffer {
  return Buffer.from(
    raw.toString('utf8').replace('To: soporte@grava.io', 'To: tickets+alfa@grava.io'),
  );
}

const TEST_PASSWORD = 'app-password-de-prueba';
const TEST_USER = 'tickets@ejemplo.com';

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
  imap: { host: 'imap.gmail.com', port: 993, user: TEST_USER, password: TEST_PASSWORD },
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
};

// El contenido sensible real de los fixtures usados, para buscarlo como subcadena exacta.
const WITH_ATTACHMENTS_SUBJECT = 'Con adjunto';
const WITH_ATTACHMENTS_BODY_FRAGMENT = 'Adjunto el documento solicitado';
const WITH_ATTACHMENTS_SENDER = 'cliente@cliente.com';
// El adjunto es un PDF base64 embebido en el fixture, buscado tal cual aparece en el .eml.
const ATTACHMENT_BASE64_FRAGMENT = 'JVBERi0xLjQgZmFrZSBwZGYgY29udGVudCBmb3IgZml4dHVyZSBwdXJwb3Nlcw';

describe('tick — un ciclo completo no filtra nada sensible por stdout (CA-17)', () => {
  it('mails, adjuntos y un fallo de credenciales: nada sensible aparece en el log', async () => {
    const { logger, capture } = testLoggerWithCapture();

    // 1) Un mail exitoso con adjunto.
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [2, 1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        if (uid === 1) throw new Error('descarga fallida'); // TS-25 tambien cubre el warn de fetch
        return { uid, source: withResolvableRecipient(fixture('with-attachments.eml')) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };
    await runTick(source, BASE_CONFIG, logger, bus.client);

    // 2) Una invocacion separada que simula un fallo de credenciales.
    class AuthenticationFailure extends Error {}
    const failingCtor: ImapFlowCtor = () =>
      ({
        connect: async () => {
          throw new AuthenticationFailure('LOGIN failed');
        },
      }) as unknown as ImapFlowLike;
    await runIngestaTick(BASE_CONFIG, logger, {} as unknown as Client, failingCtor);

    const rawLines = capture.raw();
    expect(rawLines.length).toBeGreaterThan(0);

    const fullOutput = rawLines.join('\n');
    expect(fullOutput).not.toContain(TEST_PASSWORD);
    expect(fullOutput).not.toContain(TEST_USER);
    expect(fullOutput).not.toContain(WITH_ATTACHMENTS_SUBJECT);
    expect(fullOutput).not.toContain(WITH_ATTACHMENTS_BODY_FRAGMENT);
    expect(fullOutput).not.toContain(WITH_ATTACHMENTS_SENDER);
    expect(fullOutput).not.toContain(ATTACHMENT_BASE64_FRAGMENT);
    // S-021, TS-18: la uploadUrl prefirmada tampoco aparece en ningun punto del ciclo completo.
    expect(fullOutput).not.toContain('uploadUrl');
  });
});

describe('tick — todas las lineas estan estructuradas y a stdout (CA-17)', () => {
  it('cada linea capturada parsea como JSON valido', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: withResolvableRecipient(fixture('with-attachments.eml')) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    for (const line of capture.raw()) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('tick — nunca loguea metadatos de adjunto en este alcance (CA-18)', () => {
  it('ninguna linea incluye filename, mimeType ni size de ningun adjunto', async () => {
    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: withResolvableRecipient(fixture('with-attachments.eml')) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    await runTick(source, BASE_CONFIG, logger, bus.client);

    for (const line of capture.lines()) {
      expect(line).not.toHaveProperty('filename');
      expect(line).not.toHaveProperty('mimeType');
      expect(line).not.toHaveProperty('size');
    }

    // Actualizado por S-015: el mail resuelve a `alfa` y se publica con exito, asi que la linea de
    // resultado ya no es `'mail procesado'` — es `'requisito creado en Jiku'`, la que
    // `publishRequirementFromMail()` emite con los tres identificadores (CA-14).
    const successLine = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
    expect(successLine).toBeDefined();
    expect(typeof successLine?.['messageId']).toBe('string');
    expect(typeof successLine?.['requirementId']).toBe('number');
  });
});

/**
 * Tarea 5 — TS-24: contenido REAL de cliente (no un literal fijo del modo de verificacion) nunca
 * aparece en la salida cruda de ningun logger, a lo largo de TODO el camino de publicacion —
 * exitoso y fallido. Riesgo 2 de la story: `title`/`description` no estan en `REDACT_PATHS`
 * (deliberado), asi que la unica defensa es que ningun punto de log emita esas claves.
 *
 * Usa su PROPIO responder, dado de baja al terminar cada test: el responder permanente de
 * `beforeAll` (arriba) siempre contesta exito, y este bloque necesita tambien un fallo.
 */
describe('tick — contenido real de cliente nunca se filtra, en exito y en fallo (CA-25, Tarea 5)', () => {
  const SECRET = 'CONTENIDO-SECRETO-DE-CLIENTE';

  function mailWithSecret(uid: number): Buffer {
    return Buffer.from(
      `Message-Id: <secret-${uid}@fixtures.local>\r\n` +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+alfa@grava.io\r\n' +
        `Subject: ${SECRET}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        `${SECRET}\r\n`,
    );
  }

  it('un alta EXITOSA con contenido real de cliente no filtra ese contenido', async () => {
    // Se da de baja el responder permanente del archivo mientras dura este test, para no competir
    // por el mismo mensaje con el responder local.
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailWithSecret(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 777 },
    });

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);
    } finally {
      await local.stop();
      responder = await respondTo(bus.connection, 'requirements.new', {
        status: 'success',
        data: { id: 1 },
      });
    }

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/"(title|description|payload)"\s*:/);

    const successLine = capture.lines().find((line) => line['msg'] === 'requisito creado en Jiku');
    expect(successLine).toMatchObject({ requirementId: 777 });
  });

  it('un alta FALLIDA con contenido real de cliente tampoco filtra ese contenido', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();
    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [2];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailWithSecret(uid) };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);
    } finally {
      await local.stop();
      responder = await respondTo(bus.connection, 'requirements.new', {
        status: 'success',
        data: { id: 1 },
      });
    }

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/"(title|description|payload)"\s*:/);

    const failureLine = capture.lines().find((line) => line['level'] === 'error');
    expect(failureLine).toMatchObject({ diagnosis: 'core_rechazo_por_rol' });

    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({ fallidos: 1, creados: 0 });
  });
});

/**
 * S-016 Tarea 2 — TS-2, TS-8, TS-9, TS-12 (CA-7, CA-11, CA-12, CA-19): un tick COMPLETO con las
 * tres categorias de resultado a la vez (alta exitosa, descartes de motivos distintos, y dos
 * rechazos DISTINTOS del bus) no filtra ningun dato sensible, y cada mail deja al menos una linea
 * distinguible por su resultado.
 *
 * Este escenario es mas amplio que el de arriba (CA-25/Tarea 5 de S-015): ese cubria exito y
 * fallo por separado, con un secreto generico. Este pide EXACTAMENTE el contenido de CA-7 —un
 * numero de tarjeta en el cuerpo y un asunto que lo nombra— para que el fallo sea evidente al leer
 * el output del test, no solo una asercion abstracta; y pide las TRES categorias en el MISMO tick.
 */
describe('tick — un tick completo con alta, descartes y rechazo del bus no filtra nada sensible (S-016 CA-7, CA-11, CA-12, CA-19)', () => {
  const CARD_BODY = 'mi tarjeta es 4111 1111 1111 1111';
  const CARD_SUBJECT = 'Datos de mi tarjeta';

  /** Un mail RFC 822 minimo, parseable, con Message-Id, subject y body configurables. */
  function buildMail(options: {
    uid: number;
    messageId: string;
    recipient: string;
    subject: string;
    body: string;
    referenceIds?: string;
  }): Buffer {
    const referenceHeader =
      options.referenceIds !== undefined ? `In-Reply-To: ${options.referenceIds}\r\n` : '';
    return Buffer.from(
      `Message-Id: ${options.messageId}\r\n` +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        `To: ${options.recipient}\r\n` +
        `Subject: ${options.subject}\r\n` +
        referenceHeader +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        `${options.body}\r\n`,
    );
  }

  it('el tarjeta-en-cuerpo, dos descartes distintos y dos rechazos del bus dejan rastro sin filtrar nada', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();

    // Cinco mails, cinco resultados distintos, en un unico tick:
    //   uid 5: alta EXITOSA, con el contenido sensible de CA-7 (proyecto alfa, mapeado)
    //   uid 4: descartado, es_respuesta (reenvio con References poblado — TS-12/CA-19)
    //   uid 3: descartado, slug_no_mapeado (proyecto beta, no mapeado)
    //   uid 2: fallo de publicacion, caller_not_authorized -> core_rechazo_por_rol
    //   uid 1: fallo de publicacion, invalid_fields -> core_rechazo_por_forma
    const mails = new Map<number, Buffer>([
      [
        5,
        buildMail({
          uid: 5,
          messageId: '<s016-card@fixtures.local>',
          recipient: 'tickets+alfa@grava.io',
          subject: CARD_SUBJECT,
          body: CARD_BODY,
        }),
      ],
      [
        4,
        buildMail({
          uid: 4,
          messageId: '<s016-forward@fixtures.local>',
          recipient: 'tickets+alfa@grava.io',
          subject: 'Fwd: Pedido nuevo',
          body: 'Un pedido nuevo legitimo, reenviado desde un hilo interno.',
          referenceIds: '<hilo-interno@grava.io>',
        }),
      ],
      [
        3,
        buildMail({
          uid: 3,
          messageId: '<s016-unmapped@fixtures.local>',
          recipient: 'tickets+beta@grava.io',
          subject: 'Consulta beta',
          body: 'Contenido de un proyecto sin mapear.',
        }),
      ],
      [
        2,
        buildMail({
          uid: 2,
          messageId: '<s016-role@fixtures.local>',
          recipient: 'tickets+alfa@grava.io',
          subject: 'Rechazo por rol',
          body: 'Este mail dispara caller_not_authorized.',
        }),
      ],
      [
        1,
        buildMail({
          uid: 1,
          messageId: '<s016-shape@fixtures.local>',
          recipient: 'tickets+alfa@grava.io',
          subject: 'Rechazo por forma',
          body: 'Este mail dispara invalid_fields.',
        }),
      ],
    ]);

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [...mails.keys()];
      },
      async fetch(uid: number): Promise<RawMessage> {
        const buffer = mails.get(uid);
        if (buffer === undefined) throw new Error(`no fixture for uid ${uid}`);
        return { uid, source: buffer };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    // Un unico responder que distingue por CANTIDAD de mensajes recibidos: el primero (uid 5, el
    // unico que resuelve y no es rechazado) contesta exito; los otros dos que llegan a publicarse
    // (uid 2 y uid 1) reciben cada uno su propio rechazo, en el orden en que la publicacion ocurre
    // (UID descendente: 5, luego 2, luego 1 — los descartes de uid 4 y 3 nunca publican nada).
    //
    // El tercer rechazo posible (rechazo del BUS por subject, JikuPermissionDenied) NO se cubre en
    // este tick: requeriria un NATS con `--auth` y una identidad sin permiso sobre el subject
    // (ver `test/bus/auth-helpers.ts`), infraestructura pensada para los tests de CONEXION, no de
    // publicacion. El costo de levantar un segundo contenedor para un solo escenario adicional no
    // se justifica aca; ese rechazo ya esta cubierto en el contexto de conexion por
    // `test/bus/connection.test.ts`, y `diagnosePublishFailure()` lo traduce con el mismo criterio
    // estructural que las otras ocho ramas (ver `publish-errors.ts` y `source-properties.test.ts`).
    const local = await respondTo(bus.connection, 'requirements.new', [
      { status: 'success', data: { id: 555 } },
      { status: 'failure', errorCode: 'caller_not_authorized' },
      { status: 'failure', errorCode: 'invalid_fields' },
    ]);

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);
    } finally {
      await local.stop();
      responder = await respondTo(bus.connection, 'requirements.new', {
        status: 'success',
        data: { id: 1 },
      });
    }

    // --- CA-7: nada sensible en TODA la salida cruda, y toda linea es JSON valido ---
    const rawLines = capture.raw();
    expect(rawLines.length).toBeGreaterThan(0);
    const fullOutput = rawLines.join('\n');

    expect(fullOutput).not.toContain('4111 1111 1111 1111');
    expect(fullOutput).not.toContain(CARD_SUBJECT);
    expect(fullOutput).not.toContain(CARD_BODY);
    expect(fullOutput).not.toContain('cliente@cliente.com');
    // El recipient COMPLETO (como valor de un campo) no aparece — el slug si puede aparecer
    // (CA-6), pero nunca la direccion entera del subaddress.
    expect(fullOutput).not.toMatch(/"recipient"\s*:\s*"tickets\+alfa@grava\.io"/);

    for (const line of rawLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // --- CA-11: ningun mail termina sin rastro — una linea por UID, con su resultado ---
    const lines = capture.lines();

    const successLine = lines.find((l) => l['messageId'] === '<s016-card@fixtures.local>');
    expect(successLine).toMatchObject({
      msg: 'requisito creado en Jiku',
      projectId: 42,
      requirementId: 555,
    });

    const forwardLine = lines.find((l) => l['messageId'] === '<s016-forward@fixtures.local>');
    expect(forwardLine).toMatchObject({ msg: 'mail descartado', motivo: 'es_respuesta' });

    const unmappedLine = lines.find((l) => l['messageId'] === '<s016-unmapped@fixtures.local>');
    expect(unmappedLine).toMatchObject({
      msg: 'mail descartado',
      motivo: 'slug_no_mapeado',
      slug: 'beta',
    });

    const roleFailureLine = lines.find((l) => l['messageId'] === '<s016-role@fixtures.local>');
    const shapeFailureLine = lines.find((l) => l['messageId'] === '<s016-shape@fixtures.local>');

    // --- CA-12: los sistemas que rechazan quedan distinguidos, con messageId y projectId ---
    expect(roleFailureLine).toMatchObject({
      msg: 'fallo la publicacion de requirements.new',
      diagnosis: 'core_rechazo_por_rol',
      sdkErrorClass: 'JikuFailure',
      code: 'caller_not_authorized',
      projectId: 42,
      messageId: '<s016-role@fixtures.local>',
    });
    expect(shapeFailureLine).toMatchObject({
      msg: 'fallo la publicacion de requirements.new',
      diagnosis: 'core_rechazo_por_forma',
      sdkErrorClass: 'JikuFailure',
      code: 'invalid_fields',
      projectId: 42,
      messageId: '<s016-shape@fixtures.local>',
    });

    // --- CA-19: el falso positivo del reenvio queda contable por su motivo, junto a otros descartes ---
    const discardMotivos = lines
      .filter((l) => l['msg'] === 'mail descartado')
      .map((l) => l['motivo']);
    expect(discardMotivos).toContain('es_respuesta');
    expect(discardMotivos).toContain('slug_no_mapeado');

    // --- Los cinco contadores reales, en la linea de metricas del tick ---
    const tick = capture.lines().find((line) => line['msg'] === 'tick completado');
    expect(tick).toMatchObject({
      ingestados: 5,
      parseados: 5,
      creados: 1,
      descartados: 2,
      fallidos: 2,
    });
  });
});

/**
 * S-016 Tarea 2 — TS-3 (parcial de CA-7): confirma por CONSTRUCCION que ninguna linea de la suite
 * de arriba pudo haberse escrito a un archivo, porque el unico destino que `testLoggerWithCapture()`
 * le pasa a `createLogger()` es el stream en memoria de `createLogCapture()`. `createLogger()`
 * (`src/shared/logger.ts`) acepta un `destination` y un `transportTarget` opcionales — ninguno de
 * los dos configura un transport de ARCHIVO en ningun entorno (ADR-006: "MUST NOT configurarse
 * ningun transport de archivo").
 */
/**
 * S-022, Task 4 — TS-5 (CA-8): tres adjuntos en el MISMO mail, uno aceptado con exito, uno
 * rechazado por la politica local, uno con permiso concedido pero PUT fallido -- cada uno con
 * contenido UNICO que simula datos de cliente. Ninguno de los tres secretos ni la uploadUrl real
 * aparecen en la salida cruda del tick, en ningun punto de log de ningun modulo (S-017 a S-021).
 * Amplia la cobertura de `tick-redaction.test.ts` (que ya cubria un unico adjunto aceptado) a los
 * tres tipos de resultado combinados.
 */
describe('tick — ningun log de un tick con adjuntos aceptado/rechazado/fallido filtra el contenido (S-022, CA-8, TS-5)', () => {
  const SECRET_A = 'SECRETO-CLIENTE-ADJUNTO-A';
  const SECRET_B = 'SECRETO-CLIENTE-ADJUNTO-B';
  const SECRET_C = 'SECRETO-CLIENTE-ADJUNTO-C';

  function mailConTresAdjuntosMixtos(): Buffer {
    const partOf = (filename: string, mimeType: string, content: string): string =>
      '--ATT-BOUNDARY\r\n' +
      `Content-Type: ${mimeType}\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n` +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      `${Buffer.from(content).toString('base64')}\r\n`;

    return Buffer.from(
      'Message-Id: <s022-nolog-mixto@fixtures.local>\r\n' +
        'From: "Cliente" <cliente@cliente.com>\r\n' +
        'To: tickets+alfa@grava.io\r\n' +
        'Subject: Tres adjuntos mixtos\r\n' +
        'Content-Type: multipart/mixed; boundary="ATT-BOUNDARY"\r\n' +
        'MIME-Version: 1.0\r\n\r\n' +
        '--ATT-BOUNDARY\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        'Cuerpo con tres adjuntos.\r\n' +
        partOf('datos-cliente.png', 'image/png', SECRET_A) +
        partOf('informe.exe', 'application/x-msdownload', SECRET_B) +
        partOf('factura.pdf', 'application/pdf', SECRET_C) +
        '--ATT-BOUNDARY--\r\n',
    );
  }

  it('el contenido de los tres adjuntos nunca aparece; sus nombres y mime si', async () => {
    await responder?.stop();

    const { logger, capture } = testLoggerWithCapture();

    // Servidor HTTP local: el PUT del adjunto con permiso concedido (factura.pdf) falla con 503.
    const failingServer = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.statusCode = 503;
        res.end();
      });
    });
    await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
    const failingAddress = failingServer.address() as AddressInfo;
    const failingUploadUrl = `http://127.0.0.1:${String(failingAddress.port)}/upload`;

    // Servidor HTTP local: el PUT del adjunto aceptado con exito (datos-cliente.png) responde 200.
    const okServer = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => okServer.listen(0, '127.0.0.1', resolve));
    const okAddress = okServer.address() as AddressInfo;
    const okUploadUrl = `http://127.0.0.1:${String(okAddress.port)}/upload`;

    // informe.exe se rechaza LOCALMENTE (extension no permitida) -- nunca pide permiso de subida.
    // Solo datos-cliente.png y factura.pdf llegan a files.request-upload, en ese orden.
    const uploadResponder = await respondTo(bus.connection, 'files.request-upload', [
      { status: 'success', data: { fileId: 700, uploadUrl: okUploadUrl } },
      { status: 'success', data: { fileId: 701, uploadUrl: failingUploadUrl } },
    ]);
    const local = await respondTo(bus.connection, 'requirements.new', {
      status: 'success',
      data: { id: 888 },
    });

    const source: MailSource = {
      async searchUnseen(): Promise<number[]> {
        return [1];
      },
      async fetch(uid: number): Promise<RawMessage> {
        return { uid, source: mailConTresAdjuntosMixtos() };
      },
      async markSeen(): Promise<void> {
        // no-op
      },
    };

    try {
      await runTick(source, BASE_CONFIG, logger, bus.client);

      const raw = capture.raw().join('\n');
      expect(raw).not.toContain(SECRET_A);
      expect(raw).not.toContain(SECRET_B);
      expect(raw).not.toContain(SECRET_C);
      expect(raw).not.toContain('uploadUrl');
      expect(raw).not.toContain(okUploadUrl);
      expect(raw).not.toContain(failingUploadUrl);

      // Los metadatos (nombre, mime) de los adjuntos con AVISO (rechazado/fallido) SI aparecen --
      // la propiedad protege el contenido, no los metadatos ya permitidos. El adjunto subido con
      // EXITO (datos-cliente.png) no genera su propia linea de metadatos -- solo
      // `requestFileUpload()`/`uploadFileContent()` loguean nombre/mime, y ambos lo hacen
      // exclusivamente en sus caminos de rechazo/fallo (nunca en el camino de exito, que no
      // necesita diagnostico); el nombre del adjunto exitoso queda representado igual en el
      // conteo agregado de la linea de alta (`archivosVinculados`), sin exponer metadatos por
      // archivo individual.
      expect(raw).toContain('informe.exe');
      expect(raw).toContain('factura.pdf');
      expect(raw).toContain('application/x-msdownload');
      expect(raw).toContain('application/pdf');

      expect(tickLine(capture)).toMatchObject({ creados: 1, fallidos: 0 });
    } finally {
      await uploadResponder.stop();
      await local.stop();
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
      await new Promise<void>((resolve) => okServer.close(() => resolve()));
      responder = await respondTo(bus.connection, 'requirements.new', {
        status: 'success',
        data: { id: 1 },
      });
    }
  });
});

describe('tick — ninguna linea de log se escribe a un archivo (S-016 CA-7)', () => {
  it('createLogger() nunca recibe ni construye un transport de archivo', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/shared/logger.ts', import.meta.url)),
      'utf8',
    );
    // Ningun transport target de pino apunta a un sink de archivo (pino/file, pino-roll, etc.):
    // el unico transportTarget que existe en el codigo es el de desarrollo, 'pino-pretty', que
    // escribe a stdout formateado, no a un archivo.
    expect(source).not.toMatch(/pino\/file|pino-roll|createWriteStream/);
    expect(source).toMatch(/pino-pretty/);
  });
});
