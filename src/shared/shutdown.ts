/**
 * El apagado ordenado (S-011, CA-8/CA-9): al recibir `SIGTERM`/`SIGINT`, detiene el cron, espera
 * el tick en vuelo si lo hay, detiene el watch del Mapa de Tickets, cierra la conexion al bus, y
 * sale con codigo `0`.
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
  /**
   * Detiene el watch del Mapa de Tickets (S-025), o `undefined` si no hay ninguno (el modo de
   * verificacion no queda vivo, y los tests que no ejercitan el watch no tienen que fabricar uno).
   *
   * Va ANTES de `closeBus()` a proposito, y no es cosmetico: el watch introduce un loop de
   * background y un `setTimeout` de reintento, que son handles que pueden mantener el proceso vivo.
   * Con esta dependencia el apagado los baja EXPLICITAMENTE, en vez de depender de que el orden de
   * cierre del bus mate el iterador de rebote. El `setTimeout` del reintento ademas esta `unref()`
   * eado del lado del watch, como cinturon adicional.
   */
  readonly stopTicketMapWatch: (() => void) | undefined;
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
 * 3. `stopTicketMapWatch?.()` — si existe. Baja el loop de background del watch y cancela su
 *    reintento pendiente. Va ANTES de cerrar el bus: el watch corre SOBRE esa conexion, y bajarlo
 *    primero evita que el cierre del socket se le manifieste como una caida que programe un
 *    reintento sobre una conexion que ya no esta.
 * 4. `await closeBus()`.
 * 5. `exit(0)` — SIEMPRE despues de que closeBus() resolvio, nunca antes (evita perder logs por
 *    buffer, mismo criterio que `reportStartupFailure`).
 */
export function createShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  return async function shutdown(): Promise<void> {
    deps.scheduledTask?.stop();
    await deps.waitForCurrentTick();
    deps.stopTicketMapWatch?.();
    await deps.closeBus();
    deps.exit(0);
  };
}
