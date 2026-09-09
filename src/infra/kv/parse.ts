/**
 * El parseo compartido de un ENTERO POSITIVO leido de una entrada del KV.
 *
 * Vive extraido y no privado en un modulo porque los DOS buckets necesitan exactamente la misma
 * regla: el `projectId` del Mapa de Tickets (`ticket-map.ts`, S-025) y el `requirementId` del Mapa
 * de Hilos (`threads.ts`, S-026). Dos copias de la misma validacion divergen en el primer cambio, y
 * la que divergiria en silencio es la del bucket que se lee menos.
 *
 * El nombre es NEUTRAL respecto del dominio a proposito: ya no es "el projectId", es "el entero
 * positivo que un operador o el propio conector dejo en una clave del KV".
 *
 * El modulo no importa nada del bus, nada de la configuracion y nada del logger: es una funcion
 * pura sobre un string. Quien la llama decide que hacer con el `undefined` (loguear y saltear).
 */

/**
 * Parsea un entero seguro estrictamente positivo desde el texto crudo de una entrada del KV.
 *
 * `Number.parseInt` y NO `Number()` a secas: `Number('4.5')` da `4.5` y `Number('')` da `0`, asi
 * que la validacion posterior tendria que atrapar los dos casos igual, pero `parseInt` deja el
 * intento explicito.
 *
 * `Number.isSafeInteger` y no `Number.isInteger`: un id que no sobrevive el ida y vuelta a `double`
 * no es un id, es un valor corrupto.
 *
 * Devuelve `undefined` para todo lo que no sea un id valido: el `0`, los negativos, los no enteros,
 * y cualquier cosa que no sea numerica. El llamador loguea y saltea.
 */
export function parsePositiveId(raw: string): number | undefined {
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;

  // `parseInt('4.5')` devuelve `4`, que es un entero positivo valido y pasaria el chequeo de
  // arriba. La comparacion contra el texto original es lo que rechaza `'4.5'`, `'42abc'` y `'0x2a'`:
  // un valor que no se re-serializa identico no era un entero, era otra cosa que empezaba con uno.
  if (String(parsed) !== trimmed) return undefined;

  return parsed;
}
