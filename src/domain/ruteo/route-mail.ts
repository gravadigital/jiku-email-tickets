import type { RuteoConfig } from '#config/index.js';
import { extractAddress } from '#domain/ingesta/headers.js';
import type { IncomingMail } from '#domain/ingesta/types.js';
import type { RouteResult } from '#shared/motivo-descarte.js';

/**
 * Escapa los caracteres especiales de regex antes de interpolar el prefijo configurable en el
 * patron del subaddress. Un prefijo con caracteres especiales (aunque no esta en alcance de
 * configuracion tipica) no debe romper la construccion del patron.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resuelve el proyecto de un mail entrante, o el motivo por el que se descarta.
 *
 * Funcion PURA: no importa nada de `#domain/ingesta` salvo `extractAddress` (reutilizada, no
 * reescrita -- CA-3) y el tipo `IncomingMail` (solo forma del primer parametro); no importa nada de
 * `#domain/publicacion`. Sin esa direccion invertida, el sentido de la flecha es siempre
 * `config -> ruteo`, y el tick (S-014) es el unico que compone `ingesta`, `ruteo` y `publicacion`
 * (CA-1).
 *
 * Nunca lanza: todo camino negativo es un valor de retorno tipado (`RouteResult` de descarte), no
 * una excepcion. Un `recipient` malformado no es un error del ruteo, es un `sin_slug`.
 *
 * Nunca loguea: el ruteo decide, el tick reporta (S-014). El camino feliz en particular no emite
 * ninguna linea -- la linea del alta la emite la publicacion (ADR-006 pide una linea por mail).
 *
 * Orden de evaluacion -- descarta lo mas barato primero (CA-8):
 *
 * 1. `referenceIds.length > 0` -> LA INTENCION DE COMENTAR (`{ ok: false, intencion: 'comentario' }`,
 *    S-027). ANTES de tocar el slug: una respuesta no gasta el regex ni el lookup, y la consecuencia
 *    OBSERVABLE de ese orden es que EL SLUG NO SE EVALUA NUNCA PARA UNA RESPUESTA -- una respuesta a
 *    un hilo conocido se comenta aunque su `recipient` no resuelva ningun slug valido. Basta con que
 *    `referenceIds` no este vacio, sin importar a que apunten las referencias: quien decide si el
 *    hilo se conoce es el LOOKUP DEL TICK, no esta funcion.
 *
 *    HASTA S-026 esta rama devolvia `{ ok: false, motivo: 'es_respuesta' }` y toda respuesta se
 *    descartaba. Lo que devuelve ahora NO ES UN DESCARTE y por eso no lleva `motivo`: es una
 *    intencion que el tick resuelve con `lookupThread()`. El falso positivo del reenvio sigue
 *    existiendo (un hilo interno reenviado con `References` poblado), pero ya no termina en un
 *    descarte automatico: termina en un lookup que no matchea, y el tick lo descarta como
 *    `hilo_desconocido`. La decision 9 del PRD quedo derogada por REQ-005.
 *
 *    Y EL LOOKUP NO VIVE ACA, ni debe: es asincrono y toca `#infra/kv`, y esta funcion es pura,
 *    sincronica y sin logging. Meterlo aca seria la "simplificacion" mas tentadora y la que rompe
 *    la direccion de dependencias que esta cabecera documenta.
 * 2. Aislar el email del `recipient` crudo (`extractAddress`, CA-3), aplicar
 *    `^<prefijo>\+([^@]+)@` case-insensitive, normalizar el slug capturado a minusculas. Si el
 *    `recipient` esta vacio, no matchea, o el slug queda vacio -> `sin_slug` (CA-5, CA-11). El slug
 *    se captura ENTERO entre `+` y `@`, sin validar su forma (CA-5).
 * 3. `!ticketMap.has(slug)` -> `slug_no_mapeado`, con el slug incluido (CA-12, CA-13): es el unico
 *    motivo que lo lleva -- el dato que hace falta para cargarlo al mapa.
 * 4. Resuelto -> `{ ok: true, projectId, slug }`. El `ticketMap` ya llego normalizado a minusculas
 *    desde S-012; el lookup en caliente es un `Map.get()` sin transformar el mapa.
 */
export function routeMail(
  mail: Pick<IncomingMail, 'referenceIds' | 'recipient'>,
  config: Pick<RuteoConfig, 'ticketMap' | 'subaddressPrefix'>,
): RouteResult {
  if (mail.referenceIds.length > 0) {
    return { ok: false, intencion: 'comentario' };
  }

  const address = extractAddress(mail.recipient);
  const subaddressPattern = new RegExp(`^${escapeRegExp(config.subaddressPrefix)}\\+([^@]+)@`, 'i');
  const match = address.match(subaddressPattern);
  const capturedSlug = match?.[1];

  if (!capturedSlug) {
    return { ok: false, motivo: 'sin_slug' };
  }

  const slug = capturedSlug.toLowerCase();
  const projectId = config.ticketMap.get(slug);

  if (projectId === undefined) {
    return { ok: false, motivo: 'slug_no_mapeado', slug };
  }

  return { ok: true, projectId, slug };
}
