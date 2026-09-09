import { z } from 'zod';

/**
 * El contrato de `requirements.{id}.comment`, del lado del conector.
 *
 * ESTE ARCHIVO ES LA UNICA DEFINICION DEL CONTRATO EN EL REPO, por la misma razon verificada que
 * `requirement.schema.ts`: `@gravadigital/jiku` no exporta ningun tipo ni schema con la forma del
 * payload de este comando —`command<T>()` recibe `payload?: unknown` y devuelve `reply.data` sin
 * validarlo— asi que NO HAY DE DONDE DERIVARLO. De ahi que los tipos se INFIERAN de estos schemas
 * (`comment.types.ts`) en vez de escribirse a mano.
 */

/**
 * El maximo de `fileIds` (`FileIds.maxItems` del contrato).
 *
 * Va como constante exportada y no como literal suelto, mismo criterio que `TITLE_MAX_LENGTH`: el
 * tope es una REGLA DE DOMINIO (ADR-003, D-20 del contrato — dejo de ser un limite de transporte de
 * `multer` y paso a ser el `maxItems` del bus), y una regla de dominio escrita como literal en dos
 * archivos diverge sin que nada falle.
 */
export const COMMENT_FILE_IDS_MAX = 10;

/**
 * Los dos niveles de visibilidad del contrato.
 *
 * `REQUIREMENT_VISIBILITY_LEVELS` de `requirement.schema.ts` NO SE IMPORTA aunque tenga hoy los
 * mismos dos literales: son DOS CONTRATOS DISTINTOS que coinciden por ahora, y acoplarlos haria que
 * un cambio en el enum de un comando arrastrara al otro sin que nadie lo decida.
 */
export const COMMENT_VISIBILITY_LEVELS = ['public', 'internal'] as const;

/**
 * El payload de `requirements.{id}.comment`.
 *
 * CUATRO DECISIONES CONTRAINTUITIVAS, cada una con su razon, porque las cuatro se "corrigen" solas
 * si no estan explicadas:
 *
 * 1. **`.strict()` y no un `z.object` normal.** Un `z.object` DESCARTA las claves desconocidas EN
 *    SILENCIO, asi que un `author` o un `actor` colado por error seria removido sin avisar en vez
 *    de fallar. Lo que se quiere es que FALLE: el schema es tambien la documentacion ejecutable de
 *    las exclusiones de CA-4, y una exclusion que se aplica sin avisar no documenta nada.
 *
 * 2. **`author` NO ESTA en el schema.** El contrato lo declara opcional, pero `core` resuelve el
 *    actor del `sub` del subject —infalsificable— y lo ignora (ADR-005). El criterio difiere a
 *    proposito del de `creator` en `requirements.new`, que SI se manda: a `creator` lo pidio
 *    REQ-004 explicitamente como redundancia informativa, y a `author` NO LO PIDIO NADIE. Mandarlo
 *    no seria incorrecto, pero agregaria una clave que nadie decidio mandar. Al no estar y ser
 *    `.strict()`, mandarlo FALLA.
 *
 * 3. **`visibilityLevel` es REQUERIDO aca aunque el contrato lo declare opcional, y SIN
 *    `.default()`.** Es el punto mas delicado del schema. El default del contrato es `internal`,
 *    que es **EL OPUESTO** del que hace falta: un comentario `internal` NO LO VERIA EL CLIENTE EN
 *    OPUS, y `core` responderia `success` igual — un fallo silencioso y total. El schema modela lo
 *    que el conector manda, y el conector lo manda SIEMPRE. Si fuera opcional, un armador que se
 *    olvidara de ponerlo produciria un payload "valido" con el efecto equivocado. Es el mismo
 *    razonamiento por el que el schema del alta no pone `.default()` —la politica vive en el
 *    armado, no en el schema— llevado un paso mas alla, porque aca el default del contrato es el
 *    contrario del correcto.
 *
 * 4. **`fileIds` es `.min(1)` y opcional, nunca `.default([])`.** La clave AUSENTE es la
 *    representacion de "cero adjuntos vinculados"; `fileIds: []` se rechaza a proposito. Mismo
 *    criterio literal que `requirement.schema.ts`, y quien arma el payload es responsable de
 *    OMITIR LA CLAVE POR COMPLETO, nunca de mandarla vacia.
 */
export const commentSchema = z
  .object({
    // Sin tope: es el texto de un comentario, y la composicion de `componerDescripcion()` no
    // trunca. `.min(1)` porque `core` lo declara requerido y un comentario vacio no es un
    // comentario.
    comment: z.string().min(1),

    visibilityLevel: z.enum(COMMENT_VISIBILITY_LEVELS),

    fileIds: z.array(z.number().int().positive()).min(1).max(COMMENT_FILE_IDS_MAX).optional(),
  })
  .strict();

/**
 * La respuesta de exito de `requirements.{id}.comment` (`ReplyWithId` del contrato).
 *
 * Vive junto al schema del payload porque los dos son el contrato del MISMO comando.
 *
 * Existe por el mismo hallazgo verificado que motiva la validacion en `publish-requirement.ts`:
 * `command<T>()` devuelve `reply.data` TAL CUAL, sin comprobar que coincida con `T`. El generico es
 * una asercion del llamador, no una garantia. Una respuesta de exito sin `id` usable es un FALLO,
 * no un exito con hueco.
 *
 * `z.number()` y NO `z.coerce.number()`: con coercion, un `id: 'no-es-numero'` pasaria a `NaN` o a
 * un numero segun el string, y el caso que hay que detectar —`core` contestando con el tipo
 * equivocado— quedaria sin cubrir.
 *
 * Y `.loose()`, SIN `.strict()`, por la razon INVERSA a la del payload: la respuesta la manda
 * `core`, y un campo nuevo que empiece a enviar manana NO debe romper al conector. El payload lo
 * arma el conector y ahi la estrictez protege; la respuesta la recibe y ahi la tolerancia protege.
 */
export const commentReplySchema = z
  .object({
    id: z.number().int().positive(),
  })
  .loose();
