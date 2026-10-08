import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { REDACT_CENSOR, REDACT_PATHS } from '#shared/log-redaction.js';
import { createLogger, resetLoggerForTests } from '#shared/logger.js';

import { createLogCapture } from './log-capture.js';

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

  // TS-60 (S-027). El texto del comentario es contenido del CLIENTE, misma clase que `body`.
  it('covers the comment text in both root and one-level-nested form', () => {
    // LAS DOS FORMAS: pino no tiene comodin profundo, asi que una sola dejaria el otro nivel en
    // claro sin fallar y sin avisar.
    expect(paths, "missing root path 'comment'").toContain('comment');
    expect(paths, "missing wildcard path '*.comment'").toContain('*.comment');
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

/**
 * TS-35 (S-007). La frontera REAL de `redact`, afirmada sobre la linea SERIALIZADA — que es donde
 * `redact` actua. Un test escrito sobre el objeto de entrada pasaria con `redact` desconectado.
 *
 * Que el caso de TRES niveles NO se censure es el resultado ESPERADO y esta escrito como tal, no
 * como bug: `redact.paths` de Pino no tiene comodin profundo. Es exactamente la razon de existir
 * del escaner de puntos de log de test/config/source-properties.test.ts — la defensa contra un
 * `config.imap.password` en un log no es una ruta mas en esta lista (siempre quedaria un nivel
 * atras), sino la regla estructural de que ningun log emite el AppConfig completo.
 *
 * NO "arreglar" este test agregando una ruta: la ruta cubriria un solo camino de anidamiento y el
 * problema es la clase entera.
 */
describe('REDACT_PATHS depth boundary', () => {
  const SECRET = 'app-password-de-prueba';

  const CFG: AppConfig = {
    servers: 'nats://localhost:4222',
    instance: 'dev',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile: '/run/secrets/machine-user.json',
    zitadelProjectId: '307f1f77bcf86cd799439011',
    issuer: 'https://id.grava.io',
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'info',
    nodeEnv: 'production',
    imap: { host: 'imap.gmail.com', port: 993, user: 'tickets@ejemplo.com', password: SECRET },
    poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
    ruteo: {
      subaddressPrefix: 'tickets',
      placeholderTitle: 'Ticket recibido por mail',
      placeholderBody: '(mail sin contenido)',
    },
    adjuntos: {
      allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
      maxSizeBytes: 10_485_760,
      putTimeoutMs: 30_000,
    },
  };

  afterEach(() => {
    resetLoggerForTests();
  });

  it('censors a password at the root of the context', () => {
    const capture = createLogCapture();
    createLogger(CFG, capture.stream).info({ password: SECRET }, 'x');

    expect(capture.raw().join('\n')).not.toContain(SECRET);
    expect(capture.raw().join('\n')).toContain(REDACT_CENSOR);
  });

  it('censors a password nested one level, which is where imap.password sits', () => {
    const capture = createLogCapture();
    createLogger(CFG, capture.stream).info({ imap: { password: SECRET } }, 'x');

    expect(capture.raw().join('\n')).not.toContain(SECRET);
    expect(capture.raw().join('\n')).toContain(REDACT_CENSOR);
  });

  // TS-61 (S-027): el texto del comentario se censura en la raiz.
  it('censors the comment text at the root', () => {
    const capture = createLogCapture();
    createLogger(CFG, capture.stream).info({ comment: SECRET }, 'x');

    expect(capture.raw().join('\n')).not.toContain(SECRET);
    expect(capture.raw().join('\n')).toContain(REDACT_CENSOR);
  });

  // TS-62 (S-027): y tambien un nivel abajo, que es donde caeria si alguien logueara el payload.
  it('censors the comment text nested one level, where a payload would put it', () => {
    const capture = createLogCapture();
    createLogger(CFG, capture.stream).info({ payload: { comment: SECRET } }, 'x');

    expect(capture.raw().join('\n')).not.toContain(SECRET);
    expect(capture.raw().join('\n')).toContain(REDACT_CENSOR);
  });

  it('does NOT censor at three levels, which is why the log-call scanner exists', () => {
    const capture = createLogCapture();
    // Esto es exactamente lo que pasaria si un log emitiera el AppConfig entero bajo una clave.
    createLogger(CFG, capture.stream).info({ config: { imap: { password: SECRET } } }, 'x');

    // El secreto sale EN CLARO. No falla, no avisa. Por eso la defensa es estructural y no una
    // ruta mas en la lista.
    expect(capture.raw().join('\n')).toContain(SECRET);
  });
});
