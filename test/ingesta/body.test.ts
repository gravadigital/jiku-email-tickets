import { describe, expect, it } from 'vitest';

import { toPlainText, trimQuotedText } from '#domain/ingesta/body.js';

describe('toPlainText', () => {
  it('returns the text/plain part when it exists', () => {
    const parsed = { text: 'plano', html: false as const };
    expect(toPlainText(parsed)).toBe('plano');
  });

  it('converts HTML to plain text when there is only HTML, skipping img and href', () => {
    // CA-11
    const parsed = {
      text: '',
      html: '<p>Hola</p><p><img src="logo.png"> mira <a href="http://x">acá</a></p>',
    };
    const result = toPlainText(parsed);
    expect(result).toContain('acá');
    expect(result).not.toContain('http://x');
    expect(result).not.toContain('logo.png');
  });

  it('prefers plain text over HTML when both are present', () => {
    // CA-12
    const parsed = { text: 'texto plano real', html: '<p>version html</p>' };
    expect(toPlainText(parsed)).toBe('texto plano real');
    expect(toPlainText(parsed)).not.toContain('version html');
  });

  it('returns an empty string when there is neither text nor HTML, and this is not an error', () => {
    // CA-13
    const parsed = { text: undefined, html: false as const };
    expect(toPlainText(parsed)).toBe('');
  });
});

describe('trimQuotedText', () => {
  it('cuts at the classic ">" quote marker', () => {
    // TS-28
    expect(trimQuotedText('Se soluciona reiniciando\n> No arranca')).toBe('Se soluciona reiniciando');
  });

  it('cuts at the Spanish "escribió:" separator', () => {
    // TS-29
    expect(trimQuotedText('Nuevo texto\n\nEl lunes escribió:\n> viejo')).toBe('Nuevo texto');
  });

  it('cuts at the English "wrote:" separator', () => {
    // TS-30
    expect(trimQuotedText('New text\n\nOn Monday someone wrote:\n> old')).toBe('New text');
  });

  it('cuts at "-----Original Message-----"', () => {
    // TS-31
    expect(trimQuotedText('Respuesta\n----- Original Message -----\nviejo')).toBe('Respuesta');
  });

  it('cuts at the Outlook underscore separator', () => {
    // TS-32
    expect(trimQuotedText('Respuesta\n________\nFrom: alguien')).toBe('Respuesta');
  });

  it('preserves the whole body when no marker matches (prefer to keep)', () => {
    // TS-33
    expect(trimQuotedText('Se rompe el login\ny no anda nada')).toBe('Se rompe el login\ny no anda nada');
  });

  it('does not cut on a ">" in the middle of a sentence', () => {
    // TS-34
    expect(trimQuotedText('el valor a > b falla')).toBe('el valor a > b falla');
  });

  it('leaves an empty string when the reply was only quoted text', () => {
    // TS-35
    expect(trimQuotedText('> hilo citado\n> línea 2')).toBe('');
  });

  it('never throws, including on an empty string', () => {
    // CA-14/AC-8
    expect(() => trimQuotedText('')).not.toThrow();
    expect(trimQuotedText('')).toBe('');
  });
});
