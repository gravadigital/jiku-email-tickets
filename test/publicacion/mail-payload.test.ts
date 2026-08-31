import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TITLE_MAX_LENGTH, newRequirementSchema } from '#domain/publicacion/requirement.schema.js';
import { buildRequirementPayload } from '#domain/publicacion/mail-payload.js';
import {
  RequirementValidationError,
  buildVerificationPayload,
  parseNewRequirement,
} from '#domain/publicacion/verification-payload.js';

/**
 * TS-1 a TS-10 (parcial), TS-22: el payload derivado del mail.
 *
 * Unit tests SIN contenedor: `buildRequirementPayload()` es una funcion pura, mismo criterio que
 * `payload.test.ts` para `buildVerificationPayload()`. Lo que toca el bus esta en
 * `publish-from-mail.test.ts`.
 */

const RUTEO_CONFIG = {
  placeholderTitle: 'Ticket recibido por mail',
  placeholderBody: '(mail sin contenido)',
};

function mail(overrides: Partial<{ subject: string; body: string }> = {}) {
  return {
    subject: 'Falla en el login',
    body: 'No puedo entrar',
    ...overrides,
  };
}

describe('buildRequirementPayload', () => {
  // TS-1
  it('arma los 7 campos con creator', () => {
    const payload = buildRequirementPayload(mail(), 42, 'test-machine-user', RUTEO_CONFIG);

    expect(payload).toEqual({
      title: 'Falla en el login',
      description: 'No puedo entrar',
      projectId: 42,
      type: 'incidencia',
      priority: 'sin_prioridad',
      visibilityLevel: 'public',
      creator: 'test-machine-user',
    });
  });

  // TS-2
  it('no lleva state, actor ni fileIds', () => {
    const payload = buildRequirementPayload(mail(), 42, 'test-machine-user', RUTEO_CONFIG);

    expect('state' in payload).toBe(false);
    expect('actor' in payload).toBe(false);
    expect('fileIds' in payload).toBe(false);
  });

  // TS-3
  it('trunca un titulo de 400 caracteres a 255, sin indicador de corte', () => {
    const payload = buildRequirementPayload(
      mail({ subject: 'x'.repeat(400) }),
      42,
      'test-machine-user',
      RUTEO_CONFIG,
    );

    expect(payload.title.length).toBe(255);
    expect(payload.title).toBe('x'.repeat(255));
  });

  // TS-4
  it('un asunto de solo espacios produce el placeholder de titulo', () => {
    const payload = buildRequirementPayload(
      mail({ subject: '   '.repeat(100) }),
      42,
      'test-machine-user',
      RUTEO_CONFIG,
    );

    expect(payload.title).toBe(RUTEO_CONFIG.placeholderTitle);
  });

  // TS-5: el orden recortar -> truncar -> placeholder es el UNICO que no pierde el mail. Con el
  // orden invertido, 400 espacios producirian un title vacio que el schema rechaza con min(1).
  it('el orden recortar->truncar->placeholder es invertible: 400 espacios pasa el schema', () => {
    const payload = buildRequirementPayload(
      mail({ subject: ' '.repeat(400) }),
      42,
      'test-machine-user',
      RUTEO_CONFIG,
    );

    expect(newRequirementSchema.safeParse(payload).success).toBe(true);
    expect(payload.title).toBe(RUTEO_CONFIG.placeholderTitle);
  });

  // TS-6: propiedad de codigo -- TITLE_MAX_LENGTH se importa, nunca se redeclara un 255 literal.
  it('importa TITLE_MAX_LENGTH en vez de redeclarar un literal', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/publicacion/mail-payload.ts', import.meta.url)),
      'utf8',
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codeOnly).toMatch(
      /import\s*\{[^}]*\bTITLE_MAX_LENGTH\b[^}]*\}\s*from\s*['"]#domain\/publicacion\/requirement\.schema\.js['"]/,
    );
    expect(codeOnly).not.toMatch(/\b255\b/);
    expect(TITLE_MAX_LENGTH).toBe(255);
  });

  // TS-7
  it('asunto y cuerpo vacios producen ambos placeholders', () => {
    const payload = buildRequirementPayload(
      mail({ subject: '', body: '' }),
      42,
      'test-machine-user',
      RUTEO_CONFIG,
    );

    expect(payload.title).toBe('Ticket recibido por mail');
    expect(payload.description).toBe('(mail sin contenido)');
  });

  // TS-9
  it('la descripcion es exactamente el cuerpo, sin avisos de adjunto', () => {
    const payload = buildRequirementPayload(mail(), 42, 'test-machine-user', RUTEO_CONFIG);

    expect(payload.description).toBe('No puedo entrar');
  });

  // TS-10: attachments no se leen en ningun lado -- el mail que recibe la funcion no expone
  // ningun campo de adjuntos en su tipo (Pick<IncomingMail, 'subject' | 'body'>), asi que un mail
  // con o sin adjuntos produce el mismo resultado por construccion. Se afirma tambien sobre el
  // codigo (sin comentarios, que si mencionan la palabra para explicar la exclusion), que
  // `mail.attachments` no aparece.
  it('nunca lee mail.attachments', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/domain/publicacion/mail-payload.ts', import.meta.url)),
      'utf8',
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(codeOnly).not.toContain('attachments');
  });

  it('type, priority y visibilityLevel son literales fijos, no configurables', () => {
    const payload = buildRequirementPayload(mail(), 42, 'test-machine-user', RUTEO_CONFIG);

    expect(payload.type).toBe('incidencia');
    expect(payload.priority).toBe('sin_prioridad');
    expect(payload.visibilityLevel).toBe('public');
  });

  it('creator es exactamente el userId recibido, sin transformacion', () => {
    const payload = buildRequirementPayload(mail(), 42, 'algun-user-id-raro', RUTEO_CONFIG);

    expect(payload.creator).toBe('algun-user-id-raro');
  });

  // TS-22 (regresion de S-005): buildVerificationPayload() sigue sin creator tras reescribir el
  // comentario que lo explica.
  it('buildVerificationPayload sigue sin creator', () => {
    const payload = buildVerificationPayload(7);

    expect('creator' in payload).toBe(false);
  });

  // TS-25 (Tarea 5): RequirementValidationError con un payload DERIVADO DE UN MAIL REAL (no un
  // literal fijo del modo de verificacion) sigue sin filtrar el valor rechazado — solo la ruta.
  it('un payload invalido derivado de un mail real no filtra su contenido, solo la ruta', () => {
    const secretSubject = 'CONTENIDO-SECRETO-DE-CLIENTE-EN-EL-ASUNTO';
    const payload = buildRequirementPayload(
      mail({ subject: secretSubject }),
      42,
      'test-machine-user',
      RUTEO_CONFIG,
    );

    try {
      // `type` invalido para forzar el rechazo sin tocar `title`, que ya lleva el secreto: lo que
      // se afirma es que el VALOR DE `title` (valido pero sensible) no aparece en el error, aunque
      // el campo invalido sea otro.
      parseNewRequirement({ ...payload, type: 'CONTENIDO-SECRETO-EN-EL-TIPO' });
      expect.unreachable('parseNewRequirement must throw on an invalid payload');
    } catch (error) {
      expect(error).toBeInstanceOf(RequirementValidationError);
      const serialized = JSON.stringify({
        message: (error as Error).message,
        details: (error as RequirementValidationError).details,
      });
      expect(serialized).not.toContain(secretSubject);
      expect(serialized).not.toContain('CONTENIDO-SECRETO-EN-EL-TIPO');
      expect((error as RequirementValidationError).invalidFields).toContain('type');
    }
  });
});
