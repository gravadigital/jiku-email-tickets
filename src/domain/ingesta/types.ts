/**
 * Las estructuras del dominio que esta story define.
 *
 * Sin schema Zod (desviacion consciente y acotada, ver Story Plan S-008 -> Convenciones activas ->
 * `validation`): el borde real es `mailparser`, que ya devuelve una estructura tipada, y
 * `IncomingMail` es una estructura de SALIDA interna que nadie deserializa.
 */

export interface MailAttachment {
  readonly filename: string;
  /** Declarado por el mail, NUNCA verificado contra el contenido real (CA-17). */
  readonly mimeType: string;
  readonly size: number;
  readonly content: Buffer;
  readonly contentDisposition: string;
  readonly contentId?: string;
  // SIN checksum: es de FG-4. mailparser lo expone (MD5) pero no se propaga.
}

export interface IncomingMail {
  /** El unico campo obligatorio. Sin el, el mail se descarta (CA-1). */
  readonly messageId: string;
  /** Union deduplicada de `In-Reply-To` y `References`, en orden de aparicion. Vacio = mail nuevo. */
  readonly referenceIds: string[];
  /** Crudo: primer `Delivered-To`, con `To` como fallback. Vacio es valido. */
  readonly recipient: string;
  /** Aislado de `Nombre <mail>`. Nadie lo lee en v1 y nunca se loguea. */
  readonly senderEmail: string;
  /** Sin prefijos `Re:`/`Fwd:`/`RV:`. Vacio es valido. */
  readonly subject: string;
  /** Texto plano, con el citado recortado (heuristica best-effort). Vacio es valido. */
  readonly body: string;
  readonly attachments: MailAttachment[];
}
