/**
 * El puerto de dominio que aisla el tick del cliente IMAP concreto.
 *
 * Tres operaciones, no dos. La convencion `testing` documentaba `fetchUnseen(max):
 * Promise<RawMessage[]>`, y esa firma no alcanza: no puede satisfacer a la vez el `warn` de
 * diferidos (necesita el TOTAL sin recortar, no un lote ya limitado), el marcado de a uno
 * inmediatamente despues de cada descarga (un `Promise<RawMessage[]>` resuelve el lote entero
 * antes de que el llamador pueda marcar nada), y el salteo sin marcar de una descarga fallida (con
 * el lote resuelto de antemano, un solo `fetch` que falla rechaza la promesa entera y aborta el
 * tick). Ver S-009 -> Diseno Tecnico -> "Por que tres operaciones y no la firma literal de la
 * convencion" para el detalle completo; la convencion se actualiza en la misma story (Tarea 5).
 *
 * Este archivo NO importa `imapflow` ni ningun simbolo de `infra/`: es dominio puro. El adaptador
 * real (`infra/imap/`) implementa esta interfaz; los tests inyectan un doble que tambien la
 * implementa, sin tocar red (CA-11).
 */

/**
 * Un mensaje descargado, sin parsear.
 *
 * `source` son los bytes RFC 822 completos y crudos — ningun `mailparser` corre en este puerto ni
 * en su adaptador. La normalizacion (`domain/ingesta/normalize.ts`, S-008) consume `source`.
 */
export interface RawMessage {
  readonly uid: number;
  readonly source: Buffer;
}

export interface MailSource {
  /**
   * Los UIDs `\Unseen` de la casilla, ordenados de mas nuevo a mas viejo (UID descendente).
   *
   * Devuelve el TOTAL, sin recortar a ningun maximo: el recorte al cap (`maxPerTick`) es del tick
   * (S-010), no de este puerto — es lo que hace observable el conteo de diferidos (`encontrados -
   * cap`) que RF-15 exige loguear. Este metodo no conoce `maxPerTick` en ninguna forma.
   */
  searchUnseen(): Promise<number[]>;

  /**
   * Descarga un mensaje por UID.
   *
   * Si la descarga falla, LANZA — no devuelve un valor parcial ni traga el error. El llamador (el
   * tick) es quien decide que hacer con el fallo: loguear `warn` y saltear ese UID SIN marcarlo
   * `\Seen`, para que el proximo tick lo reintente (sigue `\Unseen`).
   */
  fetch(uid: number): Promise<RawMessage>;

  /**
   * Marca un solo UID como `\Seen`.
   *
   * Se invoca de a uno, inmediatamente despues de una descarga exitosa — nunca en lote al final
   * del tick. Este puerto no ofrece ninguna variante que reciba un array de UIDs: el lote
   * convertiria un fallo a mitad de tick en mensajes reprocesados (ADR-001).
   */
  markSeen(uid: number): Promise<void>;
}
