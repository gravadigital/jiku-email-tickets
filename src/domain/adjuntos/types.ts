/**
 * Las estructuras del dominio de adjuntos (FG-4, S-017).
 *
 * Sin schema Zod (desviacion consciente y ya precedentada -- ver `MailAttachment` en
 * `src/domain/ingesta/types.ts`): estas estructuras son la SALIDA de funciones puras
 * (`particionar()`, `deduplicar()`, `aplicarTope()`), no un dato deserializado de un borde
 * externo. El borde real que si se valida con Zod es `envSchema` (las cuatro claves de
 * configuracion de la politica), no esto.
 */

/**
 * Un adjunto que paso la particion (`particionar()`), TODAVIA sin `checksum`: el checksum lo
 * calcula recien `deduplicar()` (Task 4), que es la unica etapa que necesita el hash para
 * comparar. Extiende explicitamente los campos de `MailAttachment`
 * (`src/domain/ingesta/types.ts`) que sobreviven a la particion -- `filename`, `mimeType`,
 * `content` -- ya con el nombre generado y el MIME por default resueltos si hacia falta (CA-3,
 * CA-4). `contentDisposition` y `contentId` no se propagan: ninguna story posterior (S-018, S-019)
 * los necesita para publicar `files.request-upload` ni para hacer el `PUT` -- no hay necesidad
 * funcional de cargarlos hasta aca (REQ-004, Contexto: "no se usan para nada").
 */
export interface AdjuntoParticionado {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer;
}

/**
 * Un adjunto deduplicado, con su `checksum` ya calculado (CA-6 de la story). Es lo que
 * `deduplicar()` y `aplicarTope()` producen y consumen -- el checksum sha256 que este modulo
 * calcula (`node:crypto`, sobre `content`) es exactamente el que S-018 va a mandar como
 * `checksum` en `files.request-upload` (ADR-003). NUNCA viene en el mail: es un dato que el
 * conector agrega, no que reenvia.
 */
export interface AdjuntoAceptado extends AdjuntoParticionado {
  readonly checksum: string;
}

/**
 * El catalogo cerrado de motivos de rechazo de un adjunto.
 *
 * Union de string literals, nunca un `enum` -- mismo criterio que `MotivoDescarte`
 * (`src/shared/motivo-descarte.ts`): "son lo que se loguea tal cual" (aunque el log concreto de
 * esta story lo agrega S-021, el motivo se define aca y viaja tal cual hasta ese log).
 *
 * Es un tipo PROPIO y nuevo, no una extension de `MotivoDescarte`: aquel es sobre el *mail*
 * (por que se descarta el mail entero), este es sobre un *adjunto individual* dentro de un mail
 * que si se procesa. Son conceptos distintos que comparten solo el patron, igual que `RouteResult`
 * es un tipo propio de `ruteo` aunque comparta el patron de union discriminada.
 */
export type ReglaRechazo =
  | 'extension'
  | 'mime'
  | 'tamano'
  | 'tamano_cero'
  | 'tope_excedido'
  | 'error_interno';

/**
 * Una entrada de rechazo de adjunto: exactamente estos tres campos (CA-5 de la story: "una entrada
 * `{ nombre, mime, regla }` para ese adjunto, sin ejecutar todavia ningun log ni composicion").
 *
 * Ningun campo se llama `key`: `REDACT_PATHS` (`src/shared/log-redaction.ts`) incluye `'key'` y
 * `'*.key'`, y un campo `key` saldria redactado en un log sin fallar y sin avisar (mismo cuidado
 * documentado en `RouteResult`).
 */
export interface AdjuntoRechazado {
  readonly nombre: string;
  readonly mime: string;
  readonly regla: ReglaRechazo;
}

/**
 * La forma comun de retorno de las etapas del pipeline: aceptados de un tipo (que varia por
 * etapa -- `particionar()` todavia no tiene checksum, `deduplicar()` y `aplicarTope()` si) mas
 * rechazados. Declarada una vez y parametrizada -- no repetida inline en cada firma.
 */
export interface ParticionResult<TAceptado = AdjuntoAceptado> {
  readonly aceptados: TAceptado[];
  readonly rechazados: AdjuntoRechazado[];
}
