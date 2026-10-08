import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { MotivoDescarte, RouteResult } from '#shared/motivo-descarte.js';

/**
 * TS-17 y TS-18 del Story Plan de S-026, y TS-48/TS-49 de S-032: el catalogo cerrado de motivos de
 * descarte y las formas de `RouteResult`.
 *
 * El literal es lo que se loguea TAL CUAL (ADR-006), asi que dos cosas hay que afirmar y no una:
 * que la union tiene exactamente sus miembros (SIETE desde S-032), y que cada literal nuevo esta
 * escrito EXACTAMENTE como se va a leer en el log. Un `hiloDesconocido` o un `slugNoConsultable`
 * compilarian igual de bien y romperian todo grep sobre los logs de produccion.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/motivo-descarte.ts', import.meta.url)),
  'utf8',
);

describe('MotivoDescarte — el catalogo cerrado (S-026, S-032)', () => {
  // TS-17 (S-026), TS-48 (S-032)
  it('TS-17 / TS-48: la union tiene EXACTAMENTE los siete literales, es_respuesta incluido', () => {
    const todos: MotivoDescarte[] = [
      'no_parseable',
      'sin_message_id',
      'es_respuesta',
      'sin_slug',
      'slug_no_mapeado',
      'hilo_desconocido',
      'slug_no_consultable',
    ];

    expect(new Set(todos).size).toBe(7);
    // `es_respuesta` SE CONSERVA: no se reemplaza por `hilo_desconocido` ni se depreca. Cubre "no
    // pude averiguar a que hilo apunta", que es una situacion distinta.
    expect(todos).toContain('es_respuesta');

    // Y la union es CERRADA: un literal inventado no compila.
    // @ts-expect-error un motivo fuera del catalogo no es asignable
    const invalido: MotivoDescarte = 'motivo_inventado';
    expect(invalido).toBe('motivo_inventado');

    // La intencion de alta NO es un motivo de descarte (TS-48).
    // @ts-expect-error 'alta' es una intencion, no un motivo
    const alta: MotivoDescarte = 'alta';
    expect(alta).toBe('alta');
  });

  it('TS-17b / TS-48: la union del archivo declara los siete miembros y ninguno mas', () => {
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
        'slug_no_consultable',
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

  // TS-48 (S-032)
  it('TS-48: slug_no_consultable es exacto, y su distincion frente a slug_no_mapeado esta documentada', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(code).toContain("'slug_no_consultable'");
    expect(code).not.toContain('slugNoConsultable');
    expect(code).not.toContain('SLUG_NO_CONSULTABLE');

    // La distincion vive en el COMENTARIO del tipo: "cargar el slug" contra "arreglar el KV".
    expect(SOURCE).toMatch(/cargar el slug/i);
    expect(SOURCE).toMatch(/arreglar el KV/i);
  });

  it('sigue siendo una union de string literals, nunca un enum', () => {
    // Un `enum` (numerico, o con valores PascalCase) romperia la igualdad literal que ADR-006 pide.
    expect(SOURCE).not.toMatch(/\benum\s+MotivoDescarte\b/);
    expect(SOURCE).toMatch(/export type MotivoDescarte\s*=/);
  });
});

/**
 * S-027: `RouteResult` gana una TERCERA forma — la intencion de comentario.
 *
 * No es un `MotivoDescarte` nuevo y no debe serlo: una intencion de comentario NO es un descarte, y
 * meterla en ese catalogo la haria loguearse como motivo, que es justo lo que deja de pasar.
 */
describe('RouteResult — las intenciones de alta (S-032) y de comentario (S-027)', () => {
  // TS-49
  it('TS-49: las tres variantes son asignables y discriminables sin castear; la resuelta ya no existe', () => {
    const alta: RouteResult = { ok: false, intencion: 'alta', slug: 'alfa' };
    const comentario: RouteResult = { ok: false, intencion: 'comentario' };
    const descarte: RouteResult = { ok: false, motivo: 'sin_slug' };

    // @ts-expect-error desde S-032 routeMail() no resuelve el proyecto: lo resuelve lookupTicket()
    const resuelto: RouteResult = { ok: true, projectId: 42, slug: 'alfa' };
    expect(resuelto.ok).toBe(true);

    // El estrechamiento que el tick usa: la presencia de `intencion` y su valor. Sin discriminar,
    // ni `route.slug` de la alta ni `route.motivo` compilan — que es deseable: es el typechecker
    // obligando a decidir que hacer con cada forma.
    for (const result of [alta, comentario, descarte]) {
      if ('intencion' in result && result.intencion === 'alta') {
        expect(result.slug).toBe('alfa');
      } else if ('intencion' in result) {
        expect(result.intencion).toBe('comentario');
      } else {
        expect(result.motivo).toBe('sin_slug');
      }
    }
  });

  it('la intencion NO lleva motivo: no es un descarte', () => {
    const comentario: RouteResult = { ok: false, intencion: 'comentario' };
    expect('motivo' in comentario).toBe(false);
    expect('slug' in comentario).toBe(false);
  });

  it("'comentario' no es un MotivoDescarte: el catalogo de descartes no lo incorpora", () => {
    // @ts-expect-error la intencion no pertenece al catalogo de motivos de descarte
    const invalido: MotivoDescarte = 'comentario';
    expect(invalido).toBe('comentario');
  });

  it('la union del archivo declara EXACTAMENTE tres variantes de RouteResult', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // El `;` de cierre es el que termina la SENTENCIA, al final de linea: un `;$` sin `m` o un
    // `;` a secas cortaria en el primer separador de campo de la primera variante.
    const declaracion = /export type RouteResult =([\s\S]*?);\s*$/m.exec(code)?.[1] ?? '';
    // Tres ramas separadas por `|` de nivel superior; cada una abre con `{ readonly ok:`.
    expect([...declaracion.matchAll(/readonly ok:/g)]).toHaveLength(3);
    expect(declaracion).toContain("intencion: 'comentario'");
    expect(declaracion).toContain("intencion: 'alta'");
    expect(declaracion).not.toMatch(/ok:\s*true/);
  });
});
