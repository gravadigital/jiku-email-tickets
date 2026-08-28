import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { routeMail } from '#domain/ruteo/route-mail.js';
import type { MotivoDescarte } from '#shared/motivo-descarte.js';

const ticketMap = new Map([['alfa', 42]]);
const subaddressPrefix = 'tickets';

describe('camino feliz', () => {
  it('resuelve el proyecto cuando el slug esta mapeado y no hay referencias', () => {
    // TS-1
    const result = routeMail({ referenceIds: [], recipient: 'tickets+alfa@grava.io' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  it('no tiene forma de loguear nada: no recibe ni usa ningun logger', () => {
    // TS-2
    expect(routeMail.length).toBe(2);
  });

  it.each([
    // TS-3, TS-4, TS-5: variantes de casing, misma resolucion
    ['Soporte Tickets <TICKETS+Alfa@grava.io>', 'con nombre de display y mayusculas mixtas'],
    ['TICKETS+alfa@grava.io', 'prefijo en mayusculas, slug en minusculas, sin nombre de display'],
    ['tickets+ALFA@grava.io', 'slug en mayusculas, prefijo en minusculas'],
  ])('resuelve alfa->42 sin importar el casing (%s)', (recipient) => {
    const result = routeMail({ referenceIds: [], recipient }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  it('captura el slug entero entre + y @, sin validar forma (puntos y guiones)', () => {
    // TS-6
    const result = routeMail(
      { referenceIds: [], recipient: 'tickets+al.fa-1@grava.io' },
      { ticketMap: new Map([['al.fa-1', 9]]), subaddressPrefix },
    );
    expect(result).toEqual({ ok: true, projectId: 9, slug: 'al.fa-1' });
  });

  it('rutea solo por recipient: pickRecipient ya descarto To/Cc antes de llegar aca', () => {
    // TS-7
    const result = routeMail({ referenceIds: [], recipient: 'tickets+alfa@grava.io' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  it('el prefijo es configurable: un prefijo distinto de tickets matchea igual', () => {
    // TS-19
    const result = routeMail(
      { referenceIds: [], recipient: 'soporte+alfa@grava.io' },
      { ticketMap, subaddressPrefix: 'soporte' },
    );
    expect(result).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });
});

describe('es_respuesta', () => {
  it('descarta por In-Reply-To poblado, sobre slug valido y mapeado', () => {
    // TS-8
    const result = routeMail(
      { referenceIds: ['<abc@grava.io>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'es_respuesta' });
    expect('slug' in result).toBe(false);
  });

  it('descarta antes de tocar el slug: mismo caso que TS-8 pero con recipient que tambien seria sin_slug', () => {
    // TS-9
    const result = routeMail(
      { referenceIds: ['<abc@grava.io>'], recipient: 'soporte@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'es_respuesta' });
  });

  it('referenceIds no vacio basta, sin importar a que apunten las referencias', () => {
    // TS-10
    const result = routeMail(
      { referenceIds: ['<random-thread-id@otrodominio.com>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'es_respuesta' });
  });

  it('falso positivo de reenvio aceptado: References poblado con un pedido nuevo legitimo', () => {
    // TS-11: decision 9 del PRD, G-04 manda degradar hacia el descarte. Comportamiento identico a
    // TS-8/TS-10, documentado como aceptado en route-mail.ts.
    const result = routeMail(
      { referenceIds: ['<hilo-interno@grava.io>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'es_respuesta' });
  });

  it('una respuesta a un slug no mapeado reporta es_respuesta, sin slug (no se filtra por slug_no_mapeado)', () => {
    // TS-18
    const result = routeMail(
      { referenceIds: ['<a@x>'], recipient: 'tickets+beta@grava.io' },
      { ticketMap: new Map([['alfa', 42]]), subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'es_respuesta' });
    expect('slug' in result).toBe(false);
  });
});

describe('sin_slug', () => {
  it('recipient vacio', () => {
    // TS-12
    const result = routeMail({ referenceIds: [], recipient: '' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: false, motivo: 'sin_slug' });
  });

  it('recipient sin forma de subaddress', () => {
    // TS-13
    const result = routeMail({ referenceIds: [], recipient: 'soporte@grava.io' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: false, motivo: 'sin_slug' });
  });

  it('slug vacio entre + y @', () => {
    // TS-14
    const result = routeMail({ referenceIds: [], recipient: 'tickets+@grava.io' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: false, motivo: 'sin_slug' });
  });

  it('nunca lanza, incluso con recipient gravemente malformado', () => {
    // TS-20
    expect(() => routeMail({ referenceIds: [], recipient: '+++@@@' }, { ticketMap, subaddressPrefix })).not.toThrow();
    const result = routeMail({ referenceIds: [], recipient: '+++@@@' }, { ticketMap, subaddressPrefix });
    expect(result).toEqual({ ok: false, motivo: 'sin_slug' });
  });
});

describe('slug_no_mapeado', () => {
  it('slug con forma valida pero ausente del mapa', () => {
    // TS-15
    const result = routeMail(
      { referenceIds: [], recipient: 'tickets+beta@grava.io' },
      { ticketMap: new Map([['alfa', 42]]), subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, motivo: 'slug_no_mapeado', slug: 'beta' });
  });
});

describe('pureza y estructura', () => {
  it('el slug solo aparece en el resultado cuando el motivo es slug_no_mapeado (verificacion sobre sin_slug)', () => {
    // TS-16: 'slug' in result, no result.slug === undefined -- CA-13 exige que la clave NO exista.
    const result = routeMail({ referenceIds: [], recipient: 'tickets+@grava.io' }, { ticketMap, subaddressPrefix });
    expect('slug' in result).toBe(false);
  });

  it('el slug solo aparece en el resultado cuando el motivo es slug_no_mapeado (verificacion sobre es_respuesta)', () => {
    // TS-17
    const result = routeMail(
      { referenceIds: ['<a@x>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect('slug' in result).toBe(false);
  });

  it('MotivoDescarte tiene un unico lugar de definicion con los cinco literales exactos', () => {
    // TS-22
    const motivos: MotivoDescarte[] = [
      'no_parseable',
      'sin_message_id',
      'es_respuesta',
      'sin_slug',
      'slug_no_mapeado',
    ];
    expect(motivos).toHaveLength(5);
    expect(new Set(motivos).size).toBe(5);
  });

  it('extractSenderEmail fue renombrada: headers.ts no exporta ese simbolo', () => {
    // TS-23
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ingesta/headers.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/export function extractSenderEmail/);
    expect(source).toMatch(/export function extractAddress/);
  });

  it('routeMail es sincrona, no devuelve una Promise', () => {
    const result = routeMail({ referenceIds: [], recipient: 'tickets+alfa@grava.io' }, { ticketMap, subaddressPrefix });
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('no importa nada de ingesta salvo headers.js y types.js, ni nada de publicacion', () => {
    // TS-21
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ruteo/route-mail.ts', import.meta.url)),
      'utf8',
    );
    const ingestaImports = [...source.matchAll(/from ['"]#domain\/ingesta\/([^'"]+)['"]/g)].map((m) => m[1]);
    expect(ingestaImports.length).toBeGreaterThan(0);
    expect(ingestaImports.every((path) => path === 'headers.js' || path === 'types.js')).toBe(true);
    expect(source).not.toMatch(/from ['"]#domain\/publicacion/);
  });
});
