import { createHash } from 'node:crypto';

import { assertValidKVKey } from '@gravadigital/jiku';

/**
 * Las claves del Espacio KV: el UNICO lugar de `src/` que las arma (REQ-008, CA-8).
 *
 * Modulo puro: no hace I/O, no lee configuracion y no importa nada de `#config/`.
 *
 * =============================================================================================
 * POR QUE ESTE MODULO EXISTE, Y LO QUE UN REFACTOR BIENINTENCIONADO ROMPERIA.
 * =============================================================================================
 *
 * EL CONECTOR MANEJA SOLO LA PARTE DE LA DERECHA.
 *
 * La clave completa en `JIKU_KV` es `{instance}.{userId}.tickets.alfa`. El prefijo
 * `{instance}.{userId}.` lo agrega y lo quita el SDK, y es lo que confina al conector a su propio
 * espacio (invariante 31). Aca solo se arma `tickets.alfa` / `hilos.<hash>`: agregarle la instancia
 * o el `userId` "para que se vea la clave entera" duplicaria el prefijo.
 *
 * LOS PREFIJOS SON CONSTANTES DEL CODIGO, NO CONFIGURACION.
 *
 * Cambiar `tickets.` o `hilos.` deja huerfanas TODAS las entradas cargadas: los slugs que el
 * operador cargo dejarian de resolver y los hilos dejarian de rutear, sin ningun error. Si fueran
 * una variable de entorno, un typo bastaria para eso. Hay un test que afirma que ninguna variable
 * `KV_*` existe en el schema.
 *
 * LAS REGLAS DE CLAVE SON LAS DEL SDK.
 *
 * `isStorableSlug()` delega en `assertValidKVKey()` del SDK, que aplica las reglas de NATS. Copiar
 * esas reglas aca (un regex propio) las haria divergir en silencio el dia que el SDK las ajuste, y
 * un slug que el conector cree valido terminaria en un `JikuInvalidRequest` en caliente.
 */

/** Prefijo FIJO del Mapa de Tickets: `tickets.<slug>` → `projectId`. */
export const TICKETS_KEY_PREFIX = 'tickets.';

/** Prefijo FIJO del Mapa de Hilos: `hilos.<sha256(Message-Id)>` → `requirementId`. */
export const THREADS_KEY_PREFIX = 'hilos.';

/**
 * El sha256 en hex del valor TAL CUAL se lo pasan.
 *
 * RAZON 1 — POR QUE EL HASH Y NO EL `Message-Id` (se mudo aca desde `threads.ts` en S-032).
 *
 * Las reglas de clave de `assertValidKVKey()` (las de NATS: `[A-Za-z0-9\-/_=.]`, sin comodines)
 * RECHAZAN `<`, `>` y `@` — los tres presentes en un `Message-Id` real (`<abc@cliente.com>`). La
 * defensa es no producir nunca una clave invalida.
 *
 * La alternativa obvia —normalizar y escapar el `Message-Id` para que entre en las reglas— NO se
 * implementa, y no por comodidad: permitiria que dos `Message-Id` distintos colapsen a la misma
 * clave y RUTEEN UN COMENTARIO AL REQUISITO EQUIVOCADO, que viola G-04. Que la clave no se lea a
 * simple vista (son 64 chars de hex) es un riesgo ACEPTADO EXPLICITAMENTE; la legibilidad no vale
 * un comentario en el ticket de otro cliente.
 *
 * Corolario: sin `trim()`, sin `toLowerCase()`, sin normalizacion de ninguna clase (invariante 23).
 * El hash va sobre el `Message-Id` CRUDO, con sus brackets, tal como `mailparser` lo entrega.
 * Cualquier normalizacion agregada aca reintroduce el colapso de claves que el hash existe para
 * prohibir.
 *
 * 64 chars de `[0-9a-f]`, validos por construccion.
 */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** `'alfa'` → `'tickets.alfa'`. El slug llega YA en minusculas (lo normaliza `routeMail()`). */
export function ticketKey(slug: string): string {
  return TICKETS_KEY_PREFIX + slug;
}

/** `'<abc@cliente.com>'` → `'hilos.' + sha256hex('<abc@cliente.com>')`, sin normalizar. */
export function threadKey(messageId: string): string {
  return THREADS_KEY_PREFIX + sha256hex(messageId);
}

/**
 * Si el slug puede ser clave del espacio. NUNCA LANZA.
 *
 * Un slug que no puede ser clave (`a+b`, `al..fa`, con acentos) nunca pudo cargarse en el KV, asi
 * que `lookupTicket()` lo resuelve como "no esta" SIN round-trip: es un `slug_no_mapeado`, no un
 * fallo de consulta (REQ-008, Riesgo 7).
 */
export function isStorableSlug(slug: string): boolean {
  try {
    assertValidKVKey(ticketKey(slug));
    return true;
  } catch {
    return false;
  }
}
