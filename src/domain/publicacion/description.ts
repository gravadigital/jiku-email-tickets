/**
 * Composicion deterministica de la `description` final del requisito, a partir de cuatro
 * bloques ya resueltos por el llamador: cuerpo base, avisos de rechazo, avisos de fallo de
 * subida, placeholders de archivo (siempre al final).
 *
 * Esta funcion es PURA y no conoce el origen de ninguna entrada (CA-10 de S-020): no sabe si un
 * aviso de rechazo vino de la politica local, de `core`, o del tope excedido; no sabe si un
 * placeholder es de imagen o no; no sabe si el cuerpo vino vacio. Todo eso ya lo resolvio el
 * llamador (S-021). No valida, no loguea, no lanza, no trunca -- es concatenacion de strings.
 *
 * **Orden fijo y sin excepcion (ADR-003): cuerpo base -> avisos de rechazo -> avisos de fallo de
 * subida -> placeholders al final.** Los placeholders SIEMPRE van ultimos, incluso si el cuerpo
 * base es a su vez el placeholder de cuerpo vacio de S-015 (`(mail sin contenido)`) -- son dos
 * conceptos distintos que solo comparten la palabra "placeholder".
 *
 * **Separador elegido: `'\n'` (salto de linea simple), tanto entre bloques como entre elementos
 * de una misma lista.** Es el mismo formato de texto plano que ya produce `buildRequirementPayload()`
 * en `mail-payload.ts` para `description` hoy, asi que no introduce un estilo nuevo. Para evitar
 * separadores colgantes cuando un bloque esta vacio (AC-3), la funcion arma un array con SOLO las
 * partes no vacias (el cuerpo, mas cada aviso, mas cada placeholder) y las une con `.join('\n')`
 * al final -- nunca concatena bloque por bloque con `+`, que dejaria un `\n` colgante cuando el
 * bloque siguiente esta vacio.
 */

export interface ComposicionDescripcionInput {
  readonly cuerpoBase: string;
  readonly avisosDeRechazo: readonly string[];
  readonly avisosDeFallo: readonly string[];
  readonly placeholders: readonly string[];
}

const SEPARADOR = '\n';

export function componerDescripcion(input: ComposicionDescripcionInput): string {
  const partes = [input.cuerpoBase, ...input.avisosDeRechazo, ...input.avisosDeFallo, ...input.placeholders];

  return partes.join(SEPARADOR);
}
