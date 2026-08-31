import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sourceFiles } from '../shared/source-scan.js';

const ADJUNTOS_DIR = `domain${sep}adjuntos${sep}`;

/**
 * CA-14 de S-017: "el modulo es puro y no publica nada". Un test de comportamiento no puede
 * afirmar la AUSENCIA de un camino de codigo -- solo puede probar los caminos que ejercita -- asi
 * que se escanea el codigo fuente, mismo patron que `test/config/source-properties.test.ts` y
 * `test/bus/source-properties.test.ts`, incluido su test de sanidad del scanner.
 */
describe('src/domain/adjuntos/ source properties (CA-14)', () => {
  const adjuntosFiles = sourceFiles().filter((f) => f.relativePath.startsWith(ADJUNTOS_DIR));

  it('finds the source files it is meant to scan', () => {
    // Si el scanner devolviera vacio, todos los tests de abajo pasarian sin verificar nada.
    expect(adjuntosFiles.length).toBeGreaterThanOrEqual(5);
    expect(adjuntosFiles.map((f) => f.relativePath)).toContain(`${ADJUNTOS_DIR}types.ts`);
  });

  it('never imports the bus SDK (@gravadigital/jiku)', () => {
    const offenders = adjuntosFiles
      .filter((file) => file.code.includes('@gravadigital/jiku'))
      .map((f) => f.relativePath);

    expect(offenders).toEqual([]);
  });

  it('never imports #infra/bus/*', () => {
    const offenders = adjuntosFiles
      .filter((file) => file.code.includes('#infra/bus'))
      .map((f) => f.relativePath);

    expect(offenders).toEqual([]);
  });

  it('never calls fetch', () => {
    const offenders = adjuntosFiles
      .filter((file) => /\bfetch\s*\(/.test(file.code))
      .map((f) => f.relativePath);

    expect(offenders).toEqual([]);
  });

  it('never imports the logger (no logging in this story, S-021 adds it)', () => {
    const offenders = adjuntosFiles
      .filter((file) => file.code.includes('#shared/logger'))
      .map((f) => f.relativePath);

    expect(offenders).toEqual([]);
  });
});
