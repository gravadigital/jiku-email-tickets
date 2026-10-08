import { createHash } from 'node:crypto';

import { assertValidKVKey } from '@gravadigital/jiku';
import { describe, expect, it } from 'vitest';

import { envSchema } from '#config/schema.js';
import {
  THREADS_KEY_PREFIX,
  TICKETS_KEY_PREFIX,
  isStorableSlug,
  sha256hex,
  threadKey,
  ticketKey,
} from '#infra/kv/keys.js';

import { readSource } from '../../shared/source-scan.js';

/**
 * TS-7 a TS-11 del Story Plan de S-032 (y TS-1 a TS-4 de S-026 sobre `sha256hex()`, que se mudan
 * desde `threads.test.ts` junto con la funcion): el modulo unico de claves del Espacio KV.
 *
 * Es un modulo puro —sin I/O, sin configuracion— asi que no necesita contenedor. Los hashes se
 * calculan en el test con `createHash` propio, NUNCA importando `sha256hex` para verificarse a si
 * mismo.
 */

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function expectedHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('sha256hex — el hash de la clave del Mapa de Hilos', () => {
  // TS-1 (S-026)
  it('TS-1: es el sha256 en hex y coincide con el valor de referencia', () => {
    const messageId = '<abc@cliente.com>';
    expect(sha256hex(messageId)).toBe(expectedHash(messageId));
    expect(sha256hex(messageId)).toBe('7482ad61199c790f5aa60568566e4a3973cc2f5ebabfbe57fd0a279ce7eef47e');
    expect(sha256hex(messageId)).toMatch(/^[0-9a-f]{64}$/);
  });

  // TS-2 (S-026)
  it('TS-2: el hash siempre es una clave valida para el SDK', () => {
    // Las reglas de clave ya no son las de `@nats-io/kv`: son las de `assertValidKVKey()` del SDK
    // (que son las de NATS). `<`, `>` y `@` no son validos; 64 hex lo son por construccion.
    for (const entrada of ['<abc@cliente.com>', '<CAF=+7Kx_9@mail.gmail.com>', '<a<b>c@x>', '<>']) {
      expect(() => {
        assertValidKVKey(sha256hex(entrada));
      }, `${entrada} produjo una clave que el SDK rechazaria`).not.toThrow();
    }
  });

  // TS-3 (S-026)
  it('TS-3: el hash se calcula sobre el Message-Id CRUDO, con brackets', () => {
    expect(sha256hex('<abc@cliente.com>')).not.toBe(sha256hex('abc@cliente.com'));
    expect(sha256hex('<abc@cliente.com>')).toBe(expectedHash('<abc@cliente.com>'));
  });

  // TS-4 (S-026)
  it('TS-4: no hay normalizacion — el caso y los espacios cambian la clave', () => {
    expect(sha256hex('<ABC@cliente.com>')).not.toBe(sha256hex('<abc@cliente.com>'));
    expect(sha256hex(' <abc@cliente.com> ')).not.toBe(sha256hex('<abc@cliente.com>'));
  });
});

describe('ticketKey — la clave del Mapa de Tickets', () => {
  // TS-7
  it('TS-7: agrega el prefijo fijo y nada mas (la parte de la izquierda la pone el SDK)', () => {
    expect(ticketKey('alfa')).toBe('tickets.alfa');
    expect(ticketKey('al.fa-1')).toBe('tickets.al.fa-1');
  });
});

describe('threadKey — la clave del Mapa de Hilos', () => {
  // TS-8
  it('TS-8: es hilos. + el sha256 del Message-Id crudo, sin normalizar (invariante 23)', () => {
    const base = threadKey('<abc@cliente.com>');

    expect(base).toBe('hilos.7482ad61199c790f5aa60568566e4a3973cc2f5ebabfbe57fd0a279ce7eef47e');
    expect(base).toBe(`hilos.${expectedHash('<abc@cliente.com>')}`);
    // Normalizar haria colapsar dos Message-Id distintos en la misma clave y rutearia un comentario
    // al requisito equivocado.
    expect(threadKey('<ABC@cliente.com>')).not.toBe(base);
    expect(threadKey(' <abc@cliente.com> ')).not.toBe(base);
  });

  // TS-11
  it('TS-11: toda clave de hilo es una clave valida del SDK, con un sufijo de 64 hex', () => {
    const entradas = [
      '<abc@cliente.com>',
      '<CAF=+7Kx_9@mail.gmail.com>',
      '<a<b>c@x>',
      '<>',
      'sin-brackets@x.com',
      '<ñ-acentos@cliente.com>',
    ];

    for (const entrada of entradas) {
      const key = threadKey(entrada);
      expect(() => {
        assertValidKVKey(key);
      }, `${entrada} produjo una clave que el SDK rechazaria`).not.toThrow();
      expect(key.slice('hilos.'.length)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('isStorableSlug — si un slug puede ser clave', () => {
  // TS-9
  it('TS-9: sigue las reglas del SDK y nunca lanza', () => {
    for (const slug of ['alfa', 'al.fa-1', 'proyecto_2', 'a=b']) {
      expect(isStorableSlug(slug), `${slug} deberia poder ser clave`).toBe(true);
    }

    // `a+b` no es un slug valido de NATS (`+` no esta en el alfabeto de claves); `..`, un punto en
    // un borde, espacios, `!`, acentos, `>` y `*` tampoco; el vacio tampoco.
    for (const slug of ['a+b', 'al..fa', '.alfa', 'alfa.', 'al fa', 'al!fa', 'álfa', 'a>b', '*', '']) {
      expect(() => isStorableSlug(slug)).not.toThrow();
      expect(isStorableSlug(slug), `${JSON.stringify(slug)} no deberia poder ser clave`).toBe(false);
    }
  });
});

describe('los prefijos son constantes del codigo, no configuracion', () => {
  // TS-10
  it('TS-10: tickets. y hilos. estan fijos, y ninguna variable KV_ los configura', () => {
    // Cambiar un prefijo deja huerfanas TODAS las entradas cargadas. Si fuera una variable de
    // entorno, un typo bastaria para eso: por eso es una constante, y este test lo sostiene.
    expect(TICKETS_KEY_PREFIX).toBe('tickets.');
    expect(THREADS_KEY_PREFIX).toBe('hilos.');
    expect(readSource('infra/kv/keys.ts')).not.toMatch(/from\s*'#config\//);
    expect(Object.keys(envSchema).filter((key) => /^KV_/.test(key))).toEqual([]);
  });
});
