import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runIngestaTick, runTick } from '#domain/ingesta/tick.js';
import type { ImapFlowCtor, ImapFlowLike } from '#infra/imap/client.js';

import { testLoggerWithCapture } from './test-logger.js';

/**
 * Tarea 4 — TS-25, TS-26, TS-27: un tick completo con mails, adjuntos y un fallo de credenciales
 * no filtra nada sensible por stdout, cada linea es JSON valido, y el tick nunca loguea metadatos
 * de adjunto en este alcance.
 */

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
    await runTick(source, BASE_CONFIG, logger);

    // 2) Una invocacion separada que simula un fallo de credenciales.
    class AuthenticationFailure extends Error {}
    const failingCtor: ImapFlowCtor = () =>
      ({
        connect: async () => {
          throw new AuthenticationFailure('LOGIN failed');
        },
      }) as unknown as ImapFlowLike;
    await runIngestaTick(BASE_CONFIG, logger, failingCtor);

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

    await runTick(source, BASE_CONFIG, logger);

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

    await runTick(source, BASE_CONFIG, logger);

    for (const line of capture.lines()) {
      expect(line).not.toHaveProperty('filename');
      expect(line).not.toHaveProperty('mimeType');
      expect(line).not.toHaveProperty('size');
    }

    const successLine = capture.lines().find((line) => line['msg'] === 'mail procesado');
    expect(successLine).toBeDefined();
    // El unico contexto de dominio que el tick agrega en el caso exitoso: messageId y resultado.
    expect(successLine).toMatchObject({ resultado: 'normalizado' });
    expect(typeof successLine?.['messageId']).toBe('string');
  });
});
