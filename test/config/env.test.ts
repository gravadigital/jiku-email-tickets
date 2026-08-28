import { describe, expect, it } from 'vitest';

import { EXPECTATIONS, ConfigValidationError } from '#config/errors.js';
import { loadEnv } from '#config/env.js';

/**
 * Entorno minimo valido. Los tests pasan objetos literales: nunca mutan process.env.
 *
 * Eran cuatro variables hasta S-006. S-007 sumo las tres credenciales de la casilla, que pasaron a
 * ser requeridas con la ingesta en alcance.
 */
const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'tickets@ejemplo.com',
  IMAP_PASSWORD: 'app-password-de-prueba',
};

/** Las siete requeridas, en el orden alfabetico en que el formateador las lista. */
const ALL_REQUIRED = [
  'IMAP_HOST',
  'IMAP_PASSWORD',
  'IMAP_USER',
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
  'JIKU_VERIFY_PROJECT_ID',
];

describe('loadEnv', () => {
  // TS-1. Las tres de IMAP salen en la MISMA lista que las del bus: una sola pasada para el
  // operador, no un fail-fast que descubre una variable por vez.
  it('reports every missing required variable together in a single list', () => {
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

  // INVERTIDO EN S-007, no borrado. Antes afirmaba que loadEnv() resolvia SIN ninguna variable de
  // IMAP: la ingesta no estaba en alcance y las de la casilla eran opcionales por ausencia. Desde
  // esta story las tres credenciales son requeridas, asi que el mismo entorno que antes resolvia
  // ahora tiene que FALLAR — y ese cambio de sentido es el punto de la story, no un efecto
  // secundario. Lo que NO cambio: las del Mapa de Tickets siguen sin declararse (FG-3).
  // (TS-5, TS-43)
  it('does not resolve when no IMAP variable is present', () => {
    const busOnly = {
      JIKU_CREDS: VALID_ENV.JIKU_CREDS,
      JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
      JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
      JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
    };

    expect(() => loadEnv(busOnly)).toThrow(ConfigValidationError);

    try {
      loadEnv(busOnly);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD', 'IMAP_USER']);
    }

    // Lo que sigue valiendo: ninguna clave del Mapa de Tickets se declara en este alcance.
    expect(Object.keys(loadEnv(VALID_ENV)).some((key) => key.includes('TICKET'))).toBe(false);
  });

  // TS-21. `pollEnabled` es un interruptor operativo, no un modo de despliegue distinto.
  it('still requires the IMAP credentials with the poll explicitly disabled', () => {
    try {
      loadEnv({
        JIKU_CREDS: VALID_ENV.JIKU_CREDS,
        JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
        JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
        JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
        POLL_ENABLED: 'false',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual([
        'IMAP_HOST',
        'IMAP_PASSWORD',
        'IMAP_USER',
      ]);
    }
  });

  // TS-2. El mensaje describe la variable desde EXPECTATIONS, no desde el message de Zod.
  it('describes a missing IMAP host from the expectations table, not from zod', () => {
    try {
      loadEnv({ ...VALID_ENV, IMAP_HOST: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST']);
      // El texto sale de la tabla, no de Zod. Se afirma en las DOS direcciones: que ESTE el de
      // EXPECTATIONS y que NO este el de Zod. Sin la mitad positiva, una regresion que dejara el
      // nombre de la variable y perdiera la descripcion pasaria en verde.
      expect(err.message).toContain(EXPECTATIONS.IMAP_HOST);
      for (const zodPhrase of ['Invalid input', 'Required', 'expected string']) {
        expect(err.message, zodPhrase).not.toContain(zodPhrase);
      }
    }
  });

  // TS-4. El valor de un secreto no llega al reporte por ningun camino.
  it('never dumps an IMAP value, the password least of all', () => {
    try {
      loadEnv({ ...VALID_ENV, IMAP_PASSWORD: '', IMAP_HOST: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD']);
      for (const value of ['app-password-de-prueba', 'imap.gmail.com', 'tickets@ejemplo.com']) {
        expect(err.message, value).not.toContain(value);
        expect(JSON.stringify(err.details), value).not.toContain(value);
      }
    }
  });

  // TS-14. El cron mal formado entra en la LISTA, junto a lo demas: no corta el reporte.
  it('lists a malformed cron together with a missing required variable', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_CRON: 'no es un cron', JIKU_CREDS: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toHaveLength(2);
      expect(err.variables).toContain('POLL_CRON');
      expect(err.variables).toContain('JIKU_CREDS');
    }
  });

  // TS-20
  it('names the two accepted values when POLL_ENABLED is not one of them', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_ENABLED: 'si' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('POLL_ENABLED');
      expect(err.message).toContain('true');
      expect(err.message).toContain('false');
    }
  });

  // TS-10
  it('names 1 as the minimum when POLL_MAX_PER_TICK is below it', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_MAX_PER_TICK: '0' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('POLL_MAX_PER_TICK');
      expect(err.message).toContain('1');
    }
  });

  // TS-6 desde loadEnv: los cuatro defaults llegan al env resuelto.
  it('applies the four IMAP and poll defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.IMAP_PORT).toBe(993);
    expect(env.POLL_CRON).toBe('*/5 * * * *');
    expect(env.POLL_ENABLED).toBe(true);
    expect(env.POLL_MAX_PER_TICK).toBe(50);
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
