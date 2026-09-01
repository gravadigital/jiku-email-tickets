import { describe, expect, it } from 'vitest';

import { particionar } from '#domain/adjuntos/particionar.js';
import type { MailAttachment } from '#domain/ingesta/types.js';

/** Config minima de politica para los tests: listas blancas explicitas, tamano generoso. */
const CONFIG = {
  allowedExtensions: ['.png', '.pdf'],
  allowedMimeTypes: ['image/png', 'application/pdf'],
  maxSizeBytes: 10_485_760,
};

/** Un MailAttachment valido con overrides puntuales por test. */
function attachment(overrides: Partial<MailAttachment> = {}): MailAttachment {
  return {
    filename: 'archivo.png',
    mimeType: 'image/png',
    size: 100,
    content: Buffer.from('contenido de prueba'),
    contentDisposition: 'attachment',
    ...overrides,
  };
}

describe('particionar', () => {
  // TS-1
  it('accepts an attachment with a whitelisted extension, MIME and size', () => {
    const result = particionar(
      [attachment({ filename: 'captura.png', mimeType: 'image/png', size: 2_000_000, content: Buffer.alloc(2_000_000, 1) })],
      CONFIG,
    );

    expect(result.rechazados).toEqual([]);
    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]).toMatchObject({ filename: 'captura.png', mimeType: 'image/png' });
  });

  // TS-2. El tamano se evalua sobre content.length, NUNCA sobre size declarado.
  it('evaluates size against content.length, never against the declared size', () => {
    const result = particionar(
      [attachment({ filename: 'x.png', mimeType: 'image/png', size: 100, content: Buffer.alloc(15_000_000, 1) })],
      CONFIG,
    );

    expect(result.aceptados).toEqual([]);
    expect(result.rechazados).toEqual([{ nombre: 'x.png', mime: 'image/png', regla: 'tamano' }]);
  });

  // TS-3
  it('rejects an extension outside the whitelist', () => {
    const result = particionar(
      [
        attachment({
          filename: 'virus.exe',
          mimeType: 'application/x-msdownload',
          size: 100,
          content: Buffer.from('MZ'),
        }),
      ],
      CONFIG,
    );

    expect(result.aceptados).toEqual([]);
    expect(result.rechazados).toEqual([
      { nombre: 'virus.exe', mime: 'application/x-msdownload', regla: 'extension' },
    ]);
  });

  // TS-4. MIME fuera de la lista blanca se rechaza aunque la extension sea valida.
  it('rejects a MIME type outside the whitelist even with a valid extension', () => {
    const result = particionar(
      [
        attachment({
          filename: 'foto.png',
          mimeType: 'application/octet-stream',
          size: 100,
          content: Buffer.from('x'),
        }),
      ],
      CONFIG,
    );

    expect(result.aceptados).toEqual([]);
    expect(result.rechazados).toEqual([
      { nombre: 'foto.png', mime: 'application/octet-stream', regla: 'mime' },
    ]);
  });

  // TS-5. El rechazo por 0 bytes es incondicional: listas blancas vacias no cambian el resultado.
  it('rejects a 0-byte attachment unconditionally, even with empty allow-lists', () => {
    const result = particionar(
      [
        attachment({
          filename: 'vacio.exe',
          mimeType: 'application/x-msdownload',
          size: 0,
          content: Buffer.alloc(0),
        }),
      ],
      { allowedExtensions: [], allowedMimeTypes: [], maxSizeBytes: 10_485_760 },
    );

    expect(result.aceptados).toEqual([]);
    expect(result.rechazados).toEqual([
      { nombre: 'vacio.exe', mime: 'application/x-msdownload', regla: 'tamano_cero' },
    ]);
  });

  // TS-6. Sin filename, se genera un nombre a partir de la posicion (1-indexed) y la extension del
  // mimeType declarado, y ESE nombre generado es el que se evalua contra la lista blanca.
  it('generates a name from position and mimeType when filename is missing, before evaluating the extension', () => {
    const result = particionar(
      [attachment({ filename: '', mimeType: 'image/png', size: 100, content: Buffer.from('x') })],
      CONFIG,
    );

    expect(result.rechazados).toEqual([]);
    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]?.filename).toBe('adjunto-1.png');
  });

  // TS-7. Sin mimeType, se trata como application/octet-stream, sin ninguna inferencia.
  it('treats a missing mimeType as application/octet-stream, without inference', () => {
    const result = particionar(
      [attachment({ filename: 'datos', mimeType: '', size: 100, content: Buffer.from('x') })],
      CONFIG,
    );

    expect(result.aceptados).toEqual([]);
    expect(result.rechazados).toEqual([
      { nombre: 'datos', mime: 'application/octet-stream', regla: 'mime' },
    ]);
  });

  // TS-8. Cada rechazo produce EXACTAMENTE { nombre, mime, regla }, sin campos adicionales.
  it('produces exactly { nombre, mime, regla } on rejection, with no extra fields', () => {
    const result = particionar(
      [attachment({ filename: 'virus.exe', mimeType: 'application/x-msdownload' })],
      CONFIG,
    );

    expect(result.rechazados).toHaveLength(1);
    expect(Object.keys(result.rechazados[0] ?? {}).sort()).toEqual(['mime', 'nombre', 'regla']);
  });

  // AC-7: orden de evaluacion. Un adjunto que falla extension Y mime anota solo la primera regla.
  it('anota solo la primera regla cuando extension y mime fallan a la vez', () => {
    const result = particionar(
      [
        attachment({
          filename: 'virus.exe',
          mimeType: 'application/x-msdownload',
          size: 100,
          content: Buffer.from('MZ'),
        }),
      ],
      CONFIG,
    );

    expect(result.rechazados).toEqual([
      { nombre: 'virus.exe', mime: 'application/x-msdownload', regla: 'extension' },
    ]);
  });

  // AC-3: tamano_cero gana sobre extension y mime tambien invalidos.
  it('el rechazo por 0 bytes gana incluso con extension y mime tambien invalidos', () => {
    const result = particionar(
      [attachment({ filename: 'vacio.exe', mimeType: 'application/x-msdownload', size: 0, content: Buffer.alloc(0) })],
      CONFIG,
    );

    expect(result.rechazados).toEqual([
      { nombre: 'vacio.exe', mime: 'application/x-msdownload', regla: 'tamano_cero' },
    ]);
  });

  // AC-8: un error inesperado en un adjunto no aborta el resto.
  it('captures an unexpected error on one attachment as error_interno without aborting the rest', () => {
    const broken: MailAttachment = {
      // Un getter que lanza simula un fallo inesperado al leer `content.length`.
      get filename(): string {
        throw new Error('boom');
      },
      mimeType: 'image/png',
      size: 100,
      content: Buffer.from('x'),
      contentDisposition: 'attachment',
    };

    const result = particionar([broken, attachment({ filename: 'ok.png' })], CONFIG);

    expect(result.rechazados.some((r) => r.regla === 'error_interno')).toBe(true);
    expect(result.aceptados.some((a) => a.filename === 'ok.png')).toBe(true);
  });

  // Extension case-insensitive: un .PNG no se rechaza por casing.
  it('compares the extension case-insensitively', () => {
    const result = particionar([attachment({ filename: 'FOTO.PNG' })], CONFIG);

    expect(result.rechazados).toEqual([]);
    expect(result.aceptados).toHaveLength(1);
  });
});
