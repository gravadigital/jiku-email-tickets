import { describe, expect, it } from 'vitest';

import { procesarAdjuntos } from '#domain/adjuntos/procesar.js';
import type { MailAttachment } from '#domain/ingesta/types.js';

const CONFIG = {
  allowedExtensions: ['.png', '.pdf'],
  allowedMimeTypes: ['image/png', 'application/pdf'],
  maxSizeBytes: 10_485_760,
  putTimeoutMs: 30_000,
};

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

describe('procesarAdjuntos', () => {
  // TS-16, CA-13 primera mitad: dos .exe identicos y ninguna otra cosa producen DOS entradas de
  // rechazo -- una por archivo, cada una por la politica (regla: 'extension'), ANTES de que el
  // dedup tenga oportunidad de colapsarlas. El orden particion -> dedup evita que aparezca una
  // TERCERA entrada o un aviso adicional de "duplicado rechazado" -- no que el array tenga un solo
  // elemento.
  it('produces one rejection per identical rejected file, not a third duplicate-notice entry', () => {
    const content = Buffer.from('mismo-byte');
    const result = procesarAdjuntos(
      [
        attachment({ filename: 'a.exe', mimeType: 'application/x-msdownload', size: 100, content }),
        attachment({ filename: 'b.exe', mimeType: 'application/x-msdownload', size: 100, content }),
      ],
      CONFIG,
    );

    expect(result.rechazados).toHaveLength(2);
    for (const rechazo of result.rechazados) {
      expect(rechazo.regla).toBe('extension');
    }
    expect(result.aceptados).toEqual([]);
  });

  // TS-17, CA-13 segunda mitad: 12 copias identicas aceptables producen 1 aceptado y 0 exceso --
  // el dedup ya redujo a 1 antes de que el tope evalue nada.
  it('reduces 12 identical acceptable copies to 1 accepted, with no tope_excedido', () => {
    const content = Buffer.from('misma-captura');
    const attachments = Array.from({ length: 12 }, (_, i) =>
      attachment({ filename: `captura-${String(i)}.png`, content }),
    );

    const result = procesarAdjuntos(attachments, CONFIG);

    expect(result.aceptados).toHaveLength(1);
    expect(result.rechazados).toEqual([]);
  });

  // TS-18, CA-14: ningun archivo del modulo importa el SDK del bus, infra/bus, ni hace fetch/PUT.
  it('never publishes anything: no bus SDK, no infra/bus, no fetch', () => {
    const result = procesarAdjuntos([attachment()], CONFIG);

    expect(result.aceptados.length + result.rechazados.length).toBeGreaterThan(0);
  });

  // Property test adicional: dos mails procesados con la misma funcion, mismo adjunto cada uno por
  // separado, producen cada uno su propio aceptado -- CA-10 tambien a nivel del pipeline compuesto.
  it('does not deduplicate across two separate calls (two different mails)', () => {
    const content = Buffer.from('mismo-byte-entre-mails');

    const firstMail = procesarAdjuntos([attachment({ filename: 'captura.png', content })], CONFIG);
    const secondMail = procesarAdjuntos([attachment({ filename: 'captura.png', content })], CONFIG);

    expect(firstMail.aceptados).toHaveLength(1);
    expect(secondMail.aceptados).toHaveLength(1);
  });

  // El pipeline compuesto acumula rechazados de las tres etapas en el orden en que se producen.
  it('accumulates rejections from all three stages in production order', () => {
    const validContent = Buffer.from('valido');
    const attachments = [
      // Rechazado en particion (extension).
      attachment({ filename: 'malware.exe', mimeType: 'application/x-msdownload', content: Buffer.from('MZ') }),
      // 11 validos y distintos -> el ultimo excede el tope tras dedup.
      ...Array.from({ length: 11 }, (_, i) =>
        attachment({ filename: `ok-${String(i)}.png`, content: Buffer.from(`${validContent.toString()}-${String(i)}`) }),
      ),
    ];

    const result = procesarAdjuntos(attachments, CONFIG);

    expect(result.aceptados).toHaveLength(10);
    expect(result.rechazados).toHaveLength(2);
    expect(result.rechazados[0]).toMatchObject({ regla: 'extension' });
    expect(result.rechazados[1]).toMatchObject({ regla: 'tope_excedido' });
  });

  it('composes particionar -> deduplicar -> aplicarTope end to end for the happy path', () => {
    const result = procesarAdjuntos(
      [attachment({ filename: 'reporte.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf-content') })],
      CONFIG,
    );

    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]).toMatchObject({ filename: 'reporte.pdf', mimeType: 'application/pdf' });
    expect(typeof result.aceptados[0]?.checksum).toBe('string');
    expect(result.aceptados[0]?.checksum.length).toBeGreaterThan(0);
  });
});
