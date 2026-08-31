import { TITLE_MAX_LENGTH } from '#domain/publicacion/requirement.schema.js';
import type { NewRequirementPayload } from '#domain/publicacion/requirement.types.js';
import type { IncomingMail } from '#domain/ingesta/types.js';
import type { RuteoConfig } from '#config/index.js';

/**
 * El payload derivado del MAIL, y el reemplazo del payload fijo del modo de verificacion en el
 * camino real del producto.
 *
 * Esta funcion SOLO arma el objeto: no valida (eso lo hace `parseNewRequirement()`, invocado desde
 * `publish-requirement.ts`) y no publica. Mismo patron que `buildVerificationPayload()`, que
 * tampoco valida ni publica.
 */

/**
 * Arma el payload de `requirements.new` a partir de un mail entrante ya normalizado y ruteado.
 *
 * **CRITICO — el orden de operaciones en `title` es recortar -> truncar -> placeholder, y NO es
 * intercambiable (Riesgo 5 de la story).** Con el orden inverso -placeholder antes de truncar- un
 * asunto de 400 espacios en blanco produciria un `title` vacio que `newRequirementSchema` rechaza
 * con `min(1)`, y el mail se perderia por un error de armado del conector en vez de crear el
 * requisito con el placeholder. Los dos tests que verifican esto (`TS-3`/`CA-5` y `TS-5`/`CA-6` en
 * `test/publicacion/mail-payload.test.ts`) solo pasan JUNTOS en este orden.
 *
 * `description` sigue el mismo criterio en dos pasos (recortar -> placeholder), sin truncar: no
 * tiene tope, es `text` en la base (ver `requirement.schema.ts`).
 *
 * `TITLE_MAX_LENGTH` se IMPORTA de `requirement.schema.ts`, nunca se redeclara como literal
 * (CA-7): ese archivo ya explica por que la constante existe justo para que este modulo la use.
 */
export function buildRequirementPayload(
  mail: Pick<IncomingMail, 'subject' | 'body'>,
  projectId: number,
  userId: string,
  ruteoConfig: Pick<RuteoConfig, 'placeholderTitle' | 'placeholderBody'>,
): NewRequirementPayload {
  const trimmedTitle = mail.subject.trim().slice(0, TITLE_MAX_LENGTH);
  const title = trimmedTitle === '' ? ruteoConfig.placeholderTitle : trimmedTitle;

  const trimmedBody = mail.body.trim();
  const description = trimmedBody === '' ? ruteoConfig.placeholderBody : trimmedBody;

  return {
    title,
    description,
    projectId,

    // Fijos, no configurables: politica del conector, no del contrato (mismo criterio que
    // buildVerificationPayload()).
    type: 'incidencia',
    priority: 'sin_prioridad',
    visibilityLevel: 'public',

    // Informativo: `core` lo IGNORA y resuelve el actor del `sub` del subject (ADR-005). Se envia
    // igual porque el request lo pide explicitamente (RF-32) y porque es redundante por diseno, no
    // una fuente de verdad -- nunca porque el conector decida quien es el actor.
    creator: userId,

    // Y ACA TERMINA EL OBJETO. `state`, `actor` y `fileIds` NO van, por las mismas tres razones que
    // documenta buildVerificationPayload() en verification-payload.ts -- no se repiten aca para no
    // tener dos copias que diverjan. `attachments` del mail no se lee en ningun lado de esta
    // funcion: se ignora por completo (FG-4 lo incorpora).
  };
}
