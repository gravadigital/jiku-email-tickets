import { describe, expect, it } from 'vitest';

import { REDACT_CENSOR, REDACT_PATHS } from '#shared/log-redaction.js';

/**
 * Los tests de que la redaccion EFECTIVAMENTE censura viven en `logger.test.ts`, contra el logger
 * real y sobre la linea serializada. Este archivo verifica la lista en si: que declare lo que tiene
 * que declarar y —igual de importante— que NO declare lo que el log necesita conservar.
 */
describe('REDACT_CENSOR', () => {
  it('is the literal the acceptance criteria name', () => {
    expect(REDACT_CENSOR).toBe('[REDACTED]');
  });
});

describe('REDACT_PATHS', () => {
  const paths: readonly string[] = REDACT_PATHS;

  it('declares the mail body paths before the data exists', () => {
    // CA-7: FG-2 hereda la regla en vez de agregarla despues.
    for (const path of ['body', '*.body', 'text', '*.text', 'html', '*.html']) {
      expect(paths, `missing anticipated mail-body path ${path}`).toContain(path);
    }
  });

  it('declares the attachment content paths before the data exists', () => {
    // CA-7: FG-3 hereda la regla. El indice con comodin esta soportado por pino@10.3.1 (verificado).
    for (const path of ['content', '*.content', 'attachments[*].content', '*.attachments[*].content']) {
      expect(paths, `missing anticipated attachment path ${path}`).toContain(path);
    }
  });

  it('covers every token spelling in both root and one-level-nested form', () => {
    for (const field of ['accessToken', 'token', 'access_token']) {
      expect(paths, `missing root path ${field}`).toContain(field);
      expect(paths, `missing wildcard path *.${field}`).toContain(`*.${field}`);
    }
  });

  it('covers the generic credential fields in both forms', () => {
    for (const field of ['credentials', 'password', 'apiKey']) {
      expect(paths, `missing root path ${field}`).toContain(field);
      expect(paths, `missing wildcard path *.${field}`).toContain(`*.${field}`);
    }
  });

  it('covers the machine user key fields with the exact names of the SDK', () => {
    // `ServiceAccountKey = { type?, keyId, key, userId, expirationDate? }`. El campo `key` a secas
    // es la clave privada RSA.
    for (const field of ['key', 'keyId']) {
      expect(paths, `missing root path ${field}`).toContain(field);
      expect(paths, `missing wildcard path *.${field}`).toContain(`*.${field}`);
    }
  });

  it('covers the NATS creds content in both forms', () => {
    expect(paths).toContain('creds');
    expect(paths).toContain('*.creds');
  });

  it('never redacts the fields ADR-006 requires to be logged', () => {
    // El fallo opuesto, y no menos grave: un log que censura el rastro deja de servir para
    // reconstruir un ticket perdido, que es la unica razon por la que existe.
    for (const field of ['messageId', 'projectId', 'slug', 'instance', 'id']) {
      expect(paths, `${field} must stay loggable`).not.toContain(field);
      expect(paths, `*.${field} must stay loggable`).not.toContain(`*.${field}`);
    }
  });

  it('declares no HTTP path, because the service exposes no HTTP', () => {
    // ADR-001: sin servidor HTTP, `req.headers.*` no puede ocurrir jamas. Son ruido en una lista
    // que se lee para auditar.
    for (const path of paths) {
      expect(path.startsWith('req.'), `unreachable HTTP path ${path}`).toBe(false);
    }
  });

  it('has no duplicate entry', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });
});
