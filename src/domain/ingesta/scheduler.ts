import type { Client } from '@gravadigital/jiku';
import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';
// Solo el TIPO del Espacio KV, que este modulo unicamente PROPAGA hasta el tick (S-032). No lo
// abre, no lo usa y no llama a `client.kv()` (ADR-002).
import type { KvSpace } from '#infra/kv/space.js';

import { runIngestaTick } from './tick.js';

/**
 * Extrae un mensaje seguro de una excepcion desconocida, para el `error` que este modulo loguea si
 * la funcion de tick inyectada llega a lanzar (nunca deberia con `runIngestaTick`: ya absorbe sus
 * propios fallos — ver S-010 — pero un doble de test puede lanzar deliberadamente, y este modulo
 * no relanza esa excepcion hacia `cron.schedule()` de ninguna forma que mate el proceso, AC-5 de
 * la Tarea 1).
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * El guard de no solapamiento (S-011, Riesgo 1 de la story): a lo sumo un tick a la vez, y el
 * indicador SIEMPRE se libera, incluso si el tick lanza. Es la pieza mas critica del feature
 * group completo: un indicador que no se libera detiene la ingesta para siempre, sin que el
 * proceso muera, y sin healthcheck (ADR-006) eso no tiene sintoma.
 *
 * Deliberadamente NO usa las opciones nativas de `node-cron` (`noOverlap`, etc.) — CA-7 exige un
 * booleano de modulo explicito y visible aca, no una opcion de configuracion de la libreria que
 * esconde el mecanismo. Este modulo tampoco integra `cron.schedule()` (eso es la Tarea 2 en
 * `src/index.ts`): solo produce la funcion de guard, invocable directamente desde un test o desde
 * el callback que `cron.schedule()` le pasa.
 */

/**
 * El indicador de tick en curso. Un `let` de modulo, booleano, con la vida del proceso (CA-7): no
 * hay cola, no hay semaforo, no hay estado persistido. Nunca se expone como parametro ni se
 * representa con un objeto externo — es literalmente esta variable.
 */
let tickInFlight = false;

/**
 * La promesa del tick actualmente en curso, si hay uno. Existe para que el apagado ordenado
 * (Tarea 3, CA-8/CA-9) pueda ESPERARLA sin depender de que `cron.stop()` lo haga — no lo hace: en
 * el modo de ejecucion en proceso, `stop()` solo impide disparos futuros, nunca espera una
 * invocacion de `func` ya en curso (ver Story Plan -> Integration Points).
 */
let inFlightPromise: Promise<void> | undefined;

/**
 * Aplica el guard de no solapamiento y, si no hay ningun tick corriendo, ejecuta `runTick`.
 *
 * Si `tickInFlight === true`: loguea `warn` con el mensaje literal que exige ADR-006/CA-5 y
 * retorna sin invocar `runTick` — el disparo salteado NO se encola, se pierde: el proximo disparo
 * del cron es la unica oportunidad siguiente.
 *
 * Si `tickInFlight === false`: lo marca `true`, invoca `runTick(config, logger, client, space)`, y el `finally`
 * lo devuelve a `false` SIEMPRE — con exito o con excepcion de `runTick` (CA-6). `runIngestaTick`
 * (S-010) ya no relanza nada por su cuenta, asi que esta funcion no necesita un `catch` adicional
 * sobre el resultado del tick: solo el `finally` sobre el indicador.
 */
export async function triggerTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  space: KvSpace,
  runTick: (
    config: AppConfig,
    logger: Logger,
    client: Client,
    space: KvSpace,
  ) => Promise<void> = runIngestaTick,
): Promise<void> {
  if (tickInFlight) {
    logger.warn({}, 'tick salteado: hay uno en curso');
    return;
  }

  tickInFlight = true;
  const run = (async () => {
    try {
      await runTick(config, logger, client, space);
    } catch (err) {
      // `runIngestaTick` real (S-010) ya no relanza nada por su cuenta — este catch solo importa
      // para un doble de test inyectado que lanza deliberadamente (AC-5): el guard nunca propaga
      // esa excepcion hacia el llamador de forma que mate el proceso o el cron.
      logger.error({ err: messageOf(err) }, 'el tick fallo dentro del scheduler');
    } finally {
      tickInFlight = false;
    }
  })();

  inFlightPromise = run;
  try {
    await run;
  } finally {
    // Solo limpia la referencia si sigue siendo LA MISMA promesa: evita que un tick que termina
    // tarde borre la referencia de un tick posterior que ya esta en curso (no deberia poder
    // ocurrir dado el guard de arriba, pero la comparacion es gratis y documenta la invariante).
    if (inFlightPromise === run) {
      inFlightPromise = undefined;
    }
  }
}

/**
 * Devuelve una promesa que resuelve cuando el tick en curso (si hay uno) termina.
 *
 * Si no hay ningun tick corriendo, resuelve de inmediato — no distingue "nunca corrio ninguno" de
 * "el ultimo ya termino": en ambos casos no hay nada que esperar. Es lo que hace posible el
 * apagado ordenado (CA-8/CA-9) sin depender de que `cron.stop()` espere nada.
 */
export function waitForCurrentTick(): Promise<void> {
  return inFlightPromise ?? Promise.resolve();
}

/**
 * Decide entre las dos ramas de `POLL_ENABLED` (Tarea 2, Paso 8 del flujo de arranque).
 *
 * Rama `true`: schedula `triggerTick` con `cron.schedule()` segun `config.poll.cron` — ya validado
 * por `cron.validate()` en el schema (S-007), asi que esta funcion no repite esa validacion. Nunca
 * se dispara un tick inmediato: el primero espera al primer disparo real del cron (CA-2) — es una
 * propiedad de `node-cron`, no de este codigo.
 *
 * Rama `false`: loguea el mensaje literal de deshabilitado y NO llama a `cron.schedule()` en
 * ningun camino. El proceso igual queda vivo, pero no por codigo de esta funcion — es el handle
 * abierto de la conexion al bus, heredado de otro modulo (CA-4).
 *
 * `cronScheduleFn` se recibe por parametro (default: `cron.schedule` real) para no mockear
 * `node-cron` a nivel de modulo en los tests — mismo patron que `imapFlowCtor` en
 * `infra/imap/client.ts`.
 */
export function scheduleTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  space: KvSpace,
  runTick: (
    config: AppConfig,
    logger: Logger,
    client: Client,
    space: KvSpace,
  ) => Promise<void> = runIngestaTick,
  cronScheduleFn: typeof cronSchedule = cronSchedule,
): ScheduledTask | undefined {
  if (!config.poll.enabled) {
    logger.info({}, 'poll deshabilitado: no se schedula ningún tick');
    return undefined;
  }

  return cronScheduleFn(config.poll.cron, () =>
    triggerTick(config, logger, client, space, runTick),
  );
}
