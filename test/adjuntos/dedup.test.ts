import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deduplicar } from '#domain/adjuntos/dedup.js';
import type { AdjuntoParticionado } from '#domain/adjuntos/types.js';

function particionado(overrides: Partial<AdjuntoParticionado> = {}): AdjuntoParticionado {
  return {
    filename: 'a.png',
    mimeType: 'image/png',
    content: Buffer.from('contenido'),
    ...overrides,
  };
}

describe('deduplicar', () => {
  // TS-9. El checksum se calcula con node:crypto, sha256, sobre content -- nunca viene del mail.
  it('calculates the sha256 checksum over content with node:crypto', () => {
    const content = Buffer.from('mismo-byte');
    const result = deduplicar([particionado({ filename: 'a.png', content })]);

    const expected = createHash('sha256').update(content).digest('hex');
    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]?.checksum).toBe(expected);
  });

  // TS-10. Dos aceptados con el mismo checksum se colapsan: sobrevive el primero.
  it('collapses two attachments with the same checksum, keeping the first', () => {
    const content = Buffer.from('mismo-byte');
    const result = deduplicar([
      particionado({ filename: 'foto.png', content, mimeType: 'image/png' }),
      particionado({ filename: 'imagen.png', content, mimeType: 'image/png' }),
    ]);

    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]?.filename).toBe('foto.png');
    expect(result.rechazados).toEqual([]);
  });

  // TS-11. El nombre del duplicado descartado no aparece en ninguna estructura de salida.
  it('never mentions the discarded duplicate name anywhere in the output', () => {
    const content = Buffer.from('mismo-byte');
    const result = deduplicar([
      particionado({ filename: 'foto.png', content }),
      particionado({ filename: 'imagen.png', content }),
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('imagen.png');
  });

  // TS-12. mimeType declarado distinto no desempata el dedup: el checksum es sobre el byte.
  it('does not let a different declared mimeType break the collapse', () => {
    const content = Buffer.from('x');
    const result = deduplicar([
      particionado({ filename: 'a.png', mimeType: 'image/png', content }),
      particionado({ filename: 'b.jpg', mimeType: 'image/jpeg', content }),
    ]);

    expect(result.aceptados).toHaveLength(1);
    expect(result.aceptados[0]?.filename).toBe('a.png');
  });

  // TS-13. No hay dedup entre invocaciones: cada llamada es un Set nuevo.
  it('does not deduplicate across separate invocations', () => {
    const content = Buffer.from('mismo-byte');

    const first = deduplicar([particionado({ filename: 'captura.png', content })]);
    const second = deduplicar([particionado({ filename: 'captura.png', content })]);

    expect(first.aceptados).toHaveLength(1);
    expect(second.aceptados).toHaveLength(1);
  });

  // Orden O(n): con muchos duplicados, el resultado observable tiene el numero correcto de
  // checksums unicos, sin verificar el algoritmo internamente.
  it('reduces a large batch to its unique checksums', () => {
    const inputs: AdjuntoParticionado[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const bucket = i % 500;
      inputs.push(particionado({ filename: `f${String(i)}.png`, content: Buffer.from(`v${String(bucket)}`) }));
    }

    const result = deduplicar(inputs);

    expect(result.aceptados).toHaveLength(500);
  });

  // TS-22. Un error inesperado calculando el checksum de un adjunto no aborta el resto.
  it('captures an unexpected checksum error as error_interno without aborting the rest', () => {
    const broken: AdjuntoParticionado = {
      filename: 'roto.png',
      mimeType: 'image/png',
      // Un objeto que no es un Buffer real hace fallar createHash().update() al no exponer los
      // metodos que Hash espera.
      content: { length: 5 } as unknown as Buffer,
    };

    const result = deduplicar([
      particionado({ filename: 'ok1.png', content: Buffer.from('uno') }),
      broken,
      particionado({ filename: 'ok2.png', content: Buffer.from('dos') }),
    ]);

    expect(result.rechazados).toEqual([
      { nombre: 'roto.png', mime: 'image/png', regla: 'error_interno' },
    ]);
    expect(result.aceptados.map((a) => a.filename)).toEqual(['ok1.png', 'ok2.png']);
  });
});
