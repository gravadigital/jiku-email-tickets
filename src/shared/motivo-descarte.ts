/**
 * El catalogo cerrado de motivos de descarte y el resultado del ruteo.
 *
 * Vive en `shared` y no en `domain/ruteo` a proposito (REQ-003 SS Dependencias entre modulos):
 * `ingesta/normalize.ts` ya produce dos de los motivos (`no_parseable`, `sin_message_id`) y no
 * puede importar de `ruteo` sin invertir la direccion de dependencia que CA-1 protege (`config ->
 * ruteo`, nunca al reves). Si el tipo viviera en `ruteo`, `ingesta` no podria compartirlo sin ese
 * ciclo. `shared` es la hoja del arbol de dependencias que ambos modulos pueden importar sin que
 * ninguno dependa del otro.
 *
 * Esta story (S-013) solo CREA el lugar unico de definicion y lo usa en `RouteResult`. No cablea
 * `ingesta/normalize.ts` a este tipo -- su literal `motivo: 'sin_message_id'` sigue siendo un string
 * compatible con la union sin cambios. Cablear todos los productores explicitamente es trabajo de
 * integracion de S-014, que es la que compone `ingesta` + `ruteo` en el tick.
 */

/**
 * Union de string literals, no un `enum` de TypeScript: ADR-006 fija estos literales exactos en
 * minuscula porque son lo que se loguea tal cual. Un `enum` (numerico o con valores PascalCase)
 * romperia esa igualdad literal. Precedente en el propio codigo: `ConnectDiagnosis`
 * (`src/infra/bus/errors.ts`) y `PublishDiagnosis` (`src/domain/publicacion/publish-errors.ts`) son
 * ambos uniones de string literals para catalogos cerrados, nunca `enum`.
 *
 * DESVIACION DECLARADA DE ADR-006, introducida por S-026 (REQ-005): el catalogo paso de CINCO
 * literales a SEIS con `hilo_desconocido`. La ADR quedo al dia en la misma story.
 *
 * SEGUNDA DESVIACION DECLARADA DE ADR-006, introducida por REQ-008 (S-032): el catalogo pasa a SIETE
 * con `slug_no_consultable`. El texto de la ADR lo enmienda S-034, igual que S-026 hizo con
 * `hilo_desconocido`: hasta entonces la desviacion queda declarada aca, y una vez enmendada, si
 * alguna vez divergen, el codigo no es la fuente.
 *
 * `es_respuesta` SE CONSERVA y no se depreca. Los dos motivos cubren cosas distintas a proposito, y
 * la distincion es exactamente lo que S-026 existe para preservar:
 *
 * - `hilo_desconocido`: *"esta respuesta apunta a un hilo que no conozco"* — el lookup al Mapa de
 *   Hilos SI se pudo hacer y ninguna referencia matcheo.
 * - `es_respuesta`: *"no pude averiguar a que hilo apunta"* — el espacio estaba inaccesible y el
 *   lookup no se pudo hacer. DESDE S-027 ese es su UNICO significado: una respuesta CON match ya
 *   no se descarta, se comenta. El motivo NO se depreca: el espacio inaccesible sigue ocurriendo y
 *   sigue necesitando su propio literal.
 *
 * Colapsarlos en uno solo borraria la unica senal que distingue un hilo desconocido de una consulta
 * imposible, que es la diferencia entre "cargar el hilo" y "arreglar el bucket".
 *
 * `slug_no_consultable` frente a `slug_no_mapeado` es LA MISMA distincion, del lado del Mapa de
 * Tickets (REQ-008):
 *
 * - `slug_no_mapeado`: la consulta del slug SI se pudo hacer y el slug no esta (nunca se cargo, se
 *   borro, su valor esta mal formado, o el slug no puede ser clave). El arreglo es CARGAR EL SLUG.
 * - `slug_no_consultable`: la consulta del slug NO se pudo hacer (el `get()` rechazo: timeout,
 *   permisos, bucket, conexion). El arreglo es ARREGLAR EL KV. Tambien lleva el `slug`, para poder
 *   reconstruir esos mails desde la casilla.
 */
export type MotivoDescarte =
  | 'no_parseable'
  | 'sin_message_id'
  | 'es_respuesta'
  | 'sin_slug'
  | 'slug_no_mapeado'
  | 'hilo_desconocido'
  | 'slug_no_consultable';

/**
 * El resultado de `routeMail()`: la intencion de alta, la intencion de comentar, o el motivo del
 * descarte. TRES formas, y NINGUNA resuelve nada contra el KV.
 *
 * LAS DOS INTENCIONES son variantes de una UNION DISCRIMINADA y no un `MotivoDescarte`, y las
 * condiciones que cumplen son deliberadas:
 *
 * 1. Son discriminables por el typechecker sin castear (`'intencion' in route` y su valor), mismo
 *    patron que `ThreadLookupResult` y `TicketLookupResult` en `infra/kv/`.
 * 2. NO llevan `motivo`, porque NO SON DESCARTES. Meterlas en el catalogo de motivos las haria
 *    loguearse como uno.
 *
 * `intencion: 'alta'` (REQ-008, S-032) reemplaza a la vieja variante resuelta
 * `{ ok: true, projectId, slug }`: `routeMail()` ya no tiene el mapa, asi que devuelve el slug en
 * minusculas y el tick lo resuelve contra el Espacio KV con `lookupTicket()`. Es la misma forma con
 * la que REQ-005 saco el lookup del hilo de esta funcion (`intencion: 'comentario'`, S-027).
 *
 * `routeMail()` sigue siendo PURA Y SINCRONICA: la intencion es lo unico que la funcion puede
 * decidir con lo que sabe. Los lookups asincronos viven en el tick, que ya es el unico que compone
 * modulos — `ruteo` no importa de `#infra/` ni de `#domain/publicacion/`.
 *
 * `slug?` (opcional) y no `slug: string | undefined` en la rama de descarte (CA-13): la diferencia
 * importa porque `slug?` permite omitir la clave por completo (`'slug' in result === false`),
 * mientras que `string | undefined` permitiria `{ motivo: 'sin_slug', slug: undefined }`, que
 * tecnicamente tiene la clave presente. Desde S-032 `routeMail()` solo produce `sin_slug` por esta
 * rama; los descartes con `slug` (`slug_no_mapeado`, `slug_no_consultable`) los arma el tick. Ningun
 * campo se llama `key` (CA-16): `REDACT_PATHS` (`src/shared/log-redaction.ts`) incluye `'key'` y
 * `'*.key'`, y un campo `key` saldria como `[REDACTED]` en el log sin fallar y sin avisar.
 */
export type RouteResult =
  | { readonly ok: false; readonly intencion: 'alta'; readonly slug: string }
  | { readonly ok: false; readonly intencion: 'comentario' }
  | { readonly ok: false; readonly motivo: MotivoDescarte; readonly slug?: string };
