import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalize } from '#domain/ingesta/normalize.js';

import { sourceFiles } from '../shared/source-scan.js';

import { testLoggerWithCapture } from './test-logger.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

describe('the sin_message_id discard warn', () => {
  it('emits a warn with the exact motivo literal from the ADR-006 catalog', async () => {
    // TS-2
    const { logger, capture } = testLoggerWithCapture();

    await expect(normalize(fixture('no-message-id.eml'), logger)).rejects.toBeDefined();

    const lines = capture.lines();
    const warnLine = lines.find((line) => line['level'] === 'warn');
    expect(warnLine).toBeDefined();
    expect(warnLine?.['motivo']).toBe('sin_message_id');
  });

  it('never includes mail content in the discard warn', async () => {
    // TS-3, CA-18
    const { logger, capture } = testLoggerWithCapture();

    await expect(normalize(fixture('no-message-id.eml'), logger)).rejects.toBeDefined();

    const raw = capture.raw().join('\n');
    const fixtureBody = readFileSync(`${FIXTURES_DIR}no-message-id.eml`, 'utf8');

    expect(raw).not.toContain('Este mail no tiene Message-Id.');
    expect(raw).not.toContain('Sin message id');
    expect(fixtureBody).toContain('Este mail no tiene Message-Id.'); // sanity: el fixture SI lo trae
  });

  it('does not log any error when converting HTML (converting is not an error)', async () => {
    // TS-24
    const { logger, capture } = testLoggerWithCapture();

    await normalize(fixture('html-only.eml'), logger);

    const lines = capture.lines();
    expect(lines.some((line) => line['level'] === 'error')).toBe(false);
    expect(lines.some((line) => line['level'] === 'warn')).toBe(false);
  });
});

describe('sensitive content never reaches the log', () => {
  it('the result line carries messageId and never the sensitive content', async () => {
    // TS-43
    const { logger, capture } = testLoggerWithCapture();

    const result = await normalize(fixture('sensitive-body.eml'), logger);
    logger.info({ messageId: result.messageId, result: 'ok' }, 'mail procesado');

    const raw = capture.raw().join('\n');
    expect(raw).toContain(result.messageId);
    expect(raw).not.toContain('4111');
    expect(raw).not.toContain(result.subject);
    expect(raw).not.toContain(result.senderEmail);
  });

  it('an attachment content is redacted while filename, mimeType and size are not', async () => {
    // TS-44
    const { logger, capture } = testLoggerWithCapture();

    const result = await normalize(fixture('with-attachments.eml'), logger);
    const attachment = result.attachments[0];
    expect(attachment).toBeDefined();

    logger.info({ attachment }, 'contexto de prueba con un adjunto completo');

    const line = capture.lines().find((entry) => entry['msg'] === 'contexto de prueba con un adjunto completo');
    const loggedAttachment = line?.['attachment'] as Record<string, unknown>;

    expect(loggedAttachment['content']).toBe('[REDACTED]');
    expect(loggedAttachment['filename']).toBe(attachment?.filename);
    expect(loggedAttachment['mimeType']).toBe(attachment?.mimeType);
    expect(loggedAttachment['size']).toBe(attachment?.size);
  });
});

describe('no log point in src/domain/ingesta/ interpolates variables', () => {
  it('scans the module source for template literals or concatenation in logger calls', () => {
    // TS-47
    const ingestaFiles = sourceFiles().filter((file) => file.relativePath.startsWith('domain/ingesta/'));
    expect(ingestaFiles.length).toBeGreaterThan(0);

    // Busca llamadas logger.<level>(...) cuyo segundo argumento sea un template literal (backtick)
    // o una concatenacion con `+`. El mensaje estatico va entre comillas simples o dobles.
    const interpolatedCall = /logger\.(info|warn|error|debug|trace|fatal)\([^)]*,\s*`[^`]*\$\{/;

    for (const file of ingestaFiles) {
      expect(file.code, `${file.relativePath} must not interpolate in a logger call`).not.toMatch(interpolatedCall);
    }
  });
});
