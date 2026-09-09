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
 * DESVIACION DECLARADA DE ADR-006, introducida por S-026 (REQ-005): el catalogo pasa de CINCO
 * literales a SEIS con `hilo_desconocido`. La ADR quedo al dia en la misma story, asi que el texto
 * de la regla y esta union dicen lo mismo — si alguna vez divergen, el codigo no es la fuente.
 *
 * `es_respuesta` SE CONSERVA y no se depreca. Los dos motivos cubren cosas distintas a proposito, y
 * la distincion es exactamente lo que S-026 existe para preservar:
 *
 * - `hilo_desconocido`: *"esta respuesta apunta a un hilo que no conozco"* — el lookup al Mapa de
 *   Hilos SI se pudo hacer y ninguna referencia matcheo.
 * - `es_respuesta`: *"no pude averiguar a que hilo apunta"* — el bucket estaba inaccesible y el
 *   lookup no se pudo hacer. DESDE S-027 ese es su UNICO significado: una respuesta CON match ya
 *   no se descarta, se comenta (la clausula "y, mientras S-027 no exista, tambien el descarte de
 *   una respuesta CON match" dejo de valer). El motivo NO se depreca: el bucket inaccesible sigue
 *   ocurriendo y sigue necesitando su propio literal.
 *
 * Colapsarlos en uno solo borraria la unica senal que distingue un hilo desconocido de una consulta
 * imposible, que es la diferencia entre "cargar el hilo" y "arreglar el bucket".
 */
export type MotivoDescarte =
  | 'no_parseable'
  | 'sin_message_id'
  | 'es_respuesta'
  | 'sin_slug'
  | 'slug_no_mapeado'
  | 'hilo_desconocido';

/**
 * El resultado de `routeMail()`: el proyecto resuelto, la intencion de comentar, o el motivo del
 * descarte. TRES formas desde S-027 — hasta S-026 eran dos.
 *
 * LA TERCERA FORMA (`intencion: 'comentario'`, S-027) es una UNION DISCRIMINADA y no un
 * `MotivoDescarte` nuevo, y las tres condiciones que cumple son deliberadas:
 *
 * 1. Es discriminable por el typechecker sin castear (`'intencion' in route`), mismo patron que
 *    `ThreadLookupResult` en `infra/kv/threads.ts` y `UploadResultado` en `files.types.ts`.
 * 2. NO lleva `motivo`, porque NO ES UN DESCARTE. Meterla en el catalogo de motivos la haria
 *    loguearse como uno, que es exactamente lo que esta story deja de hacer.
 * 3. No rompe el `if (route.ok)` del tick, pero SI obliga a discriminar antes de llegar a
 *    `route.motivo` — con `ok: false` en dos variantes, `route.motivo` no compila hasta que se
 *    decida que hacer con la respuesta. Es el typechecker forzando a escribir la rama nueva, no un
 *    inconveniente a silenciar con un cast.
 *
 * `routeMail()` sigue siendo PURA Y SINCRONICA: la intencion es lo unico que la funcion puede
 * decidir con lo que sabe. El lookup asincrono al Mapa de Hilos vive en el tick, que ya es el
 * unico que compone modulos — `ruteo` no importa de `#infra/` ni de `#domain/publicacion/`.
 *
 * `slug?` (opcional) y no `slug: string | undefined` en la rama de descarte (CA-13): la diferencia
 * importa porque `slug?` permite omitir la clave por completo (`'slug' in result === false`),
 * mientras que `string | undefined` permitiria `{ motivo: 'sin_slug', slug: undefined }`, que
 * tecnicamente tiene la clave presente. El motivo `slug_no_mapeado` es el UNICO que la lleva: es el
 * dato que hace falta para cargar el slug al mapa (ADR-006). Ningun campo se llama `key` (CA-16):
 * `REDACT_PATHS` (`src/shared/log-redaction.ts`) incluye `'key'` y `'*.key'`, y un campo `key`
 * saldria como `[REDACTED]` en el log sin fallar y sin avisar.
 */
export type RouteResult =
  | { readonly ok: true; readonly projectId: number; readonly slug: string }
  | { readonly ok: false; readonly intencion: 'comentario' }
  | { readonly ok: false; readonly motivo: MotivoDescarte; readonly slug?: string };
