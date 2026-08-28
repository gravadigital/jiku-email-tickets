/**
 * El apagado ordenado (S-011, CA-8/CA-9): al recibir `SIGTERM`/`SIGINT`, detiene el cron, espera
 * el tick en vuelo si lo hay, cierra la conexion al bus, y sale con codigo `0`.
 *
 * Vive aca y no inline en `src/index.ts` para poder testearse invocando el handler DIRECTAMENTE
 * como funcion (CA-13: ningun test de esta pieza envia una senal real de sistema operativo ni
 * espera un timer real). Las dependencias reales (`ScheduledTask.stop()`, `closeBus()`,
 * `waitForCurrentTick()`, `process.exit`) se reciben todas por parametro, con los defaults de
 * produccion aplicados por el llamador en `src/index.ts` — este modulo no importa `node:process`
 * ni `#infra/bus/connection.js` para poder mantenerse puro y facil de doblar en tests.
 */

export interface ShutdownDeps {
  /**
   * La tarea programada por `cron.schedule()`, o `undefined` si `POLL_ENABLED` era `false` (no
   * hay ninguna tarea que detener, pero el apagado ordenado sigue corriendo igual: siempre hay
   * que cerrar el bus).
   */
  readonly scheduledTask: { stop(): void | Promise<void> } | undefined;
  /** Espera a que el tick en vuelo (si hay uno) termine. Nunca lo cancela. */
  readonly waitForCurrentTick: () => Promise<void>;
  /** Cierra la conexion al bus. */
  readonly closeBus: () => Promise<void>;
  /** Sale del proceso con el codigo indicado. */
  readonly exit: (code: number) => void;
}

/**
 * Arma el handler de apagado ordenado con las dependencias dadas.
 *
 * Secuencia, en este orden exacto (Escenario C de la story):
 * 1. `scheduledTask?.stop()` — si existe. No dispara mas ticks nuevos. Sin efecto si el poll
 *    estaba deshabilitado (no hay tarea).
 * 2. `await waitForCurrentTick()` — espera INCONDICIONALMENTE el tick en vuelo, si lo hay. Nunca
 *    lo cancela ni le pone un timeout propio: cancelarlo a mitad de `fetch`/`markSeen` es
 *    exactamente la perdida silenciosa que el diseño evita (CA-9).
 * 3. `await closeBus()`.
 * 4. `exit(0)` — SIEMPRE despues de que closeBus() resolvio, nunca antes (evita perder logs por
 *    buffer, mismo criterio que `reportStartupFailure`).
 */
export function createShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  return async function shutdown(): Promise<void> {
    deps.scheduledTask?.stop();
    await deps.waitForCurrentTick();
    await deps.closeBus();
    deps.exit(0);
  };
}
