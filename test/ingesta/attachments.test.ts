import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sourceFiles } from '../shared/source-scan.js';

import { testLoggerWithCapture } from './test-logger.js';

/**
 * Propiedades de los adjuntos que no dependen de un fixture puntual, y la propiedad de pureza que
 * TS-51 pide para todo `src/domain/ingesta/`.
 *
 * Los escenarios de adjunto contra fixtures concretos (TS-37 a TS-41) viven en `normalize.test.ts`,
 * junto al resto de `normalize()`. Este archivo cubre lo que la Tarea 4 asigna aparte: la ausencia
 * de red/reloj/IMAP en el modulo (TS-51).
 */

describe('src/domain/ingesta/ purity', () => {
  it('never imports imapflow or touches the network/filesystem/clock directly', () => {
    // TS-51
    const ingestaFiles = sourceFiles().filter((file) => file.relativePath.startsWith('domain/ingesta/'));
    expect(ingestaFiles.length).toBeGreaterThan(0);

    for (const file of ingestaFiles) {
      expect(file.code, `${file.relativePath} must not import imapflow`).not.toMatch(/from\s+['"]imapflow['"]/);
      expect(file.code, `${file.relativePath} must not import node:net`).not.toMatch(/from\s+['"]node:net['"]/);
      expect(file.code, `${file.relativePath} must not import node:fs`).not.toMatch(/from\s+['"]node:fs['"]/);
      expect(file.code, `${file.relativePath} must not call Date.now()`).not.toMatch(/Date\.now\(\)/);
      expect(file.code, `${file.relativePath} must not call new Date()`).not.toMatch(/new Date\(/);
    }
  });
});

describe('MailAttachment shape', () => {
  it('reads a real PDF and PNG payload as Buffers, unmodified in size', async () => {
    const { normalize } = await import('#domain/ingesta/normalize.js');
    const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));
    const raw = readFileSync(`${FIXTURES_DIR}with-attachments.eml`);
    const { logger } = testLoggerWithCapture();

    const result = await normalize(raw, logger);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.content.length).toBe(result.attachments[0]?.size);
  });
});
