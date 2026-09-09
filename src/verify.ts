import { loadDotenvUnlessTest } from '#config/dotenv.js';
import { ConfigValidationError } from '#config/errors.js';
import { publishVerificationRequirement } from '#domain/publicacion/publish-requirement.js';
import { closeBus } from '#infra/bus/connection.js';
import { reportStartupFailure, runStartup } from './startup.js';

// Misma llamada y mismo motivo que en src/index.ts: los dos entry points cargan el `.env` igual, y
// ninguno de los dos lo hace bajo NODE_ENV=test.
loadDotenvUnlessTest();

/**
 * El fail-fast de `JIKU_VERIFY_PROJECT_ID`, en el UNICO punto donde la variable significa algo.
 *
 * La variable es opcional en el schema (src/config/schema.ts) porque el worker no la lee jamas:
 * exigirsela a todo despliegue obligaba a declarar un proyecto de prueba para correr un proceso que
 * no lo usa. Lo que NO se perdio es el fail-fast — se mudo aca, y esta funcion es esa mudanza.
 *
 * Recibe el valor YA VALIDADO por parametro y no lee `process.env`, que es la propiedad CA-1 del
 * servicio: hay UNA sola lectura del entorno en todo `src/`, y vive en `src/config/env.ts`. Un test
 * de propiedad la afirma escaneando el codigo (test/config/source-properties.test.ts), asi que el
 * chequeo obvio —mirar `process.env` aca— rompe la suite, y con razon: duplicaria la coercion del
 * schema y un `'0'` pasaria este chequeo para fallar despues en otro lado con otro mensaje.
 *
 * Por eso `undefined` aca significa exactamente una cosa —la variable no fue declarada—: cualquier
 * valor invalido (un `0`, un `-3`, un `no-es-int`) ya no llego hasta aca, lo rechazo el schema en
 * `loadAppConfig()` con su propio mensaje.
 *
 * Lanza `ConfigValidationError` y no un Error generico para reusar el canal de reporte que
 * `reportStartupFailure()` ya tiene para los fallos de configuracion: stderr directo, sin logger.
 * La razon es la misma que alla — el operador arregla esto editando el entorno, no leyendo un log
 * estructurado— y ademas hace que el `main().catch()` de abajo no necesite ninguna rama nueva.
 */
function requireVerifyProjectId(verifyProjectId: number | undefined): number {
  if (verifyProjectId === undefined) {
    throw new ConfigValidationError(
      'JIKU_VERIFY_PROJECT_ID es requerida por el modo de verificacion y no esta declarada: ' +
        'se esperaba un entero positivo (el proyecto de Jiku, NO el project id de Zitadel de ' +
        'JIKU_PROJECT_ID) contra el que crear el requisito de prueba. Usa un PROYECTO DE PRUEBA: ' +
        'cada corrida deja un requisito permanente que no se puede borrar',
      // La lista de variables afectadas, igual que la construye `toConfigValidationError()` para
      // los fallos del schema: el canal de reporte es el mismo, asi que la forma del error tambien.
      ['JIKU_VERIFY_PROJECT_ID'],
    );
  }

  return verifyProjectId;
}

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
  const { config, logger, client, ticketMapWatch } = await runStartup();

  // El chequeo va DESPUES de `runStartup()`, y no antes, porque el valor validado sale de la
  // configuracion que esa funcion carga — ver el comentario de `requireVerifyProjectId()` sobre por
  // que no se mira `process.env`. El costo es que un despliegue sin la variable paga el arranque
  // (key, token y handshake) antes de que le digan que falta; a cambio, el chequeo no duplica la
  // coercion del schema, que es la fuente de bugs mas cara de las dos.
  //
  // Va antes del `try` del `finally` que cierra el bus: si esto lanza, `runStartup()` ya dejo una
  // conexion abierta, y el `catch` de `main()` la deja sin drenar. Es aceptable — el proceso sale
  // con codigo distinto de cero y el SO cierra el socket— y es el mismo comportamiento que tiene
  // hoy cualquier fallo entre el arranque y el `try`.
  const verifyProjectId = requireVerifyProjectId(config.verifyProjectId);

  try {
    await publishVerificationRequirement({
      client,
      // El proyecto de prueba sale de la CONFIGURACION (JIKU_VERIFY_PROJECT_ID), validado como int
      // positivo por el schema de S-002. Nunca un literal.
      //
      // Se pasa el resultado de `requireVerifyProjectId()` y NO `config.verifyProjectId` con un `!`:
      // el tipo de retorno de esa funcion es `number` a secas, asi que el estrechamiento lo hace el
      // compilador y no una asercion. Un `!` aca seguiria compilando el dia que alguien mueva o
      // borre el chequeo; esto no.
      projectId: verifyProjectId,
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
    // El watch del Mapa de Tickets (S-025) se baja ANTES de cerrar el bus, y este proceso lo
    // necesita mas que el worker: el `verify` TERMINA. Sin este `stop()`, `closeBus()` terminaria el
    // iterador del watch y el loop de background lo leeria como una CAIDA —lo es, desde su punto de
    // vista— emitiendo un `warn` espurio y programando un reintento sobre una conexion que ya no
    // esta. El reintento esta `unref()` eado y no colgaria el proceso, pero el `warn` mentiria.
    //
    // El `verify` hereda el paso 5.6 por usar `runStartup()`, y eso es CORRECTO (el modo de
    // verificacion tiene que fallar igual que el worker contra un despliegue sin buckets); lo que
    // no hereda es el apagado ordenado del worker, asi que lo baja acá.
    ticketMapWatch.stop();

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
