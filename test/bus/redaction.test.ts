import { describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture } from '../shared/log-capture.js';

/**
 * TS-14: que ningun secreto llegue a una linea de log.
 *
 * Las aserciones que de verdad detectan una filtracion son las de `raw()` — el string serializado —
 * y no las de `lines()`: sobre el objeto parseado no se puede detectar un secreto que se filtro por
 * un campo que el test no penso en mirar.
 *
 * Este archivo NO levanta ningun contenedor a proposito. TS-15 —la linea de arranque real, que
 * necesita un `Client` conectado— vive en connection.test.ts, que es el unico archivo de la suite
 * autorizado a arrancar el NATS con `--auth`. Partirlo asi es lo que mantiene esa excepcion en UN
 * archivo, que es la forma en que la convencion la permite.
 */

const SECRET_PATHS = {
  credsFile: '/run/secrets/sentinel.creds',
  keyFile: '/run/secrets/machine-user.json',
  zitadelProjectId: 'proj-uuid-de-zitadel',
};

function configWith(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: 'test',
    credsFile: SECRET_PATHS.credsFile,
    keyFile: SECRET_PATHS.keyFile,
    zitadelProjectId: SECRET_PATHS.zitadelProjectId,
    issuer: 'https://unreachable-issuer.invalid',
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'trace',
    nodeEnv: 'test',
    // Los dos bloques anidados los agrega S-007. Los valores son los de prueba consistentes de toda
    // la suite: TS-34 los busca literalmente en los streams del proceso real.
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      user: 'tickets@ejemplo.com',
      password: 'app-password-de-prueba',
    },
    poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
    ruteo: {
      ticketMap: new Map([['alfa', 42]]),
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
    ...overrides,
  };
}

describe('log redaction over the fields this story can produce', () => {
  // TS-14
  it('censors every credential-shaped field the bus code could log', () => {
    const capture = createLogCapture();
    const logger = createLogger(configWith(), capture.stream);

    logger.error(
      {
        accessToken: 'eyJ-SECRETO',
        token: 't-SECRETO',
        creds: 'c-SECRETO',
        key: 'k-SECRETO',
      },
      'x',
    );

    const line = capture.lines()[0] as Record<string, unknown>;
    expect(line['accessToken']).toBe('[REDACTED]');
    expect(line['token']).toBe('[REDACTED]');
    expect(line['creds']).toBe('[REDACTED]');
    expect(line['key']).toBe('[REDACTED]');

    // La asercion que importa: el string serializado no contiene el secreto por NINGUN camino.
    expect(capture.raw().join('\n')).not.toContain('SECRETO');
  });

  it('censors a nested credential one level deep, which is all the syntax supports', () => {
    const capture = createLogCapture();
    const logger = createLogger(configWith(), capture.stream);

    // Un nivel: es lo que cubre el comodin `*` de Pino. Los puntos de log de esta story son planos
    // o de un nivel precisamente por esto — no hay comodin profundo, y un contexto de tres niveles
    // dejaria el secreto en claro sin fallar ni avisar.
    logger.error({ auth: { token: 'anidado-SECRETO' } }, 'x');

    expect(capture.raw().join('\n')).not.toContain('SECRETO');
  });

  it('censors the paths to the secret files, not only their contents', () => {
    const capture = createLogCapture();
    const logger = createLogger(configWith(), capture.stream);

    // Donde esta el secreto es informacion sobre el secreto. La linea de arranque los excluye por
    // OMISION; `redact` cubre ademas el log que los incluya por error.
    logger.info({ keyFile: SECRET_PATHS.keyFile, credsFile: SECRET_PATHS.credsFile }, 'x');

    expect(capture.raw().join('\n')).not.toContain('/run/secrets');
  });
});
