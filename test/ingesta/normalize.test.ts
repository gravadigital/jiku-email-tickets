import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MissingMessageIdError } from '#domain/ingesta/errors.js';
import { normalize } from '#domain/ingesta/normalize.js';

import { testLoggerWithCapture } from './test-logger.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

describe('normalize', () => {
  it('throws MissingMessageIdError for a mail without Message-Id', async () => {
    // TS-1
    const { logger } = testLoggerWithCapture();
    await expect(normalize(fixture('no-message-id.eml'), logger)).rejects.toBeInstanceOf(MissingMessageIdError);
    await expect(normalize(fixture('no-message-id.eml'), logger)).rejects.toMatchObject({ code: 'SIN_MESSAGE_ID' });
  });

  it('strips stacked subject prefixes from a real .eml', async () => {
    // TS-5, CA-19
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('re-re-fwd-subject.eml'), logger);
    expect(result.subject).toBe('Falla en el login');
  });

  it('leaves subject empty (not undefined) when there is no Subject header', async () => {
    // TS-8
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('no-subject.eml'), logger);
    expect(result.subject).toBe('');
  });

  it('merges referenceIds from a real .eml with In-Reply-To and References', async () => {
    // TS-10, CA-19
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('in-reply-to.eml'), logger);
    expect(result.referenceIds).toEqual(['<a@x>', '<b@x>']);
  });

  it('returns an array (not a bare string) for a single References value', async () => {
    // TS-11 sobre normalize
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('single-reference.eml'), logger);
    expect(result.referenceIds).toEqual(['<only@x>']);
  });

  it('leaves referenceIds empty for a new mail', async () => {
    // TS-12
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('plain-text.eml'), logger);
    expect(result.referenceIds).toEqual([]);
  });

  it('prefers Delivered-To over To from a real .eml', async () => {
    // TS-13
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('delivered-to-multiple.eml'), logger);
    expect(result.recipient).toBe('tickets+alfa@grava.io');
  });

  it('keeps the recipient raw, without extracting a slug', async () => {
    // TS-14
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('delivered-to-multiple.eml'), logger);
    expect(result.recipient).toBe('tickets+alfa@grava.io');
    expect(result).not.toHaveProperty('slug');
  });

  it('falls back to To when there is no Delivered-To', async () => {
    // TS-15
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('to-fallback.eml'), logger);
    expect(result.recipient).toBe('tickets+beta@grava.io');
  });

  it('picks only the first Delivered-To when there are two', async () => {
    // TS-16
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('delivered-to-multiple.eml'), logger);
    expect(result.recipient).toBe('tickets+alfa@grava.io');
    expect(result.recipient).not.toContain(', ');
  });

  it('leaves recipient empty and still normalizes when neither header is present', async () => {
    // TS-17
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('no-recipient.eml'), logger);
    expect(result.recipient).toBe('');
    expect(result.messageId).toBeTruthy();
  });

  it('isolates senderEmail from a real .eml with a display-name From', async () => {
    // TS-21, CA-19
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('plain-text.eml'), logger);
    expect(result.senderEmail).toBe('juan@cliente.com');
  });

  it('leaves subject empty for a real .eml whose subject was only prefixes', async () => {
    // TS-7 (mitad .eml)
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('subject-only-prefixes.eml'), logger);
    expect(result.subject).toBe('');
  });

  it('converts an HTML-only real .eml without the URL or the img, keeping line breaks', async () => {
    // TS-22, CA-11, CA-19
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('html-only.eml'), logger);

    expect(result.body).toContain('acá');
    expect(result.body).not.toContain('http://x');
    expect(result.body).not.toContain('logo.png');
    expect(result.body).toContain('\n');
  });

  it('regression: the html-only body never contains the text mailparser synthesizes on its own', async () => {
    // TS-23: prueba que se uso html-to-text y no el parsed.text sintetizado por mailparser.
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('html-only.eml'), logger);

    expect(result.body).not.toContain('[http://x]');
    expect(result.body).not.toContain('[logo.png]');
  });

  it('prefers the plain text part over HTML on a real multipart/alternative .eml', async () => {
    // TS-25, CA-12
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('both-text-and-html.eml'), logger);

    expect(result.body).toBe('texto plano real');
    expect(result.body).not.toContain('version html');
  });

  it('leaves body empty for a real .eml with only an attachment, and logs no error', async () => {
    // TS-26, CA-13
    const { logger, capture } = testLoggerWithCapture();
    const result = await normalize(fixture('no-body.eml'), logger);

    expect(result.body).toBe('');
    expect(capture.lines().some((line) => line['level'] === 'error')).toBe(false);
  });

  it('trims the quoted thread text from a real reply .eml', async () => {
    // TS-27, CA-14, CA-19
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('quoted-reply.eml'), logger);

    expect(result.body).toContain('Se soluciona reiniciando el servicio.');
    expect(result.body).not.toContain('No arranca el login desde ayer');
    expect(result.body).not.toContain('Probamos de todo');
  });

  it('trims quoted text after converting HTML, in the same single point for both branches', async () => {
    // TS-36
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('html-only-quoted-reply.eml'), logger);

    expect(result.body).toBe('Ya lo revisamos y esta resuelto.');
    expect(result.body).not.toContain('No arranca el login');
  });

  it('returns 2 attachments, uncollapsed, for a mail with duplicate attachments', async () => {
    // duplicate-attachments.eml: su semantica de colapso por checksum es de FG-4; esta story solo
    // confirma que los dos salen SIN colapsar (no hay checksum todavia).
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('duplicate-attachments.eml'), logger);

    expect(result.attachments).toHaveLength(2);
    for (const attachment of result.attachments) {
      expect(attachment).not.toHaveProperty('checksum');
    }
  });

  it('returns 2 attachments with their six fields, PDF and inline PNG', async () => {
    // TS-37
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('inline-image.eml'), logger);
    expect(result.attachments).toHaveLength(2);

    const inline = result.attachments.find((att) => att.contentDisposition === 'inline');
    expect(inline).toMatchObject({
      filename: 'logo.png',
      mimeType: 'image/png',
      contentDisposition: 'inline',
      contentId: '<logo>',
    });
    expect(typeof inline?.size).toBe('number');
    expect(Buffer.isBuffer(inline?.content)).toBe(true);
  });

  it('never attaches a checksum', async () => {
    // TS-38
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('inline-image.eml'), logger);
    for (const attachment of result.attachments) {
      expect(attachment).not.toHaveProperty('checksum');
    }
  });

  it('parses an oversized attachment and an .exe without error', async () => {
    // TS-39
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('oversized-and-exe.eml'), logger);
    expect(result.attachments).toHaveLength(2);
  });

  it('keeps the declared mimeType, unverified', async () => {
    // TS-40
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('declared-mime-mismatch.eml'), logger);
    expect(result.attachments[0]?.mimeType).toBe('application/pdf');
  });

  it('falls back to "unnamed" for an attachment without filename', async () => {
    // TS-41
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('attachment-without-filename.eml'), logger);
    expect(typeof result.attachments[0]?.filename).toBe('string');
    expect(result.attachments[0]?.filename).toBe('unnamed');
  });

  it('leaves attachments empty for a mail without any', async () => {
    // TS-42
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('plain-text.eml'), logger);
    expect(result.attachments).toEqual([]);
  });

  it('throws when mailparser cannot parse the input at all', async () => {
    // TS-49
    const { logger } = testLoggerWithCapture();
    await expect(normalize(Buffer.from('esto no es un mail'), logger)).rejects.toBeDefined();
  });

  it('produces all seven fields with the right types for a plain-text mail', async () => {
    // TS-50
    const { logger } = testLoggerWithCapture();
    const result = await normalize(fixture('plain-text.eml'), logger);

    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.referenceIds)).toBe(true);
    expect(typeof result.recipient).toBe('string');
    expect(typeof result.senderEmail).toBe('string');
    expect(typeof result.subject).toBe('string');
    expect(typeof result.body).toBe('string');
    expect(Array.isArray(result.attachments)).toBe(true);
  });
});
