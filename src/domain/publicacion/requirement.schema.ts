import { z } from 'zod';

/**
 * El contrato de `requirements.new`, del lado del conector.
 *
 * ESTE ARCHIVO ES LA UNICA DEFINICION DEL CONTRATO EN EL REPO. Verificado contra el SDK
 * instalado: `@gravadigital/jiku` no exporta ningun tipo ni schema con la forma del payload de
 * este comando —`command<T>()` recibe `payload?: unknown` y devuelve `reply.data` sin validarlo—
 * asi que no hay nada de donde derivarlo. De ahi que el tipo se INFIERA de este schema
 * (`requirement.types.ts`) en vez de escribirse a mano: dos declaraciones separadas divergirian
 * sin que nada falle, y lo que se publicaria al bus seria lo que dice el schema mientras el
 * compilador afirma otra cosa.
 */

/**
 * El maximo de `title`.
 *
 * El contrato del comando NO declara `maxLength`, pero la columna de Jiku es `varchar(255)`: un
 * titulo mas largo lo rechaza `core` con `invalid_fields`, o peor, lo trunca la base. Va como
 * constante exportada y no como literal porque FG-3 la necesita para TRUNCAR (ADR-003: "`title`
 * MUST truncarse a 255 caracteres antes de publicar"). Aca solo valida; alla trunca. Exportarla
 * ahora evita que FG-3 escriba un `255` literal en otro archivo.
 */
export const TITLE_MAX_LENGTH = 255;

/** Los cuatro tipos de requisito del contrato. */
export const REQUIREMENT_TYPES = ['funcionalidad', 'mejora', 'incidencia', 'otro'] as const;

/** Las cinco prioridades del contrato. */
export const REQUIREMENT_PRIORITIES = ['sin_prioridad', 'baja', 'media', 'alta', 'urgente'] as const;

/** Los dos niveles de visibilidad del contrato. */
export const REQUIREMENT_VISIBILITY_LEVELS = ['public', 'internal'] as const;

/**
 * El payload de `requirements.new`.
 *
 * `.strict()` y no un `z.object` normal, y la diferencia es el punto entero del schema: un
 * `z.object` DESCARTA las claves desconocidas en silencio, asi que un `actor` colado por error
 * seria silenciosamente removido en vez de fallar. Lo que se quiere es que FALLE — el schema es
 * tambien la documentacion ejecutable de las cuatro exclusiones de CA-3, y una exclusion que se
 * aplica sin avisar no documenta nada.
 *
 * Los enums NO llevan `.default()`, y es deliberado: este schema modela EL CONTRATO DE `core`
 * —donde los tres campos son requeridos— mientras que los valores elegidos (`incidencia`,
 * `sin_prioridad`, `public`) son POLITICA DEL CONECTOR y viven en el armado del payload. Con
 * defaults en el schema, `parseNewRequirement({})` produciria un payload "valido" a partir de
 * nada, que es exactamente lo que un validador de borde no debe hacer.
 */
export const newRequirementSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH),

    // Sin tope: es `text` en la base, no `varchar`.
    description: z.string().min(1),

    // `int` positivo. El valor entra ya validado desde la configuracion (`envSchema` declara
    // `JIKU_VERIFY_PROJECT_ID: z.coerce.number().int().positive()`), y esta validacion NO es
    // redundante: valida el borde del COMANDO, que es lo que efectivamente se publica.
    projectId: z.number().int().positive(),

    type: z.enum(REQUIREMENT_TYPES),
    priority: z.enum(REQUIREMENT_PRIORITIES),
    visibilityLevel: z.enum(REQUIREMENT_VISIBILITY_LEVELS),

    // OPCIONAL, agregado por S-015. `core` IGNORA este valor: resuelve el actor del `sub` del
    // subject (infalsificable, ADR-005), nunca de este campo. Es informativo y redundante por
    // diseno, no una fuente de verdad — y por eso es opcional: `buildVerificationPayload()` no lo
    // incluye y sigue siendo un payload valido. `actor` sigue siendo la UNICA clave de identidad
    // que el `.strict()` rechaza de plano.
    creator: z.string().min(1).optional(),

    // OPCIONAL, agregado por S-021 (FG-4). `.min(1)`: la clave AUSENTE es la representacion de
    // "cero adjuntos vinculados", nunca un array vacio -- `fileIds: []` se rechaza a proposito
    // (CA-3: "nunca se manda fileIds: []"). Quien arma el payload (`buildRequirementPayload()`)
    // es responsable de omitir la clave por completo cuando no hay ids, no de mandarla vacia.
    // `.max(10)`: documenta en el propio schema el `maxItems` del contrato, mismo criterio que
    // `TITLE_MAX_LENGTH` para `title` -- el tope en si ya lo aplica `aplicarTope()` (S-017), este
    // `.max()` es la garantia de borde de ESTE schema, no una segunda aplicacion del tope.
    // Sin `.default()`: mismo criterio que los enums de arriba, este campo modela el contrato de
    // `core`, no la politica del conector -- la condicionalidad de incluir la clave es
    // responsabilidad del llamador, no del schema.
    fileIds: z.array(z.number().int().positive()).min(1).max(10).optional(),
  })
  .strict();

/**
 * La respuesta de exito de `requirements.new`.
 *
 * Vive junto al schema del payload porque los dos son el contrato del MISMO comando: separarlos
 * haria que el proximo que agregue un campo a la respuesta busque en el archivo equivocado.
 *
 * Existe por un hallazgo verificado del SDK: `command<T>()` devuelve `reply.data` TAL CUAL, sin
 * comprobar que coincida con `T`. El generico es una asercion del llamador, no una garantia. Un
 * `core` que respondiera `{ status: 'success', data: {} }` produciria la linea de log que CA-1
 * exige con `requirementId: undefined` —formalmente presente, materialmente inutil— y sin que
 * nada falle. Por eso la respuesta se valida y una respuesta de exito sin `id` usable es un
 * FALLO, no un exito con hueco.
 *
 * `z.number()` y NO `z.coerce.number()`: con coercion, un `id: 'no-es-numero'` pasaria a `NaN` o
 * a un numero segun el string, y el caso que hay que detectar —`core` contestando con el tipo
 * equivocado— quedaria sin cubrir.
 */
export const newRequirementReplySchema = z
  .object({
    id: z.number().int().positive(),
  })
  // Sin `.strict()` aca, a proposito y por la razon inversa a la del payload: la respuesta la
  // manda `core`, y un campo nuevo que `core` empiece a enviar manana NO debe romper al conector.
  // El payload lo arma el conector y ahi la estrictez protege; la respuesta la recibe y ahi la
  // tolerancia protege.
  .loose();
