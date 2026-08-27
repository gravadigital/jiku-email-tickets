import { describe, expect, it } from 'vitest';

import { ConfigValidationError, toConfigValidationError } from '#config/errors.js';
import { AppError } from '#shared/errors/index.js';

/** Minimal shape of a Standard Schema issue, enough to drive the formatter. */
function issue(variable: string, message = 'Invalid input'): { path: string[]; message: string } {
  return { path: [variable], message };
}

describe('ConfigValidationError', () => {
  it('extends AppError with the documented code and http status', () => {
    const err = toConfigValidationError([issue('JIKU_CREDS')]);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    expect(err.httpStatus).toBe(500);
    expect(err.name).toBe('ConfigValidationError');
  });

  it('exposes the offending variable names sorted and deduplicated', () => {
    const err = toConfigValidationError([
      issue('JIKU_PROJECT_ID'),
      issue('JIKU_CREDS'),
      issue('JIKU_CREDS', 'a second issue on the same variable'),
    ]);

    expect(err.variables).toEqual(['JIKU_CREDS', 'JIKU_PROJECT_ID']);
  });

  it('reports every variable in a single multiline message', () => {
    const err = toConfigValidationError([
      issue('JIKU_CREDS'),
      issue('JIKU_KEY_FILE'),
      issue('JIKU_PROJECT_ID'),
      issue('JIKU_VERIFY_PROJECT_ID'),
    ]);

    expect(err.message).toContain('jiku-mail-connector');
    for (const name of ['JIKU_CREDS', 'JIKU_KEY_FILE', 'JIKU_PROJECT_ID', 'JIKU_VERIFY_PROJECT_ID']) {
      expect(err.message).toContain(name);
    }
    // Encabezado + una linea por variable + cierre.
    expect(err.message.split('\n')).toHaveLength(6);
  });

  it('agrees in number when a single variable is at fault', () => {
    const err = toConfigValidationError([issue('JIKU_PROJECT_ID')]);

    expect(err.message).toContain('1 variable:');
    expect(err.message).not.toContain('1 variables');
    expect(err.message).toContain('Corregila');
  });

  it('describes what was expected for each variable', () => {
    const err = toConfigValidationError([issue('JIKU_TIMEOUT')]);

    expect(err.message).toMatch(/JIKU_TIMEOUT:.+/);
  });

  it('keeps details limited to the variable names', () => {
    const err = toConfigValidationError([issue('JIKU_CREDS')]);

    expect(err.details).toEqual({ variables: ['JIKU_CREDS'] });
  });

  it('never interpolates the zod message, so a leaked value cannot reach the output', () => {
    // Una version futura de Zod podria incluir el valor ofensor en el message del issue.
    // El formateador no lee issue.message, asi que no hay camino desde el valor al string.
    const err = toConfigValidationError([issue('JIKU_CREDS', 'received "SENTINEL-abc123"')]);

    expect(err.message).not.toContain('SENTINEL-abc123');
    expect(JSON.stringify(err.details)).not.toContain('SENTINEL-abc123');
  });

  it('still names an unknown variable without dumping the issue', () => {
    const err = toConfigValidationError([issue('SOME_FUTURE_VAR', 'received "leaked"')]);

    expect(err.variables).toEqual(['SOME_FUTURE_VAR']);
    expect(err.message).toContain('SOME_FUTURE_VAR');
    expect(err.message).not.toContain('leaked');
  });
});
