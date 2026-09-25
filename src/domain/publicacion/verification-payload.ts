import { newRequirementSchema } from '#domain/publicacion/requirement.schema.js';
import type { NewRequirementPayload } from '#domain/publicacion/requirement.types.js';
import { AppError } from '#shared/errors/index.js';

/**
 * El payload FIJO del modo de verificacion, y el parseo del contrato.
 *
 * Fijo y literal del codigo a proposito: el modo de verificacion existe para probar que el
 * conector puede ESCRIBIR en Jiku, y un payload derivado de una entrada variable mezclaria el
 * fallo del plano de escritura con el fallo del armado. El payload derivado del mail llega con
 * FG-3, que reemplaza esta funcion sin tocar nada de lo que la rodea.
 */

/**
 * El titulo del requisito de prueba.
 *
 * El texto dice que es una prueba de despliegue porque EL REQUISITO QUEDA PARA SIEMPRE: no hay
 * comando de compensacion y un requisito creado no se modifica ni se borra (invariante 9). Quien
 * lo encuentre en el proyecto de Jiku tiene que poder reconocer de inmediato que no es trabajo
 * real, sin preguntarle a nadie.
 */
export const VERIFY_TITLE = '[verificacion de despliegue] jiku-email-tickets';

/** La descripcion del requisito de prueba. Misma razon que el titulo: se lee sola. */
export const VERIFY_DESCRIPTION =
  'Requisito generado por el modo de verificacion de jiku-email-tickets (npm run verify) para ' +
  'comprobar que el conector puede publicar comandos en el bus de Jiku. No es un requisito real ' +
  'y se puede ignorar. El conector no tiene comando de compensacion, asi que no puede borrarlo ' +
  'ni modificarlo: cada corrida deja uno nuevo.';

/** Los defaults del CONECTOR (no del contrato: en el contrato los tres son requeridos). */
export const VERIFY_TYPE = 'incidencia';
export const VERIFY_PRIORITY = 'sin_prioridad';
export const VERIFY_VISIBILITY_LEVEL = 'public';

/**
 * Arma el payload fijo del modo de verificacion.
 *
 * Se construye como UN LITERAL COMPLETO, sin mutaciones ni spreads condicionales. No es estetica:
 * un literal es lo que hace que `Object.keys(payload)` sea afirmable y que la ausencia de las
 * cuatro claves excluidas sea visible LEYENDO el codigo, que es donde alguien iria a "completar"
 * lo que cree que falta.
 */
export function buildVerificationPayload(projectId: number): NewRequirementPayload {
  return {
    title: VERIFY_TITLE,
    description: VERIFY_DESCRIPTION,

    // De la CONFIGURACION (`config.verifyProjectId`), nunca un literal: el proyecto de prueba lo
    // elige el operador de cada despliegue y cada corrida le deja un requisito permanente.
    projectId,

    type: VERIFY_TYPE,
    priority: VERIFY_PRIORITY,
    visibilityLevel: VERIFY_VISIBILITY_LEVEL,

    // Y ACA TERMINA EL OBJETO. Las cuatro claves que NO estan, cada una por una razon distinta,
    // comentadas justo donde alguien las agregaria:
    //
    // - `state`:    NO va. El requisito nace en `analisis`, que es el default de Jiku
    //               (invariante 6, ADR-003). Declararlo seria fijar como politica del conector
    //               algo que es politica de Jiku.
    // - `actor`:    NO va. Es la UNICA clave de identidad que el plano de escritura rechaza de
    //               plano (invariante 18, ADR-005). `core` resuelve el actor del `sub` del
    //               subject, que es infalsificable. Tiene dos guardas deliberadas: el `.strict()`
    //               del schema y el chequeo LOCAL del SDK, que rechaza con `JikuInvalidRequest`
    //               antes de tocar la red.
    // - `fileIds`:  NO va. Se envia solo si hay al menos uno (ADR-003) y aca no hay adjuntos. El
    //               byte del adjunto y `files.request-upload` son de FG-4.
    // - `creator`:  NO va ACA -- pero desde S-015 SI se envia en el payload derivado del mail
    //               (`mail-payload.ts`), con `client.userId`. La clave sigue siendo opcional en el
    //               schema, asi que este payload fijo sigue siendo valido sin ella. `core` la
    //               IGNORA: resuelve el actor del `sub` del subject, que es infalsificable
    //               (ADR-005). Enviarla es REDUNDANTE POR DISEÑO y no una fuente de verdad -- no es
    //               inutil ni engañoso, es informativo y el request lo pide explicitamente (RF-32).
    //               La clave que SIGUE PROHIBIDA de plano, en cualquier payload, es `actor`: es la
    //               unica que el `.strict()` del schema y el chequeo local del SDK rechazan.
  };
}

/**
 * El payload no valido contra el contrato del comando.
 *
 * Existe como clase y no como `throw new Error(...)` porque la convencion `_base` lo prohibe en
 * codigo de dominio, y porque el borde de este servicio es el log: un error tipado con `code`
 * estable es lo que hace la linea agrupable.
 */
export class RequirementValidationError extends AppError {
  readonly code = 'REQUIREMENT_VALIDATION_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. Mismo patron que `KeyLoadError` y `BusConnectError`: 500
  // porque un payload invalido armado por el propio conector es un fallo del conector.
  readonly httpStatus = 500;

  /**
   * Las RUTAS de los campos invalidos. Nunca sus valores.
   *
   * La distincion es de seguridad y no de prolijidad: en FG-3 el payload deriva del mail, y
   * `title`/`description` NO estan en `REDACT_PATHS` (verificado: la lista cubre `text`,
   * `content` y `body`). Un error que arrastrara los valores volcaria contenido de cliente al log
   * sin que la redaccion lo tape. La regla se establece aca, cuando es gratis, para que FG-3 la
   * herede.
   */
  readonly invalidFields: string[];

  constructor(invalidFields: string[]) {
    super(
      'El payload de requirements.new no cumple el contrato del comando. Los campos invalidos van ' +
        'en el contexto de esta linea; sus valores NO, a proposito.',
      { invalidFields },
    );
    this.invalidFields = invalidFields;
  }
}

/**
 * Valida un payload contra el contrato del comando.
 *
 * `safeParse` y no `parse` (convencion `validation`): con `parse` el error que sale es el `ZodError`
 * crudo, cuyo `message` lleva los VALORES rechazados —y en FG-3 esos valores son contenido del
 * mail. Con `safeParse` el conector decide que viaja: las rutas si, los valores no.
 */
export function parseNewRequirement(input: unknown): NewRequirementPayload {
  const result = newRequirementSchema.safeParse(input);

  if (!result.success) {
    throw new RequirementValidationError(
      result.error.issues.map((issue) => issue.path.join('.')),
    );
  }

  return result.data;
}
