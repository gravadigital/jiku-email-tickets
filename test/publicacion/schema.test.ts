import { describe, expect, it } from 'vitest';

import {
  TITLE_MAX_LENGTH,
  newRequirementReplySchema,
  newRequirementSchema,
} from '#domain/publicacion/requirement.schema.js';
import {
  RequirementValidationError,
  buildVerificationPayload,
  parseNewRequirement,
} from '#domain/publicacion/verification-payload.js';

/**
 * TS-6 a TS-10: el schema del contrato de `requirements.new`.
 *
 * Unit tests sin contenedor: el schema es una funcion pura sobre un objeto.
 */

const VALID = buildVerificationPayload(7);

describe('newRequirementSchema', () => {
  // TS-6
  it('accepts the fixed verification payload', () => {
    expect(newRequirementSchema.safeParse(VALID).success).toBe(true);
  });

  // TS-7
  it('rejects a title of 256 characters', () => {
    const result = newRequirementSchema.safeParse({ ...VALID, title: 'x'.repeat(256) });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['title']);
  });

  // TS-8
  it('accepts a title of exactly 255 characters', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, title: 'x'.repeat(255) }).success).toBe(true);
    // El limite del schema y la constante son el mismo numero, y la constante es la que FG-3 va a
    // usar para truncar: si divergen, FG-3 truncaria a un largo que el schema rechaza.
    expect(TITLE_MAX_LENGTH).toBe(255);
  });

  it('rejects an empty title and an empty description', () => {
    // ADR-003: `title` y `description` MUST NOT quedar vacios. En esta story son literales, pero la
    // guarda es del schema y vale para FG-3, donde salen del mail.
    expect(newRequirementSchema.safeParse({ ...VALID, title: '' }).success).toBe(false);
    expect(newRequirementSchema.safeParse({ ...VALID, description: '' }).success).toBe(false);
  });

  // TS-9
  it('rejects a projectId that is not a positive integer', () => {
    for (const projectId of [0, -1, 1.5]) {
      expect(
        newRequirementSchema.safeParse({ ...VALID, projectId }).success,
        `projectId ${projectId} must be rejected`,
      ).toBe(false);
    }
  });

  // TS-10
  it('rejects a type outside the contract enum', () => {
    const result = newRequirementSchema.safeParse({ ...VALID, type: 'bug' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['type']);
  });

  it('rejects a priority and a visibilityLevel outside the contract enums', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, priority: 'critica' }).success).toBe(false);
    expect(newRequirementSchema.safeParse({ ...VALID, visibilityLevel: 'private' }).success).toBe(false);
  });

  it('rejects the actor key instead of silently dropping it', () => {
    // Es el punto del `.strict()`. Un `z.object` normal lo removeria en silencio y el schema
    // dejaria de documentar la exclusion mas importante de las cuatro (invariante 18).
    const result = newRequirementSchema.safeParse({ ...VALID, actor: 'alguien' });

    expect(result.success).toBe(false);
  });

  it('rejects state as an unknown key', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, state: 'analisis' }).success).toBe(false);
  });

  // S-021: fileIds pasa de clave desconocida (rechazada por .strict()) a campo declarado y
  // opcional. Los casos de valided/invalidez del propio campo se cubren en el describe de abajo.
  it('accepts fileIds as a declared field now, unlike state/actor', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, fileIds: [1] }).success).toBe(true);
  });

  // S-021, Task 1: fileIds con 1, 5, 10 elementos -> valido.
  it.each([1, 5, 10])('accepts fileIds with %i elements', (count) => {
    const fileIds = Array.from({ length: count }, (_, i) => i + 1);

    expect(newRequirementSchema.safeParse({ ...VALID, fileIds }).success).toBe(true);
  });

  // S-021, Task 1, AC-4: fileIds: [] (array vacio) es RECHAZADO -- la ausencia de adjuntos
  // vinculados se modela con la CLAVE ausente, nunca con un array vacio.
  it('rejects fileIds as an empty array', () => {
    const result = newRequirementSchema.safeParse({ ...VALID, fileIds: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fileIds']);
  });

  // S-021, Task 1, AC-5: fileIds con 11 elementos es RECHAZADO (.max(10), el maxItems del contrato).
  it('rejects fileIds with 11 elements', () => {
    const fileIds = Array.from({ length: 11 }, (_, i) => i + 1);

    expect(newRequirementSchema.safeParse({ ...VALID, fileIds }).success).toBe(false);
  });

  // S-021, Task 1, AC-6: fileIds ausente sigue siendo valido -- retro-compatibilidad con el modo de
  // verificacion y con mails sin adjuntos.
  it('still accepts a payload with no fileIds at all', () => {
    expect('fileIds' in VALID).toBe(false);
    expect(newRequirementSchema.safeParse(VALID).success).toBe(true);
  });

  it('rejects fileIds with a non-positive or non-integer element', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, fileIds: [0] }).success).toBe(false);
    expect(newRequirementSchema.safeParse({ ...VALID, fileIds: [-1] }).success).toBe(false);
    expect(newRequirementSchema.safeParse({ ...VALID, fileIds: [1.5] }).success).toBe(false);
  });

  it('produces no valid payload out of an empty object', () => {
    // La consecuencia de no poner `.default()` en los enums: el schema modela el contrato de
    // `core`, no la politica del conector. Con defaults, esto pasaria.
    expect(newRequirementSchema.safeParse({}).success).toBe(false);
  });

  // CA-3: `creator` se agrega como z.string().min(1) opcional, resto del contrato identico.
  it('accepts a payload with creator added', () => {
    const result = newRequirementSchema.safeParse({ ...VALID, creator: 'user-123' });

    expect(result.success).toBe(true);
    expect(result.data?.creator).toBe('user-123');
  });

  it('still accepts a payload with no creator at all', () => {
    // Necesario para que buildVerificationPayload() (que no lo incluye) siga validando.
    expect('creator' in VALID).toBe(false);
    expect(newRequirementSchema.safeParse(VALID).success).toBe(true);
  });

  it('rejects an empty string as creator', () => {
    expect(newRequirementSchema.safeParse({ ...VALID, creator: '' }).success).toBe(false);
  });
});

describe('parseNewRequirement', () => {
  it('returns the parsed payload when it is valid', () => {
    expect(parseNewRequirement(VALID)).toEqual(VALID);
  });

  it('throws a domain error naming the invalid field paths', () => {
    try {
      parseNewRequirement({ ...VALID, title: '' });
      expect.unreachable('parseNewRequirement must throw on an invalid payload');
    } catch (error) {
      expect(error).toBeInstanceOf(RequirementValidationError);
      expect((error as RequirementValidationError).code).toBe('REQUIREMENT_VALIDATION_ERROR');
      expect((error as RequirementValidationError).invalidFields).toContain('title');
    }
  });

  it('never carries the rejected values, only their paths', () => {
    // En FG-3 esos valores son contenido del mail, y `title`/`description` NO estan en
    // REDACT_PATHS. La regla se establece aca, cuando es gratis.
    const secret = 'dato-de-cliente-que-no-debe-salir';

    try {
      parseNewRequirement({ ...VALID, type: secret });
      expect.unreachable('parseNewRequirement must throw on an invalid payload');
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as Error).message,
        details: (error as RequirementValidationError).details,
      });
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('newRequirementReplySchema', () => {
  it('accepts a success reply carrying a positive integer id', () => {
    expect(newRequirementReplySchema.safeParse({ id: 42 }).success).toBe(true);
  });

  it('rejects a success reply with no id at all', () => {
    // H6: `command<T>()` devuelve `reply.data` sin validarlo, asi que sin este schema esto
    // produciria `requirementId: undefined` en la linea de exito, sin fallar.
    expect(newRequirementReplySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an id that is not a number, without coercing it', () => {
    // `z.coerce.number()` dejaria pasar `'42'` y convertiria `'no-es-numero'` en NaN. El caso que
    // hay que detectar es `core` contestando con el tipo equivocado.
    expect(newRequirementReplySchema.safeParse({ id: 'no-es-numero' }).success).toBe(false);
    expect(newRequirementReplySchema.safeParse({ id: '42' }).success).toBe(false);
  });

  it('tolerates extra fields core might start sending', () => {
    // Inversa deliberada del `.strict()` del payload: el payload lo arma el conector (la estrictez
    // protege), la respuesta la recibe (la tolerancia protege).
    expect(newRequirementReplySchema.safeParse({ id: 42, createdAt: 'hoy' }).success).toBe(true);
  });
});
