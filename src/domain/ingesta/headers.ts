import type { AddressObject, ParsedMail } from 'mailparser';

/**
 * Funciones puras sobre headers de mail: `referenceIds`, `recipient` y `senderEmail`.
 *
 * Ports del servicio existente (`grava-gestion/mail-integration` v1.0.0, Arq-9), con dos ajustes
 * obligatorios: la correccion del `Delivered-To` multiple (ver `pickRecipient`), y las adaptaciones
 * que impone `noUncheckedIndexedAccess` (este servicio lo activa; el legacy no).
 */

/**
 * Union deduplicada de `In-Reply-To` y `References`, en orden de aparicion, con `In-Reply-To`
 * primero (CA-5).
 *
 * `references` tolera las tres formas que `mailparser` puede devolver: `string` cuando hay un solo
 * valor, `string[]` cuando hay varios, `undefined` cuando no hay ninguno (verificado). `Set`
 * preserva el orden de insercion, que es exactamente "orden de aparicion" -- no se ordena por nada
 * mas.
 */
export function mergeReferenceIds(
  inReplyTo: string | undefined,
  references: string | string[] | undefined,
): string[] {
  const ids: string[] = [];
  if (inReplyTo) ids.push(inReplyTo);

  const refs = references === undefined ? [] : Array.isArray(references) ? references : [references];
  for (const ref of refs) ids.push(ref);

  return [...new Set(ids)];
}

/** Lee un `AddressObject` o un array de ellos y devuelve el `.text` del primero. */
function firstAddressText(value: AddressObject | AddressObject[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return first?.text;
}

/**
 * El primer `Delivered-To`, con `To` como fallback, `''` si no hay ninguno (CA-6, CA-7, CA-9).
 *
 * `parsed.headers.get('delivered-to')` puede devolver un `AddressObject` (un solo header) o un
 * `AddressObject[]` (varios), verificado contra mailparser@3.9.17. Se toma A PROPOSITO **el
 * primero**: es el destinatario del salto mas reciente, el que conserva el subaddress (`+alfa`).
 *
 * El servicio existente los unia con `', '` cuando habia varios -- un `recipient` que no es una
 * direccion, y un defecto que sus tests no detectaban porque construian los headers a mano en vez
 * de parsear un `.eml` real (CA-8, verificado). Ese join NO se porta: "arreglar" esta funcion para
 * no perder el segundo valor rompe CA-8.
 *
 * `recipient` queda CRUDO: no se extrae ningun slug (eso es de FG-3).
 */
export function pickRecipient(parsed: Pick<ParsedMail, 'headers' | 'to'>): string {
  const deliveredTo = parsed.headers.get('delivered-to') as AddressObject | AddressObject[] | undefined;
  const fromDeliveredTo = firstAddressText(deliveredTo);
  if (fromDeliveredTo !== undefined) return fromDeliveredTo;

  const fromTo = firstAddressText(parsed.to);
  if (fromTo !== undefined) return fromTo;

  return '';
}

/** El mail entre `<` y `>` de un `From: Nombre <mail>`. */
const DISPLAY_NAME_EMAIL = /<([^>]+)>/;

/**
 * Aisla la direccion de cualquier header con forma `Nombre <mail@dominio>` (CA-10).
 *
 * No es especifica de `From`: se usa igual sobre `From` (`ingesta/normalize.ts`, para
 * `senderEmail`) y sobre `recipient` (`ruteo/route-mail.ts`, S-013), que es exactamente la misma
 * operacion de aislamiento sobre otro header. De ahi el nombre neutral al insumo -- se renombro
 * desde `extractSenderEmail` cuando `ruteo` empezo a necesitarla (S-013): mantener el nombre viejo
 * hubiera hecho que su uso sobre `recipient` mintiera sobre lo que hace.
 *
 * Preserva el casing original. Pura, nunca lanza.
 *
 * Bajo `noUncheckedIndexedAccess` (que el legacy no tenia), el grupo de captura
 * `displayNameMatch[1]` es `string | undefined`: se comprueba antes de usarlo y, si el regex
 * matcheo pero el grupo faltara (no deberia ocurrir con `[^>]+`), se cae al `from` completo en vez
 * de aplastarlo con `!`.
 */
export function extractAddress(from: string | undefined): string {
  if (!from) return '';
  const displayNameMatch = from.match(DISPLAY_NAME_EMAIL);
  const address = displayNameMatch?.[1] ?? from;
  return address.trim();
}
