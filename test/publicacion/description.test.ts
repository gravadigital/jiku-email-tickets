import { describe, expect, it } from 'vitest';

import { componerDescripcion } from '#domain/publicacion/description.js';

/**
 * TS-1 a TS-13: composicion deterministica de `description` a partir de los cuatro bloques
 * (cuerpo base, avisos de rechazo, avisos de fallo de subida, placeholders de archivo).
 *
 * Unit tests SIN contenedor, SIN dobles: `componerDescripcion()` es una funcion pura (CA-10),
 * la pieza mas simple de testear de todo `publicacion/` (ver Story Plan S-020, Testing strategy).
 *
 * Los textos de aviso usados aca (p. ej. 'No se acepto virus.exe: extension no permitida') son
 * ejemplos concretos para el test, no el formato final que produce S-021 -- esta funcion no
 * impone ningun formato de texto, solo concatena lo que recibe ya formateado.
 */

describe('componerDescripcion', () => {
  it('composes the four blocks in exact order: body -> rejections -> failures -> placeholders (TS-1)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'No puedo entrar',
      avisosDeRechazo: ['No se acepto virus.exe: extension no permitida'],
      avisosDeFallo: ['No se pudo subir datos.pdf: fallo la subida'],
      placeholders: ['![attach:101]'],
    });

    expect(result).toBe(
      'No puedo entrar\n' +
        'No se acepto virus.exe: extension no permitida\n' +
        'No se pudo subir datos.pdf: fallo la subida\n' +
        '![attach:101]',
    );
  });

  it('returns only the body when there are no rejections, failures, or placeholders (TS-2)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'No puedo entrar',
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: [],
    });

    expect(result).toBe('No puedo entrar');
  });

  it('appends placeholders after the body when there are no notices at all (TS-3)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'No puedo entrar',
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: ['![attach:101]', '[attach:102]'],
    });

    expect(result).toBe('No puedo entrar\n![attach:101]\n[attach:102]');
  });

  it('keeps the empty-body placeholder first, followed by a linked attachment placeholder (TS-4)', () => {
    const result = componerDescripcion({
      cuerpoBase: '(mail sin contenido)',
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: ['![attach:101]'],
    });

    expect(result).toBe('(mail sin contenido)\n![attach:101]');
  });

  it('never leaves the result empty or notice-only when the body is empty and the only attachment is rejected (TS-5)', () => {
    const result = componerDescripcion({
      cuerpoBase: '(mail sin contenido)',
      avisosDeRechazo: ['No se acepto captura.png: tamano excedido'],
      avisosDeFallo: [],
      placeholders: [],
    });

    expect(result).toBe('(mail sin contenido)\nNo se acepto captura.png: tamano excedido');
  });

  it('groups local, core, and cap-exceeded rejections together, never mixed with the failure block (TS-6)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: [
        'No se acepto a.exe: extension no permitida',
        'No se acepto b.zip: rechazado por Jiku',
        'No se adjunto c.png: se excedio el maximo de archivos',
      ],
      avisosDeFallo: ['No se pudo subir d.pdf: fallo la subida'],
      placeholders: [],
    });

    expect(result).toBe(
      'Ticket\n' +
        'No se acepto a.exe: extension no permitida\n' +
        'No se acepto b.zip: rechazado por Jiku\n' +
        'No se adjunto c.png: se excedio el maximo de archivos\n' +
        'No se pudo subir d.pdf: fallo la subida',
    );
  });

  it('preserves the received list order within a block, without reordering (TS-7)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: ['No se acepto primero.exe: ...', 'No se acepto segundo.exe: ...'],
      avisosDeFallo: [],
      placeholders: [],
    });

    expect(result).toBe('Ticket\nNo se acepto primero.exe: ...\nNo se acepto segundo.exe: ...');
  });

  it('preserves image and non-image placeholders in the exact order received (TS-8)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: ['![attach:101]', '[attach:102]', '![attach:103]'],
    });

    expect(result).toBe('Ticket\n![attach:101]\n[attach:102]\n![attach:103]');
  });

  it('produces byte-for-byte identical output for two calls with the same input (TS-9)', () => {
    const input = {
      cuerpoBase: 'Ticket',
      avisosDeRechazo: ['No se acepto a.exe: ...'],
      avisosDeFallo: ['No se pudo subir b.pdf: ...'],
      placeholders: ['![attach:101]'],
    };

    const first = componerDescripcion(input);
    const second = componerDescripcion(input);

    expect(first).toBe(second);
  });

  it('never truncates a 50,000-character body followed by ten placeholders (TS-10)', () => {
    const cuerpoLargo = 'a'.repeat(50_000);
    const placeholders = Array.from({ length: 10 }, (_, i) => `![attach:${100 + i}]`);

    const result = componerDescripcion({
      cuerpoBase: cuerpoLargo,
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders,
    });

    expect(result.startsWith(cuerpoLargo)).toBe(true);
    for (const placeholder of placeholders) {
      expect(result).toContain(placeholder);
    }
    expect(result).toBe(`${cuerpoLargo}\n${placeholders.join('\n')}`);
  });

  it('leaves no dangling separators or empty blocks when notices and placeholders are absent (TS-11)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: [],
      avisosDeFallo: [],
      placeholders: [],
    });

    expect(result).toBe('Ticket');
  });

  it('composes a single rejection notice with no other block besides the body (TS-12)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: ['No se acepto a.exe: extension no permitida'],
      avisosDeFallo: [],
      placeholders: [],
    });

    expect(result).toBe('Ticket\nNo se acepto a.exe: extension no permitida');
  });

  it('composes a single failure notice with no other block besides the body (TS-13)', () => {
    const result = componerDescripcion({
      cuerpoBase: 'Ticket',
      avisosDeRechazo: [],
      avisosDeFallo: ['No se pudo subir b.pdf: fallo la subida'],
      placeholders: [],
    });

    expect(result).toBe('Ticket\nNo se pudo subir b.pdf: fallo la subida');
  });
});
