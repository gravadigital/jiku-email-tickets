import { z } from 'zod';

/**
 * El contrato de `files.request-upload`, del lado del conector.
 *
 * ESTE ARCHIVO ES LA UNICA DEFINICION DEL CONTRATO EN EL REPO -- mismo criterio verificado que
 * `requirement.schema.ts` (S-005): el SDK no exporta ningun tipo ni schema con la forma del
 * payload de este comando, asi que no hay nada de donde derivarlo. El tipo se INFIERE de este
 * schema (`files.types.ts`) en vez de escribirse a mano, por la misma razon: dos declaraciones
 * separadas divergirian sin que nada falle.
 */

/**
 * El payload de `files.request-upload`.
 *
 * `.strict()`, no un `z.object` normal -- ADR-003/ADR-005: el payload lleva EXACTAMENTE estos
 * cuatro campos, y ninguna clave de identidad (`uploader`, `actor`). Un `z.object` normal
 * DESCARTARIA una clave de mas en silencio; lo que este contrato necesita es que FALLE, porque el
 * `.strict()` es la unica guarda verificable de que nadie coló un campo de identidad por error
 * (CA-1: "no lleva `uploader` ni `actor`").
 *
 * Los cuatro campos, y de donde sale cada uno en `upload-file.ts` (Task 3):
 * - `fileName`: `adjunto.filename` -- ya resuelto por S-017 (generado o declarado).
 * - `mimeType`: `adjunto.mimeType` -- ya resuelto por S-017 (declarado o `application/octet-stream`).
 * - `fileSize`: `adjunto.content.length` -- NUNCA un `size` declarado, que ni siquiera existe en
 *   `AdjuntoAceptado`. Nunca 0: S-017 ya rechazo los adjuntos de 0 bytes.
 * - `checksum`: `adjunto.checksum` -- ya calculado por S-017 (sha256, `node:crypto`). Esta story
 *   NUNCA recalcula nada, solo lo transporta.
 */
export const fileUploadRequestSchema = z
  .object({
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    fileSize: z.number().int().min(1),
    checksum: z.string().min(1),
  })
  .strict();

/**
 * La respuesta de exito de `files.request-upload`.
 *
 * Nombrada `fileUploadReplySchema` literalmente, porque CA-3 de la story lo exige asi. Vive junto
 * al schema del payload por el mismo criterio que `newRequirementReplySchema` junto a
 * `newRequirementSchema`: los dos son el contrato del MISMO comando.
 *
 * Existe por el mismo hallazgo verificado que motiva `newRequirementReplySchema`: `command<T>()`
 * devuelve `reply.data` TAL CUAL, sin comprobar que coincida con `T`. Un `core` que respondiera
 * `{ status: 'success', data: {} }` produciria un resultado con `id: undefined` -- formalmente
 * presente, materialmente inutil -- sin que nada falle si no se valida. Por eso una respuesta sin
 * `id`/`uploadUrl` usables es un FALLO (`respuesta_ilegible`), no un exito con hueco.
 *
 * `id` Y NO `fileId`, porque asi lo nombra el contrato del bus (`core/docs/apis/core.yaml`, que
 * responde `{ id, uploadUrl, expiresIn }`). `fileId` es el nombre que la api le pone en HTTP para el
 * navegador: el conector habla con core por el bus, no con la api. Hasta la verificacion contra el
 * core real este schema pedia `fileId`, y TODA subida terminaba en `respuesta_ilegible`.
 *
 * `uploadUrl` usa `z.string().min(1)` y NO `z.string().url()`: la URL prefirmada de S3 puede
 * incluir query params de firma que algunos validadores de URL rechazan por longitud o
 * caracteres. El conector no navega la URL, solo la reenvia a S-019 -- validar que sea un string
 * no vacio es suficiente para este contrato.
 */
export const fileUploadReplySchema = z
  .object({
    id: z.number().int().positive(),
    uploadUrl: z.string().min(1),
  })
  // Sin `.strict()` aca, a proposito y por la razon inversa a la del payload: la respuesta la
  // manda `core`, y un campo nuevo que `core` empiece a enviar manana no debe romper al conector.
  .loose();
