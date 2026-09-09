import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { MotivoDescarte } from '#shared/motivo-descarte.js';

/**
 * TS-17 y TS-18 del Story Plan de S-026: el catalogo cerrado de motivos de descarte.
 *
 * El literal es lo que se loguea TAL CUAL (ADR-006), asi que dos cosas hay que afirmar y no una:
 * que la union tiene exactamente los seis miembros, y que el sexto esta escrito EXACTAMENTE como se
 * va a leer en el log. Un `hiloDesconocido` compilaria igual de bien y romperia todo grep sobre los
 * logs de produccion.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/motivo-descarte.ts', import.meta.url)),
  'utf8',
);

describe('MotivoDescarte — el catalogo cerrado (S-026)', () => {
  // TS-17
  it('TS-17: la union tiene EXACTAMENTE los seis literales, es_respuesta incluido', () => {
    const todos: MotivoDescarte[] = [
      'no_parseable',
      'sin_message_id',
      'es_respuesta',
      'sin_slug',
      'slug_no_mapeado',
      'hilo_desconocido',
    ];

    expect(new Set(todos).size).toBe(6);
    // `es_respuesta` SE CONSERVA: no se reemplaza por `hilo_desconocido` ni se depreca. Cubre "no
    // pude averiguar a que hilo apunta", que es una situacion distinta.
    expect(todos).toContain('es_respuesta');

    // Y la union es CERRADA: un literal inventado no compila.
    // @ts-expect-error un motivo fuera del catalogo no es asignable
    const invalido: MotivoDescarte = 'motivo_inventado';
    expect(invalido).toBe('motivo_inventado');
  });

  it('TS-17b: la union del archivo declara los seis miembros y ninguno mas', () => {
    // La declaracion del tipo, sin comentarios (los comentarios del archivo nombran los literales
    // justamente para explicar la desviacion de ADR-006).
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const declaracion = /export type MotivoDescarte =([\s\S]*?);/.exec(code)?.[1] ?? '';
    const literales = [...declaracion.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    expect(literales.sort()).toEqual(
      [
        'es_respuesta',
        'hilo_desconocido',
        'no_parseable',
        'sin_message_id',
        'sin_slug',
        'slug_no_mapeado',
      ].sort(),
    );
  });

  // TS-18
  it('TS-18: el literal nuevo es exacto y en minuscula con guion bajo', () => {
    // Se escanea el CODIGO, con los comentarios stripeados: el docstring del archivo explica la
    // distincion en prosa ("esta respuesta apunta a un hilo que no conozco"), y sin stripear esa
    // explicacion haria fallar su propio test.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(code).toContain("'hilo_desconocido'");
    // Ninguna variante: el literal es lo que se loguea, y un grep sobre produccion busca este.
    expect(code).not.toContain('hiloDesconocido');
    expect(code).not.toContain('HILO_DESCONOCIDO');
    expect(code).not.toContain('hilo desconocido');
    expect(code).not.toContain('hilo-desconocido');
  });

  it('sigue siendo una union de string literals, nunca un enum', () => {
    // Un `enum` (numerico, o con valores PascalCase) romperia la igualdad literal que ADR-006 pide.
    expect(SOURCE).not.toMatch(/\benum\s+MotivoDescarte\b/);
    expect(SOURCE).toMatch(/export type MotivoDescarte\s*=/);
  });
});
