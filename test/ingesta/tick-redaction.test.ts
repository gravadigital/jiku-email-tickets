import { readFileSync } from 'node:fs';
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
