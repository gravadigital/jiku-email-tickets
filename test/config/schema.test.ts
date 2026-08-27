import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ISSUER, DEFAULT_SERVERS_URL, MIN_TIMEOUT_MS, envSchema } from '#config/schema.js';

const schema = z.object(envSchema);

/** Entorno minimo valido: solo las cuatro requeridas. */
const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
};

describe('envSchema constants', () => {
  it('sets the timeout floor at 15000 ms', () => {
    expect(MIN_TIMEOUT_MS).toBe(15_000);
  });

  it('declares the connector own issuer and bus defaults', () => {
    expect(DEFAULT_ISSUER).toBe('https://id.grava.io');
    expect(DEFAULT_SERVERS_URL).toBe('nats://localhost:4222');
  });
});

describe('envSchema', () => {
  it('applies the declared defaults when only the required variables are present', () => {
    const parsed = schema.parse(VALID_ENV);

    expect(parsed.JIKU_INSTANCE).toBe('dev');
    expect(parsed.JIKU_SERVERS).toBe('nats://localhost:4222');
    expect(parsed.JIKU_ISSUER).toBe('https://id.grava.io');
    expect(parsed.JIKU_TIMEOUT).toBe(15_000);
    expect(parsed.LOG_LEVEL).toBe('info');
  });

  it('raises a timeout below the floor up to it', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '5000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('keeps a timeout above the floor', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '30000' }).JIKU_TIMEOUT).toBe(30_000);
  });

  it('keeps a timeout exactly at the floor', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '15000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('rejects a malformed timeout', () => {
    const result = schema.safeParse({ ...VALID_ENV, JIKU_TIMEOUT: 'abc' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('JIKU_TIMEOUT');
  });

  it('exposes the verify project id as a number', () => {
    const parsed = schema.parse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '42' });

    expect(parsed.JIKU_VERIFY_PROJECT_ID).toBe(42);
    expect(typeof parsed.JIKU_VERIFY_PROJECT_ID).toBe('number');
  });

  it('rejects a non-numeric verify project id', () => {
    const result = schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: 'no-es-int' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('JIKU_VERIFY_PROJECT_ID');
  });

  it('rejects a non-positive verify project id', () => {
    expect(schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '0' }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '-3' }).success).toBe(false);
  });

  it('accepts every documented log level and rejects the rest', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      expect(schema.parse({ ...VALID_ENV, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    }
    expect(schema.safeParse({ ...VALID_ENV, LOG_LEVEL: 'verbose' }).success).toBe(false);
  });

  it('reports every missing required variable at once', () => {
    const result = schema.safeParse({ JIKU_INSTANCE: 'dev' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      'JIKU_CREDS',
      'JIKU_KEY_FILE',
      'JIKU_PROJECT_ID',
      'JIKU_VERIFY_PROJECT_ID',
    ]);
  });

  it('declares no IMAP or ticket-map variable in this scope', () => {
    const declared = Object.keys(envSchema);

    expect(declared).toHaveLength(9);
    expect(declared.some((key) => key.startsWith('IMAP_'))).toBe(false);
    expect(declared.some((key) => key.includes('TICKET'))).toBe(false);
  });

  it('rejects an issuer that is not a url', () => {
    expect(schema.safeParse({ ...VALID_ENV, JIKU_ISSUER: 'no-es-url' }).success).toBe(false);
  });
});
