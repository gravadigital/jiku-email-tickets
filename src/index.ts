import 'dotenv/config';

import { ConfigValidationError } from '#config/errors.js';
import { loadAppConfig } from '#config/index.js';
import { initLogger } from '#shared/logger.js';
import { SERVICE_NAME } from '#shared/service-info.js';

async function main(): Promise<void> {
  const config = await loadAppConfig();

  // El logger se construye ACA, apenas la configuracion valido y antes que cualquier otra cosa. No
  // es una preferencia de orden: el Paso 3 (cargar la key), el Paso 4 (obtener el token) y el Paso 5
  // (conectar) son todos posteriores y todos tienen que poder loguear sus fallos por un logger que
  // redacta. Un logger agregado despues de la conexion dejaria sin cubrir exactamente el tramo mas
  // sensible del arranque.
  const logger = initLogger(config);

  // Se loguean solo tres valores no sensibles. NUNCA credsFile, keyFile, zitadelProjectId ni
  // servers: las dos primeras son rutas a secretos —y una ruta a un archivo de credenciales es
  // informacion sobre donde esta el secreto— y las otras dos son topologia del despliegue (ADR-006).
  // Esta decision es de S-002 y se preserva textualmente: sin este comentario, el proximo que toque
  // la linea la va a "completar".
  //
  // Objeto de contexto primero, mensaje estatico segundo (convencion `logging`): asi las lineas son
  // agrupables por mensaje y consultables por campo. timeoutMs va como numero, no como String() —
  // esa es una de las ganancias concretas de loguear estructurado.
  logger.info(
    { instance: config.instance, logLevel: config.logLevel, timeoutMs: config.timeoutMs },
    'configuracion valida',
  );

  // S-004 conecta al bus. En S-003 el arranque termina aca: el logger construido ES el entregable,
  // y que el proceso salga con 0 es la prueba de que la validacion no corta un entorno valido.
}

main().catch((error: unknown) => {
  // Este catch NO usa el logger, y la asimetria es deliberada: un fallo de validacion de
  // configuracion ocurre ANTES de que el logger exista, asi que su reporte sale por stderr directo.
  // Del Paso 2 en adelante se falla con logger; el Paso 1 falla sin el. Esta en la tabla de errores
  // del flow y no es un descuido.
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    // Fallback para lo no reconocido: tampoco puede asumir que el logger se construyo, porque el
    // fallo puede venir de loadAppConfig() o de la construccion misma del logger.
    process.stderr.write(`${SERVICE_NAME}: fallo el arranque: ${String(error)}\n`);
  }
  // process.exitCode en vez de process.exit(1): deja que Node drene los streams antes de salir.
  // Con process.exit() el mensaje de stderr se puede perder si el stream esta bufferizado —
  // justamente el mensaje que el arranque existe para entregar.
  process.exitCode = 1;
});
