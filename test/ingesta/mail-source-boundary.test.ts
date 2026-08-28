import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from '../shared/source-scan.js';

/**
 * TS-4, TS-6, TS-8, TS-12, TS-20, TS-21: propiedades de la forma "no existe ningun camino de
 * codigo que X", verificadas por escaneo de fuente sin comentarios — un test de comportamiento no
 * puede probar una ausencia, solo los caminos que ejercita (mismo criterio que
 * `test/bus/source-properties.test.ts` y `test/config/source-properties.test.ts`).
 *
 * Reusa `test/shared/source-scan.ts` (S-007) en vez de duplicar el walker, tal como indica el
 * Reusable Code de la Story Plan.
 */

const FILES = sourceFiles();
const IMAP_DIR_PREFIX = /^infra[/\\]imap[/\\]/;
const INGESTA_DIR_PREFIX = /^domain[/\\]ingesta[/\\]/;

describe('src/ mail source boundary properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Sanidad del escaner: sin esto, un escaner roto haria pasar el resto de los tests sin
    // verificar nada.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.some((file) => IMAP_DIR_PREFIX.test(file.relativePath))).toBe(true);
  });

  // TS-20
  it('imports imapflow only from files under infra/imap/', () => {
    const importers = FILES.filter((file) => /from\s*'imapflow'/.test(file.code)).map(
      (file) => file.relativePath,
    );

    expect(importers.length).toBeGreaterThan(0);
    for (const relativePath of importers) {
      expect(relativePath).toMatch(IMAP_DIR_PREFIX);
    }
  });

  // TS-21
  it('domain/ingesta never imports imapflow nor an internal infra/imap symbol outside the port', () => {
    const ingestaFiles = FILES.filter((file) => INGESTA_DIR_PREFIX.test(file.relativePath));
    expect(ingestaFiles.length).toBeGreaterThan(0);

    for (const file of ingestaFiles) {
      expect(file.code, `${file.relativePath} must not import imapflow`).not.toMatch(
        /from\s*'imapflow'/,
      );
      expect(file.code, `${file.relativePath} must not import from infra/imap`).not.toMatch(
        /from\s*'#infra\/imap/,
      );
    }
  });

  // TS-4
  it('never derives secure from config or an env var — only the literal true', () => {
    const imapFiles = FILES.filter((file) => IMAP_DIR_PREFIX.test(file.relativePath));
    expect(imapFiles.length).toBeGreaterThan(0);

    for (const file of imapFiles) {
      expect(file.code, `${file.relativePath} must not disable TLS`).not.toMatch(/secure\s*:\s*false/);
      expect(file.code, `${file.relativePath} must not derive secure from config`).not.toMatch(
        /secure\s*:\s*config\./,
      );
      expect(file.code, `${file.relativePath} must not derive secure from env`).not.toMatch(
        /secure\s*:\s*env\./,
      );
    }

    const hasLiteralSecureTrue = imapFiles.some((file) => /secure\s*:\s*true/.test(file.code));
    expect(hasLiteralSecureTrue).toBe(true);
  });

  // TS-6
  it('never derives logger from config or an env var — only the literal false', () => {
    const imapFiles = FILES.filter((file) => IMAP_DIR_PREFIX.test(file.relativePath));

    for (const file of imapFiles) {
      expect(file.code, `${file.relativePath} must not enable the imapflow logger`).not.toMatch(
        /logger\s*:\s*true/,
      );
      expect(file.code, `${file.relativePath} must not derive logger from config`).not.toMatch(
        /logger\s*:\s*config\./,
      );
      expect(file.code, `${file.relativePath} must not derive logger from env`).not.toMatch(
        /logger\s*:\s*env\./,
      );
    }

    const hasLiteralLoggerFalse = imapFiles.some((file) => /logger\s*:\s*false/.test(file.code));
    expect(hasLiteralLoggerFalse).toBe(true);
  });

  // TS-8
  it('declares INBOX as a module constant and never reads process.env', () => {
    const clientFile = readSource('infra/imap/client.ts');

    expect(clientFile).toMatch(/const INBOX\s*=\s*'INBOX'/);

    const imapFiles = FILES.filter((file) => IMAP_DIR_PREFIX.test(file.relativePath));
    for (const file of imapFiles) {
      expect(file.code, `${file.relativePath} must not read process.env`).not.toContain(
        'process.env',
      );
    }
  });

  // TS-12
  it('never references maxPerTick anywhere in infra/imap', () => {
    const imapFiles = FILES.filter((file) => IMAP_DIR_PREFIX.test(file.relativePath));
    expect(imapFiles.length).toBeGreaterThan(0);

    for (const file of imapFiles) {
      expect(file.code, `${file.relativePath} must not reference maxPerTick`).not.toMatch(
        /maxPerTick/,
      );
    }
  });

  it('offers no batch-marking signature (uids: number[]) in infra/imap', () => {
    const imapFiles = FILES.filter((file) => IMAP_DIR_PREFIX.test(file.relativePath));

    for (const file of imapFiles) {
      expect(file.code, `${file.relativePath} must not declare a batch uids[] marking signature`).not.toMatch(
        /uids\s*:\s*number\[\]/,
      );
    }
  });
});
