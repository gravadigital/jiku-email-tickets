import { simpleParser } from 'mailparser';
import type { Logger } from 'pino';

import { toPlainText, trimQuotedText } from '#domain/ingesta/body.js';
import { MissingMessageIdError } from '#domain/ingesta/errors.js';
import { extractSenderEmail, mergeReferenceIds, pickRecipient } from '#domain/ingesta/headers.js';
import { cleanSubject } from '#domain/ingesta/subject.js';
import type { IncomingMail, MailAttachment } from '#domain/ingesta/types.js';

/**
 * Normaliza los bytes RFC 822 crudos de un mail a la forma de trabajo estable `IncomingMail`.
 *
 * Funcion pura sobre bytes: sin red, sin reloj, sin I/O propio salvo el parseo de `mailparser`. No
 * persiste nada (ADR-001) y no cuenta, no marca `\Seen` ni emite la linea de resultado por mail --
 * eso es responsabilidad del tick (S-010, ver Story Plan -> Flow Context -> contrato con el
 * llamador).
 *
 * `logger` llega POR PARAMETRO y no por `getLogger()`: mismo criterio que
 * `publishVerificationRequirement()` (S-005). `getLogger()` es un singleton de proceso que lanza si
 * se usa antes de `initLogger()`, y una funcion nominalmente pura no puede depender de ese arranque
 * para poder testearse. El unico punto de log de esta story -- el descarte por `sin_message_id` --
 * vive ACA y no en el tick (S-010), porque el tick todavia no existe y la story pide que el warn
 * exista igual.
 *
 * Si `simpleParser` lanza (mail no parseable), esta funcion PROPAGA: no hay `IncomingMail`
 * degradado. Si el mail parsea pero no tiene `Message-Id`, loguea el `warn` del descarte y lanza
 * `MissingMessageIdError`: es un DESCARTE con motivo conocido, distinto de un fallo de parseo, y el
 * tick los cuenta distinto (`descartados` vs. `fallidos`).
 */
export async function normalize(raw: Buffer, logger: Logger): Promise<IncomingMail> {
  // `skipHtmlToText: true` NO es opcional: sin esta opcion, mailparser FABRICA `parsed.text` desde
  // el HTML para un mail solo-HTML, y esa sintesis rompe CA-11 y CA-12 en silencio (verificado
  // contra mailparser@3.9.17 -- ver Story Plan -> Integration Points -> HALLAZGO CRITICO). Con la
  // opcion activa, `parsed.text` refleja UNICAMENTE una parte `text/plain` real.
  const parsed = await simpleParser(raw, { skipHtmlToText: true });

  if (parsed.messageId === undefined) {
    // Objeto primero, mensaje estatico despues (convencion `logging`). `motivo: 'sin_message_id'`
    // es EL LITERAL EXACTO de uno de los cinco valores que ADR-006 enumera -- catalogo cerrado, no
    // se inventa una variante. Sin body/subject/senderEmail: ninguno de los tres se conoce todavia
    // en este punto (el descarte ocurre antes de componer el IncomingMail) y ninguno iria de
    // cualquier forma (CA-18).
    logger.warn({ motivo: 'sin_message_id' }, 'mail descartado');
    throw new MissingMessageIdError();
  }

  const body = trimQuotedText(toPlainText(parsed));

  const attachments: MailAttachment[] = parsed.attachments.map((attachment) => ({
    // Fallback 'unnamed': un adjunto sin filename declarado no puede quedar con un campo
    // `undefined` -- IncomingMail lo declara `readonly filename: string`, no opcional.
    filename: attachment.filename ?? 'unnamed',
    // Declarado por el mail, sin verificar contra el contenido real (CA-17).
    mimeType: attachment.contentType,
    size: attachment.size,
    content: attachment.content,
    contentDisposition: attachment.contentDisposition,
    contentId: attachment.contentId,
    // SIN checksum: mailparser lo expone (MD5) pero no se propaga. Es de FG-4.
  }));

  return {
    messageId: parsed.messageId,
    referenceIds: mergeReferenceIds(parsed.inReplyTo, parsed.references),
    recipient: pickRecipient(parsed),
    senderEmail: extractSenderEmail(parsed.from?.text),
    subject: cleanSubject(parsed.subject ?? ''),
    body,
    attachments,
  };
}
