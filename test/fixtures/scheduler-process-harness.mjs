// Arnes de proceso real para TS-6, TS-7, TS-8, TS-10, TS-11, TS-12 (Tareas 2 y 3 de S-011).
//
// Reproduce EXACTAMENTE el patron de `src/index.ts` — scheduleTick() + createShutdownHandler() +
// closeBus() + señales — pero sustituye `runStartup()` (que necesita Zitadel real, inalcanzable en
// este entorno de test) por una conexion directa al NATS del contenedor con un TokenSource
// doblado, mismo bypass que usa `test/bus/connection.test.ts` para sus tests unitarios. El codigo
// bajo prueba (scheduler, shutdown) es el REAL, compilado en dist/ — nada de esto se reimplementa.
import { createLogger } from '../../dist/shared/logger.js';
import { connectToBus, closeBus } from '../../dist/infra/bus/connection.js';
import { scheduleTick, waitForCurrentTick } from '../../dist/domain/ingesta/scheduler.js';
import { createShutdownHandler } from '../../dist/shared/shutdown.js';

const config = JSON.parse(process.env['HARNESS_CONFIG']);
const authToken = process.env['HARNESS_TOKEN'];

const logger = createLogger(config);

const auth = {
  token: () => Promise.resolve(authToken),
  currentToken: () => authToken,
  subject: () => Promise.resolve('test-machine-user'),
  expiresAt: () => undefined,
};

async function main() {
  await connectToBus({ config, auth, logger, creds: null });
  logger.info({}, 'conectado al bus');

  // Mismo orden que src/index.ts: los handlers de señal se registran ANTES de scheduleTick().
  let shutdown = createShutdownHandler({
    scheduledTask: undefined,
    waitForCurrentTick,
    closeBus,
    exit: (code) => process.exit(code),
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  const scheduledTask = scheduleTick(config, logger);

  shutdown = createShutdownHandler({
    scheduledTask,
    waitForCurrentTick,
    closeBus,
    exit: (code) => process.exit(code),
  });

  // Recien ACA los handlers de señal estan registrados. Los tests que mandan una señal esperan esta
  // linea y no "conectado al bus": esa se escribe antes del `process.on`, y en un runner cargado
  // (CI con dind) la señal podia llegar en esa ventana, sin handler, y matar el proceso con la
  // accion por defecto (exit code `null` en vez de `0`).
  logger.info({}, 'harness listo: handlers de señal registrados');
}

main().catch((error) => {
  process.stderr.write(`harness fallo: ${String(error)}\n`);
  process.exitCode = 1;
});
