/**
 * El catalogo cerrado de motivos de descarte y el resultado del ruteo.
 *
 * Vive en `shared` y no en `domain/ruteo` a proposito (REQ-003 SS Dependencias entre modulos):
 * `ingesta/normalize.ts` ya produce dos de los cinco motivos (`no_parseable`, `sin_message_id`) y no
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
 * Union de string literals, no un `enum` de TypeScript: ADR-006 fija estos cinco literales exactos
 * en minuscula porque son lo que se loguea tal cual. Un `enum` (numerico o con valores PascalCase)
 * rompería esa igualdad literal. Precedente en el propio codigo: `ConnectDiagnosis`
 * (`src/infra/bus/errors.ts`) y `PublishDiagnosis` (`src/domain/publicacion/publish-errors.ts`) son
 * ambos uniones de string literals para catalogos cerrados, nunca `enum`.
 */
export type MotivoDescarte =
  | 'no_parseable'
  | 'sin_message_id'
  | 'es_respuesta'
  | 'sin_slug'
  | 'slug_no_mapeado';

/**
 * El resultado de `routeMail()`: o el proyecto resuelto, o el motivo del descarte.
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
  | { readonly ok: false; readonly motivo: MotivoDescarte; readonly slug?: string };
