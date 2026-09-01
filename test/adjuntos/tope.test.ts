import { describe, expect, it } from 'vitest';

import { readSource } from '../shared/source-scan.js';

import { aplicarTope } from '#domain/adjuntos/tope.js';
import type { AdjuntoAceptado } from '#domain/adjuntos/types.js';
import { MAX_ATTACHMENTS_PER_REQUIREMENT } from '#config/schema.js';

function aceptado(n: number): AdjuntoAceptado {
  return {
    filename: `a${String(n)}.png`,
    mimeType: 'image/png',
    content: Buffer.from(`contenido-${String(n)}`),
    checksum: `checksum-${String(n)}`,
  };
}

describe('aplicarTope', () => {
  it('exposes the fixed cap as 10', () => {
    expect(MAX_ATTACHMENTS_PER_REQUIREMENT).toBe(10);
  });

  // TS-14. Los primeros 10 en orden pasan; el resto va a rechazados con tope_excedido.
  it('keeps the first 10 in order and rejects the rest with tope_excedido', () => {
    const input = Array.from({ length: 15 }, (_, i) => aceptado(i + 1));

    const result = aplicarTope(input);

    expect(result.aceptados).toHaveLength(10);
    expect(result.aceptados.map((a) => a.filename)).toEqual([
      'a1.png', 'a2.png', 'a3.png', 'a4.png', 'a5.png',
      'a6.png', 'a7.png', 'a8.png', 'a9.png', 'a10.png',
    ]);
    expect(result.rechazados).toHaveLength(5);
    for (const rechazo of result.rechazados) {
      expect(rechazo.regla).toBe('tope_excedido');
    }
    expect(result.rechazados.map((r) => r.nombre)).toEqual([
      'a11.png', 'a12.png', 'a13.png', 'a14.png', 'a15.png',
    ]);
  });

  it('passes everything through with exactly 10 accepted, no rejection', () => {
    const input = Array.from({ length: 10 }, (_, i) => aceptado(i + 1));

    const result = aplicarTope(input);

    expect(result.aceptados).toHaveLength(10);
    expect(result.rechazados).toEqual([]);
  });

  it('passes everything through with fewer than 10 accepted', () => {
    const input = Array.from({ length: 3 }, (_, i) => aceptado(i + 1));

    const result = aplicarTope(input);

    expect(result.aceptados).toHaveLength(3);
    expect(result.rechazados).toEqual([]);
  });

  it('with exactly 11, rejects exactly one with tope_excedido', () => {
    const input = Array.from({ length: 11 }, (_, i) => aceptado(i + 1));

    const result = aplicarTope(input);

    expect(result.aceptados).toHaveLength(10);
    expect(result.rechazados).toHaveLength(1);
    expect(result.rechazados[0]).toMatchObject({ nombre: 'a11.png', regla: 'tope_excedido' });
  });

  // TS-15. El 10 esta fijo en codigo: aplicarTope() importa MAX_ATTACHMENTS_PER_REQUIREMENT y no
  // recibe ningun parametro de configuracion.
  it('imports the fixed constant instead of hardcoding 10 or reading it from config', () => {
    const code = readSource('domain/adjuntos/tope.ts');

    expect(code).toMatch(/MAX_ATTACHMENTS_PER_REQUIREMENT/);
    expect(code).not.toMatch(/\b10\b/);
  });
});
