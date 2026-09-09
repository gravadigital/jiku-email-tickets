import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMMENT_FILE_IDS_MAX,
  commentReplySchema,
  commentSchema,
} from '#domain/publicacion/comment.schema.js';

/**
 * TS-7 a TS-19 del Story Plan de S-027: los dos schemas del contrato
 * `requirements.{id}.comment`, con LAS DOS ESTRICTECES OPUESTAS.
 *
 * El payload lo arma el conector y ahi la estrictez protege; la reply la manda `core` y ahi la
 * tolerancia protege. Es el mismo par que `requirement.schema.ts` ya es para el alta, y los tres
 * tests que mas importan son los que es facil no escribir: TS-9/TS-10 (`.strict()` FALLA, no
 * descarta en silencio), TS-11 (`fileIds: []` se rechaza) y TS-17 (la reply tolera un campo nuevo).
 */

const TEXTO = 'texto de la respuesta';

describe('commentSchema — el payload (.strict())', () => {
  // TS-7
  it('TS-7: el payload minimo valido pasa, y sin la clave fileIds', () => {
    const result = commentSchema.safeParse({ comment: TEXTO, visibilityLevel: 'public' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ comment: TEXTO, visibilityLevel: 'public' });
    // La clave AUSENTE es la representacion de "cero adjuntos": el schema no la inventa.
    expect(result.success && 'fileIds' in result.data).toBe(false);
  });

  // TS-8
  it('TS-8: con fileIds valido pasa y los conserva', () => {
    const result = commentSchema.safeParse({
      comment: TEXTO,
      visibilityLevel: 'public',
      fileIds: [7, 8],
    });

    expect(result.success).toBe(true);
    expect(result.data?.fileIds).toEqual([7, 8]);
  });

  // TS-9
  it('TS-9: .strict() — una clave desconocida FALLA, no se descarta en silencio', () => {
    const result = commentSchema.safeParse({
      comment: TEXTO,
      visibilityLevel: 'public',
      actor: 'u-1',
    });

    expect(result.success).toBe(false);
    // El codigo importa: un `z.object` normal habria devuelto `success: true` REMOVIENDO la clave,
    // que es el fallo silencioso que `.strict()` existe para convertir en ruidoso.
    expect(result.error?.issues.map((i) => i.code)).toContain('unrecognized_keys');
  });

  // TS-10
  it('TS-10: author tambien es rechazado por .strict()', () => {
    // `core` resuelve el actor del `sub` del subject (ADR-005) y el conector NO manda `author`. Al
    // no estar en el schema y ser `.strict()`, mandarlo falla — la documentacion EJECUTABLE de CA-4.
    const result = commentSchema.safeParse({
      comment: TEXTO,
      visibilityLevel: 'public',
      author: 'u-1',
    });

    expect(result.success).toBe(false);
  });

  // TS-11
  it('TS-11: fileIds: [] se rechaza — la clave ausente es la representacion de cero', () => {
    const result = commentSchema.safeParse({
      comment: TEXTO,
      visibilityLevel: 'public',
      fileIds: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toContain('too_small');
  });

  // TS-12
  it('TS-12: el tope de 10 esta en el schema', () => {
    const result = commentSchema.safeParse({
      comment: TEXTO,
      visibilityLevel: 'public',
      fileIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.code)).toContain('too_big');
    expect(COMMENT_FILE_IDS_MAX).toBe(10);

    // Exactamente 10 SI pasa: el tope es inclusivo, igual que el `maxItems` del contrato.
    expect(
      commentSchema.safeParse({
        comment: TEXTO,
        visibilityLevel: 'public',
        fileIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      }).success,
    ).toBe(true);
  });

  // TS-13
  it('TS-13: comment vacio se rechaza', () => {
    const result = commentSchema.safeParse({ comment: '', visibilityLevel: 'public' });
    expect(result.success).toBe(false);
  });

  // TS-14
  it('TS-14: visibilityLevel fuera del enum se rechaza', () => {
    expect(commentSchema.safeParse({ comment: TEXTO, visibilityLevel: 'privado' }).success).toBe(
      false,
    );
    // Los dos del contrato SI pasan, para que el test de arriba no pase vacuamente.
    expect(commentSchema.safeParse({ comment: TEXTO, visibilityLevel: 'internal' }).success).toBe(
      true,
    );
  });

  // TS-15
  it('TS-15: el schema NO tiene .default() en visibilityLevel — la politica vive en el armado', () => {
    // Omitir el campo NO produce un payload "valido". Si el schema lo defaulteara, un armador que
    // se olvidara de ponerlo produciria un payload que `core` interpretaria como `internal` —
    // invisible para el cliente en Opus— sin que nada falle. Es el fallo exacto que CA-4 previene.
    const result = commentSchema.safeParse({ comment: TEXTO });
    expect(result.success).toBe(false);
  });

  it('los enteros de fileIds se validan: nada de decimales, cero ni negativos', () => {
    for (const invalido of [[0], [-1], [1.5], ['7']]) {
      expect(
        commentSchema.safeParse({ comment: TEXTO, visibilityLevel: 'public', fileIds: invalido })
          .success,
        `fileIds ${JSON.stringify(invalido)} debe rechazarse`,
      ).toBe(false);
    }
  });
});

describe('commentReplySchema — la reply (SIN .strict())', () => {
  // TS-16
  it('TS-16: la reply valida pasa', () => {
    const result = commentReplySchema.safeParse({ id: 900 });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(900);
  });

  // TS-17
  it('TS-17: sin .strict() — un campo extra de core NO rompe', () => {
    // La razon inversa a la del payload: la respuesta la manda `core`, y un campo nuevo que empiece
    // a enviar manana no debe romper al conector.
    const result = commentReplySchema.safeParse({
      id: 900,
      createdAt: '2026-09-08T10:00:00.000Z',
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(900);
  });

  // TS-18
  it('TS-18: una reply de exito sin id usable es un FALLO — y sin coercion', () => {
    expect(commentReplySchema.safeParse({}).success).toBe(false);
    // `z.number()` y NO `z.coerce.number()`: con coercion, un `id: 'no-es-numero'` pasaria a NaN o a
    // un numero segun el string, y el caso a detectar —`core` contestando con el tipo equivocado—
    // quedaria sin cubrir.
    expect(commentReplySchema.safeParse({ id: 'no-es-numero' }).success).toBe(false);
    expect(commentReplySchema.safeParse({ id: '900' }).success).toBe(false);
    expect(commentReplySchema.safeParse({ id: 0 }).success).toBe(false);
    expect(commentReplySchema.safeParse({ id: 1.5 }).success).toBe(false);
  });
});

describe('comment.types.ts — los tipos se INFIEREN del schema (TS-19)', () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../../src/domain/publicacion/comment.types.ts', import.meta.url)),
    'utf8',
  );
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // TS-19
  it('TS-19: usa z.infer y no declara ningun tipo con los campos escritos a mano', () => {
    expect(code).toMatch(/z\.infer<typeof\s+commentSchema>/);
    expect(code).toMatch(/z\.infer<typeof\s+commentReplySchema>/);

    // Ninguna `interface`, y ningun campo del contrato escrito a mano: dos declaraciones separadas
    // divergen sin que nada falle, y entonces el compilador afirma una forma mientras al bus viaja
    // otra (convencion `validation`).
    expect(code).not.toMatch(/\binterface\b/);
    for (const campo of ['comment', 'visibilityLevel', 'fileIds']) {
      expect(code, `comment.types.ts must not spell out ${campo}`).not.toMatch(
        new RegExp(`\\b${campo}\\s*:`),
      );
    }
  });
});
