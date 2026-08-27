import 'dotenv/config';

import { ConfigValidationError } from '#config/errors.js';
import { loadAppConfig } from '#config/index.js';
import { SERVICE_NAME } from '#shared/service-info.js';

async function main(): Promise<void> {
  const config = await loadAppConfig();

  // S-003 construye el logger y S-004 conecta al bus. En S-002 el arranque termina aca: la
  // configuracion resuelta ES el entregable, y que el proceso salga con 0 es la prueba de que la
  // validacion no corta un entorno valido.
  //
  // Se imprimen solo tres valores no sensibles. NUNCA credsFile, keyFile, zitadelProjectId ni
  // servers: las dos primeras son rutas a secretos —y una ruta a un archivo de credenciales es
  // informacion sobre donde esta el secreto— y las otras dos son topologia del despliegue (ADR-006).
  process.stdout.write(
    `${SERVICE_NAME}: configuracion valida (instance=${config.instance}, ` +
      `logLevel=${config.logLevel}, timeoutMs=${String(config.timeoutMs)})\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${SERVICE_NAME}: fallo el arranque: ${String(error)}\n`);
  }
  // process.exitCode en vez de process.exit(1): deja que Node drene los streams antes de salir.
  // Con process.exit() el mensaje de stderr se puede perder si el stream esta bufferizado —
  // justamente el mensaje que esta story existe para entregar.
  process.exitCode = 1;
});
