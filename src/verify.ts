import 'dotenv/config';

import { publishVerificationRequirement } from '#domain/publicacion/publish-requirement.js';
import { closeBus } from '#infra/bus/connection.js';
import { reportStartupFailure, runStartup } from './startup.js';

/**
 * El MODO DE VERIFICACION (`npm run verify`): publica un `requirements.new` real y traduce la
 * respuesta.
 *
 * Es un script SEPARADO del arranque, y la separacion es el punto (CA-2). Un requisito creado no se
 * modifica ni se borra nunca (invariante 9) y el conector no tiene comando de compensacion: si la
 * publicacion ocurriera como efecto secundario de `start`, cada reinicio del worker dejaria un
 * requisito permanente que NADIE PUEDE LIMPIAR.
 *
 * Consecuencia aceptada y documentada: cada corrida deja un requisito nuevo (no hay idempotencia).
 * La mitigacion es operativa — correrlo contra un PROYECTO DE PRUEBA.
 */
async function main(): Promise<void> {
  // Reusa la secuencia completa del arranque: misma configuracion, mismo logger, misma identidad,
  // UNA sola conexion. No la duplica.
  const { config, logger, client } = await runStartup();

  try {
    await publishVerificationRequirement({
      client,
      // El proyecto de prueba sale de la CONFIGURACION (JIKU_VERIFY_PROJECT_ID), validado como int
      // positivo por el schema de S-002. Nunca un literal.
      projectId: config.verifyProjectId,
      logger,
    });
  } finally {
    // `closeBus()` en un `finally` para que la conexion se drene TAMBIEN cuando la publicacion
    // fallo: este proceso tiene que terminar, y una conexion abierta lo dejaria colgado esperando
    // trabajo que nunca llega.
    //
    // Va DESPUES de que el fallo se logueo (el log ocurre adentro de
    // `publishVerificationRequirement()`). Cerrar primero no romperia el log —Pino escribe a
    // stdout, no al bus— pero invertirlo haria mas dificil leer el codigo sin ganar nada.
    //
    // `closeBus()` y NUNCA `await using`: `Symbol.asyncDispose` existe en el Client, pero la
    // sintaxis `await using` necesita Node 24 y es un ERROR DE SINTAXIS en Node 22, que es el
    // runtime de este servicio. S-004 dejo esta funcion sin consumidor exactamente para este
    // momento.
    await closeBus();
  }
}

main().catch((error: unknown) => {
  // `PublishError` ya se logueo en `publishVerificationRequirement()`, con su diagnostico completo:
  // aca solo llega para decidir el codigo de salida. Los fallos de ARRANQUE (configuracion, key,
  // conexion) si se reportan aca, por el mismo canal que el worker.
  //
  // El chequeo es por `code` y no por `instanceof PublishError` para no importar el modulo de
  // errores de publicacion solo para esto: lo que importa es no loguear dos veces la misma linea.
  const alreadyLogged =
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'PUBLISH_ERROR';

  if (!alreadyLogged) {
    reportStartupFailure(error);
  }

  // Codigo de salida DISTINTO DE CERO. Es la mitad del contrato del modo de verificacion: un script
  // que saliera con 0 despues de fallar haria que el operador concluyera que el plano de escritura
  // esta abierto cuando no lo esta.
  process.exitCode = 1;
});
