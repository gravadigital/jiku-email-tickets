import { describe, expect, it } from 'vitest';

import {
  VERIFY_DESCRIPTION,
  VERIFY_TITLE,
  buildVerificationPayload,
} from '#domain/publicacion/verification-payload.js';

/**
 * TS-1 a TS-5: el payload fijo del modo de verificacion.
 *
 * Unit tests SIN contenedor: `buildVerificationPayload()` es una funcion pura y la convencion
 * `testing` es explicita en que los unit tests son solo para funciones puras. Lo que toca el bus
 * esta en publish.test.ts.
 */

describe('buildVerificationPayload', () => {
  // TS-1
  it('carries exactly the six fields of the command contract', () => {
    const payload = buildVerificationPayload(7);

    expect(Object.keys(payload).sort()).toEqual([
      'description',
      'priority',
      'projectId',
      'title',
      'type',
      'visibilityLevel',
    ]);
  });

  // TS-2
  it('carries the three connector defaults', () => {
    const payload = buildVerificationPayload(7);

    expect(payload.type).toBe('incidencia');
    expect(payload.priority).toBe('sin_prioridad');
    expect(payload.visibilityLevel).toBe('public');
  });

  // TS-3
  it('carries none of the four excluded keys', () => {
    const payload = buildVerificationPayload(7);

    // `in` y no `=== undefined`: lo que CA-3 pide es que la clave NO ESTE en el objeto, no que
    // valga undefined. Un `state: undefined` se serializaria fuera del JSON igual, pero dejaria la
    // clave escrita en el codigo — que es justo la señal que hace que el proximo lector la
    // "complete".
    expect('state' in payload).toBe(false);
    expect('actor' in payload).toBe(false);
    expect('fileIds' in payload).toBe(false);
    expect('creator' in payload).toBe(false);
  });

  // TS-4
  it('takes the projectId from its argument rather than a literal', () => {
    const payload = buildVerificationPayload(4242);

    expect(payload.projectId).toBe(4242);
    expect(typeof payload.projectId).toBe('number');
  });

  // TS-5
  it('uses the code literals for title and description, neither of them empty', () => {
    const payload = buildVerificationPayload(7);

    expect(payload.title).toBe(VERIFY_TITLE);
    expect(payload.description).toBe(VERIFY_DESCRIPTION);
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.description.length).toBeGreaterThan(0);
  });

  it('keeps the title within the column limit of Jiku', () => {
    // El titulo es un literal del codigo, asi que su largo es una propiedad del codigo y no de una
    // entrada: si alguien lo alarga a mas de 255, el schema lo rechazaria en runtime y el modo de
    // verificacion fallaria por armado. Mejor que falle aca.
    expect(buildVerificationPayload(7).title.length).toBeLessThanOrEqual(255);
  });

  it('says in its own text that the requirement is a deployment check', () => {
    // El requisito queda PARA SIEMPRE en el proyecto de Jiku (invariante 9, sin compensacion).
    // Quien lo encuentre tiene que reconocerlo sin preguntar.
    expect(VERIFY_TITLE.toLowerCase()).toContain('verificacion');
    expect(VERIFY_DESCRIPTION.toLowerCase()).toContain('verificacion');
  });
});
