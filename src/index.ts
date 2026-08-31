import 'dotenv/config';

import { scheduleTick, waitForCurrentTick } from '#domain/ingesta/scheduler.js';
import { closeBus } from '#infra/bus/connection.js';
import { createShutdownHandler } from '#shared/shutdown.js';

import { reportStartupFailure, runStartup } from './startup.js';

/**
 * El entry point del WORKER (`npm run start`).
 *
 * No publica NINGUN comando, y eso es una restriccion estructural y no una preferencia (CA-2): un
 * requisito creado no se modifica ni se borra nunca (invariante 9) y no hay comando de
 * compensacion, asi que si la publicacion ocurriera en cada arranque CADA REINICIO dejaria basura
 * permanente en el proyecto de Jiku. El modo de verificacion es un script SEPARADO
 * (`src/verify.ts`), y este archivo no importa nada de `#domain/publicacion/` — hay un test de
 * propiedad que escanea el codigo para afirmarlo.
 */
async function main(): Promise<void> {
  const { config, logger, client } = await runStartup();

  // Apagado ordenado (CA-8, CA-9, CA-10): los handlers de SIGTERM/SIGINT se registran ACA, ANTES
  // de `scheduleTick()`, y no despues. `shutdown` se reconstruye (mismo `waitForCurrentTick` y
  // `closeBus`, que no dependen del resultado de `scheduleTick()`) una vez que la tarea programada
  // esta disponible, pero el HANDLER DE PROCESO se registra desde ahora: si una señal llegara en la
  // ventana entre este registro y el `scheduleTick()` de abajo, el apagado ordenado corre igual
  // (no hay tarea que detener todavia, pero si hay bus que cerrar), en vez de que el proceso muera
  // sin ningun apagado ordenado por no tener aun ningun handler instalado. La deuda declarada en
  // S-004 ("el apagado ordenado tiene sentido cuando haya un tick en vuelo que perder") queda
  // saldada aca.
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

  // Paso 8 del flujo de arranque (S-011): las dos ramas de POLL_ENABLED. Con el poll habilitado,
  // `scheduleTick` llama a `cron.schedule()` y devuelve la tarea programada. Con el poll
  // deshabilitado, loguea el mensaje de deshabilitado y devuelve `undefined` — sin schedular
  // nada. Ningun tick corre antes del primer disparo real del cron: no hay tick inmediato.
  //
  // El `client` ya conectado por `runStartup()` (S-004) se propaga aca, SIN abrir ninguna conexion
  // nueva (ADR-002): es el mismo que el tick usara para publicar `requirements.new` (S-015). Este
  // archivo NO importa nada de `#domain/publicacion/` para lograrlo — el import queda encapsulado
  // en `tick.ts` (CA-24).
  const scheduledTask = scheduleTick(config, logger, client);

  // El proceso queda VIVO en ambas ramas. Con el poll habilitado, ademas hay un cron activo. Con
  // el poll deshabilitado (CA-3/CA-4), el proceso sigue vivo igual, pero NO por codigo de esta
  // rama: es el handle abierto de la conexion al bus, una propiedad heredada de `runStartup()` /
  // `connectToBus()`, no algo que este archivo agregue.
  shutdown = createShutdownHandler({
    scheduledTask,
    waitForCurrentTick,
    closeBus,
    exit: (code) => process.exit(code),
  });
}

main().catch((error: unknown) => {
  reportStartupFailure(error);

  // process.exitCode en vez de process.exit(1): deja que Node drene los streams antes de salir.
  // Con process.exit() el mensaje de stderr se puede perder si el stream esta bufferizado —
  // justamente el mensaje que el arranque existe para entregar.
  process.exitCode = 1;
});
