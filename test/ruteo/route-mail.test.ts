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

/**
 * S-027 — la SEGUNDA SALIDA del ruteo (TS-1 a TS-6, CA-2, CA-3).
 *
 * Hasta S-026 la rama 1 devolvia `{ ok: false, motivo: 'es_respuesta' }` y toda respuesta se
 * descartaba. Desde esta story devuelve una INTENCION de comentario: no es un descarte, no lleva
 * `motivo`, y es el tick —el unico que compone modulos— quien hace el lookup asincrono al KV.
 *
 * `es_respuesta` NO desaparece del catalogo: sigue siendo el motivo del bucket inaccesible, que el
 * tick resuelve despues del lookup. Lo que desaparece es que `routeMail()` lo produzca.
 */
describe('intencion de comentario (S-027)', () => {
  it('TS-1: una respuesta devuelve la intencion de comentario, no un descarte', () => {
    const result = routeMail(
      { referenceIds: ['<abc@cliente.com>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, intencion: 'comentario' });
    // Ni `motivo` ni `slug`: no es un descarte y no hay slug evaluado.
    expect('motivo' in result).toBe(false);
    expect('slug' in result).toBe(false);
  });

  it('TS-2: la rama 1 se sigue evaluando primero — el slug NO se evalua', () => {
    // `recipient` sin subaddress y `ticketMap` vacio: si el orden del arbol se alterara, esto seria
    // `sin_slug`. La consecuencia observable de CA-3 se afirma aca, en la funcion pura.
    const result = routeMail(
      { referenceIds: ['<abc@cliente.com>'], recipient: 'no-hay-slug@grava.io' },
      { ticketMap: new Map(), subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, intencion: 'comentario' });
  });

  it('TS-3: con referenceIds vacio el arbol no cambia en nada', () => {
    const result = routeMail(
      { referenceIds: [], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  it('TS-4: routeMail() sigue siendo SINCRONICA: el retorno no es una Promise', () => {
    const result: unknown = routeMail(
      { referenceIds: ['<abc@cliente.com>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe('undefined');
  });

  it('TS-5: routeMail() sigue sin loguear y sin importar infra ni publicacion', () => {
    // El escaneo va sobre el CODIGO sin comentarios: la cabecera del archivo explica en prosa por
    // que NO hace el lookup, y sin stripear esa explicacion haria fallar su propio test.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/ruteo/route-mail.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    for (const forbidden of ['logger.', 'console.', 'await ', 'lookupThread', '#infra/']) {
      expect(code, `route-mail.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).not.toMatch(/\basync\b/);
  });

  it('TS-6: los otros tres resultados del arbol no cambian', () => {
    expect(
      routeMail({ referenceIds: [], recipient: 'soporte@grava.io' }, { ticketMap, subaddressPrefix }),
    ).toEqual({ ok: false, motivo: 'sin_slug' });

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+beta@grava.io' },
        { ticketMap, subaddressPrefix },
      ),
    ).toEqual({ ok: false, motivo: 'slug_no_mapeado', slug: 'beta' });

    expect(
      routeMail({ referenceIds: [], recipient: 'tickets+alfa@grava.io' }, { ticketMap, subaddressPrefix }),
    ).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  it('referenceIds no vacio basta, sin importar a que apunten las referencias', () => {
    // Antes TS-10: el comportamiento del ARBOL no cambia (la rama 1 no mira las referencias), solo
    // cambia lo que devuelve. Quien decide si el hilo se conoce es el lookup del tick.
    const result = routeMail(
      { referenceIds: ['<random-thread-id@otrodominio.com>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, intencion: 'comentario' });
  });

  it('un reenvio con References poblado sigue entrando por la misma rama', () => {
    // Antes TS-11. El falso positivo del reenvio SIGUE existiendo, pero ya no termina en un
    // descarte automatico: termina en un lookup que no matchea y el tick lo descarta como
    // `hilo_desconocido` (S-026). La decision 9 del PRD quedo derogada por REQ-005.
    const result = routeMail(
      { referenceIds: ['<hilo-interno@grava.io>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, intencion: 'comentario' });
  });

  it('una respuesta a un slug no mapeado tampoco se filtra por slug_no_mapeado', () => {
    // Antes TS-18. El slug no se evalua: la respuesta sale por la intencion, no por el catalogo de
    // descartes.
    const result = routeMail(
      { referenceIds: ['<a@x>'], recipient: 'tickets+beta@grava.io' },
      { ticketMap: new Map([['alfa', 42]]), subaddressPrefix },
    );
    expect(result).toEqual({ ok: false, intencion: 'comentario' });
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

  it('el slug tampoco aparece en la intencion de comentario (S-027)', () => {
    // Antes TS-17 sobre `es_respuesta`. La variante de la intencion no lleva `slug` NI `motivo`:
    // es una tercera forma, no un descarte con otro nombre.
    const result = routeMail(
      { referenceIds: ['<a@x>'], recipient: 'tickets+alfa@grava.io' },
      { ticketMap, subaddressPrefix },
    );
    expect('slug' in result).toBe(false);
    expect('motivo' in result).toBe(false);
  });

  it('MotivoDescarte tiene un unico lugar de definicion con los literales exactos', () => {
    // TS-22 (S-013), ampliado por S-026: el catalogo paso de CINCO a SEIS con `hilo_desconocido`.
    // La afirmacion EXHAUSTIVA del catalogo vive en `test/shared/motivo-descarte.test.ts`; lo que
    // este test sigue protegiendo es que los cinco originales estan y son estos.
    const motivos: MotivoDescarte[] = [
      'no_parseable',
      'sin_message_id',
      'es_respuesta',
      'sin_slug',
      'slug_no_mapeado',
      'hilo_desconocido',
    ];
    expect(motivos).toHaveLength(6);
    expect(new Set(motivos).size).toBe(6);
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
