import type { AppConfig } from '#config/index.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../shared/log-capture.js';

/**
 * Helper local de los tests de `test/ingesta/`: un `AppConfig` minimo valido y un logger con
 * captura, para pasarle a `normalize(raw, logger)`.
 *
 * No es un helper de infraestructura compartido (`test/shared/`): cada suite existente
 * (`bus/`, `publicacion/`) ya trae su propio `configWith()` local, y este sigue el mismo criterio.
 */
const BASE_CONFIG: AppConfig = {
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
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    user: 'tickets@ejemplo.com',
    password: 'app-password-de-prueba',
  },
  poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
};

export function testLoggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  const logger = createLogger(BASE_CONFIG, capture.stream);
  return { logger, capture };
}
