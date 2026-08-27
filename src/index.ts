import { SERVICE_NAME } from '#shared/service-info.js';

// En S-001 el entry point solo prueba que el proceso arranca y que los imports por subpath
// resuelven en el dist/ compilado. La composicion real del arranque (config, logger, conexion
// al bus) es S-002 a S-004.
process.stdout.write(`${SERVICE_NAME} bootstrap ok\n`);
