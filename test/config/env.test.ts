import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from '#config/errors.js';
import { loadEnv } from '#config/env.js';

/** Entorno minimo valido. Los tests pasan objetos literales: nunca mutan process.env. */
const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
};

const ALL_REQUIRED = ['JIKU_CREDS', 'JIKU_KEY_FILE', 'JIKU_PROJECT_ID', 'JIKU_VERIFY_PROJECT_ID'];

describe('loadEnv', () => {
  it('reports the three missing required variables together with the verify project id', () => {
    let caught: unknown;
    try {
      loadEnv({ JIKU_INSTANCE: 'dev' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    expect(err.variables).toEqual(ALL_REQUIRED);
    for (const name of ALL_REQUIRED) {
      expect(err.message).toContain(name);
    }
  });

  it('aborts when a single required variable is missing', () => {
    expect(() => loadEnv({ ...VALID_ENV, JIKU_PROJECT_ID: undefined })).toThrow(ConfigValidationError);

    try {
      loadEnv({ ...VALID_ENV, JIKU_PROJECT_ID: undefined });
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual(['JIKU_PROJECT_ID']);
    }
  });

  it('applies the declared defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.JIKU_INSTANCE).toBe('dev');
    expect(env.JIKU_SERVERS).toBe('nats://localhost:4222');
    expect(env.JIKU_ISSUER).toBe('https://id.grava.io');
    expect(env.JIKU_TIMEOUT).toBe(15_000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('raises a timeout below the floor to it', () => {
    expect(loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: '5000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('keeps a timeout above the floor', () => {
    expect(loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: '30000' }).JIKU_TIMEOUT).toBe(30_000);
  });

  it('lists a malformed timeout together with a missing required variable', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: 'abc', JIKU_CREDS: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toHaveLength(2);
      expect(err.variables).toContain('JIKU_TIMEOUT');
      expect(err.variables).toContain('JIKU_CREDS');
    }
  });

  it('treats an empty string as absent, not as a value', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_CREDS: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual(['JIKU_CREDS']);
    }
  });

  it('resolves without throwing when no IMAP or ticket-map variable is present', () => {
    const env = loadEnv(VALID_ENV);

    expect(Object.keys(env).some((key) => key.startsWith('IMAP_'))).toBe(false);
    expect(Object.keys(env).some((key) => key.includes('TICKET'))).toBe(false);
  });

  it('lists the accepted levels when LOG_LEVEL is invalid', () => {
    try {
      loadEnv({ ...VALID_ENV, LOG_LEVEL: 'verbose' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('LOG_LEVEL');
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
        expect(err.message).toContain(level);
      }
    }
  });

  it('never dumps a value in the failure message', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_CREDS: '', JIKU_KEY_FILE: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['JIKU_CREDS', 'JIKU_KEY_FILE']);
    }

    try {
      loadEnv({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: 'SENTINEL-abc123' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.message).toContain('JIKU_VERIFY_PROJECT_ID');
      expect(err.message).not.toContain('SENTINEL-abc123');
      expect(JSON.stringify(err.details)).not.toContain('SENTINEL-abc123');
    }
  });

  it('exposes the verify project id as a number', () => {
    const env = loadEnv({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '42' });

    expect(env.JIKU_VERIFY_PROJECT_ID).toBe(42);
    expect(typeof env.JIKU_VERIFY_PROJECT_ID).toBe('number');
  });
});

describe('#config/env.js module', () => {
  it('has no import-time effect, so importing it never validates the host environment', async () => {
    // Si env.ts construyera `env` como constante de modulo, este import lanzaria con el entorno
    // del host incompleto. La validacion la dispara el arranque (T4/T5), no el import.
    await expect(import('#config/env.js')).resolves.toBeDefined();
  });

  it('exports loadEnvFromProcess as a function, not an evaluated constant', async () => {
    const mod = await import('#config/env.js');

    expect(typeof mod.loadEnvFromProcess).toBe('function');
    expect('env' in mod).toBe(false);
  });
});
