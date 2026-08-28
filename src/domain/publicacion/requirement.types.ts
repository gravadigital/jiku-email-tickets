import type { z } from 'zod';

import type { newRequirementReplySchema, newRequirementSchema } from '#domain/publicacion/requirement.schema.js';

/**
 * Los tipos del contrato de `requirements.new`, INFERIDOS del schema.
 *
 * La convencion `validation` lo exige y CA-4 lo repite: los tipos se infieren con `z.infer`, y
 * escribir a mano un tipo que duplique el schema esta prohibido. No es estilo — un tipo paralelo
 * al schema puede divergir de el sin que nada falle, y entonces el compilador afirma una forma
 * mientras al bus viaja otra.
 */

/** El payload del comando. */
export type NewRequirementPayload = z.infer<typeof newRequirementSchema>;

/** La respuesta de exito del comando, ya validada. */
export type NewRequirementReply = z.infer<typeof newRequirementReplySchema>;
