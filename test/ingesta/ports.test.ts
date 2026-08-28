import { describe, expect, it } from 'vitest';

import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';

/**
 * TS-1, TS-2: el puerto `MailSource` declara exactamente tres operaciones, y `RawMessage` expone
 * `uid` y `source: Buffer`.
 *
 * Son tests de tipos, no de comportamiento: la interfaz no tiene runtime propio. Se construye un
 * objeto satisfaciendo el tipo (el compilador ya rechaza cualquier metodo de mas o de menos si el
 * objeto no calza exacto contra un tipo con `implements` explicito) y se hacen aserciones sobre las
 * claves presentes en tiempo de ejecucion, que es lo unico verificable en un `it`.
 */

class ExampleMailSource implements MailSource {
  async searchUnseen(): Promise<number[]> {
    return [];
  }

  async fetch(uid: number): Promise<RawMessage> {
    return { uid, source: Buffer.from('') };
  }

  async markSeen(): Promise<void> {
    // no-op de ejemplo
  }
}

describe('MailSource port', () => {
  // TS-1
  it('declares exactly three operations: searchUnseen, fetch, markSeen', () => {
    const instance = new ExampleMailSource();
    const methodNames = Object.getOwnPropertyNames(ExampleMailSource.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methodNames.sort()).toEqual(['fetch', 'markSeen', 'searchUnseen']);
    expect(typeof instance.searchUnseen).toBe('function');
    expect(typeof instance.fetch).toBe('function');
    expect(typeof instance.markSeen).toBe('function');
  });

  // TS-2
  it('RawMessage exposes uid and source as a Buffer', async () => {
    const message: RawMessage = { uid: 42, source: Buffer.from('hello') };

    expect(message.uid).toBe(42);
    expect(Buffer.isBuffer(message.source)).toBe(true);
    expect(message.source.toString()).toBe('hello');
  });
});
