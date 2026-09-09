import type { z } from 'zod';

import type { commentReplySchema, commentSchema } from '#domain/publicacion/comment.schema.js';

/**
 * Los tipos del contrato de `requirements.{id}.comment`, INFERIDOS de los schemas.
 *
 * La convencion `validation` lo exige: los tipos se infieren con `z.infer`, y escribir a mano un
 * tipo que duplique el schema esta prohibido. No es estilo — un tipo paralelo al schema puede
 * divergir de el sin que nada falle, y entonces el compilador afirma una forma mientras al bus
 * viaja otra.
 */

/** El payload del comando. */
export type CommentPayload = z.infer<typeof commentSchema>;

/** La respuesta de exito del comando, ya validada. */
export type CommentReply = z.infer<typeof commentReplySchema>;
