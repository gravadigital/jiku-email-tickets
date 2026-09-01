import type { z } from 'zod';

import { fileUploadReplySchema, fileUploadRequestSchema } from '#domain/publicacion/files.schema.js';
import type { PublishDiagnosis } from '#domain/publicacion/publish-errors.js';
import { AppError } from '#shared/errors/index.js';

/**
 * Los tipos del contrato de `files.request-upload`, INFERIDOS del schema (Task 1), mas el tipo de
 * resultado de `requestFileUpload()` (Task 2). Un archivo por contrato -- payload, reply y
 * resultado del MISMO comando -- mismo criterio que agrupa `requirement.types.ts`.
 *
 * La convencion `validation` lo exige y CA-4 de S-005 lo repite: los tipos se infieren con
 * `z.infer`, nunca se escriben a mano -- un tipo paralelo al schema puede divergir de el sin que
 * nada falle, y entonces el compilador afirma una forma mientras al bus viaja otra.
 */

/** El payload del comando. */
export type FileUploadRequestPayload = z.infer<typeof fileUploadRequestSchema>;

/** La respuesta de exito del comando, ya validada. */
export type FileUploadReply = z.infer<typeof fileUploadReplySchema>;

/**
 * El payload de `files.request-upload` no valido contra el contrato del comando.
 *
 * Existe como clase y no como `throw new Error(...)` porque la convencion `error-handling` lo
 * prohibe en codigo de dominio, mismo criterio que `RequirementValidationError`
 * (`verification-payload.ts`, S-005): un error tipado con `code` estable es lo que hace la linea
 * agrupable, y solo puede ser lanzado por un fallo de ARMADO del propio conector -- nunca por un
 * rechazo del bus (ver Architectural Context §Estrategia de errores del Story Plan).
 */
export class FileUploadValidationError extends AppError {
  readonly code = 'FILE_UPLOAD_VALIDATION_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. Mismo patron que `RequirementValidationError`.
  readonly httpStatus = 500;

  /**
   * Las RUTAS de los campos invalidos. Nunca sus valores.
   *
   * Mismo criterio de seguridad que `RequirementValidationError`: un error que arrastrara los
   * valores volcaria contenido potencialmente sensible al log (`fileName`/`mimeType` derivan del
   * adjunto de un mail) sin que la redaccion lo tape.
   */
  readonly invalidFields: string[];

  constructor(invalidFields: string[]) {
    super(
      'El payload de files.request-upload no cumple el contrato del comando. Los campos ' +
        'invalidos van en el contexto de esta linea; sus valores NO, a proposito.',
      { invalidFields },
    );
    this.invalidFields = invalidFields;
  }
}

/**
 * Valida un payload contra el contrato de `files.request-upload`.
 *
 * `safeParse` y no `parse` (convencion `validation`): con `parse` el error que sale es el
 * `ZodError` crudo, cuyo `message` lleva los VALORES rechazados. Con `safeParse` el conector
 * decide que viaja: las rutas si, los valores no. Mismo patron que `parseNewRequirement()`.
 */
export function parseFileUploadRequest(input: unknown): FileUploadRequestPayload {
  const result = fileUploadRequestSchema.safeParse(input);

  if (!result.success) {
    throw new FileUploadValidationError(result.error.issues.map((issue) => issue.path.join('.')));
  }

  return result.data;
}

/**
 * El resultado de `requestFileUpload()` (Task 3): una union discriminada por `tipo`, con
 * exactamente tres variantes. Reemplaza el patron "lanza `PublishError`" de
 * `publish-requirement.ts` por un valor de retorno tipado -- ver Architectural Context §Estrategia
 * de errores del Story Plan: quien orquesta el bucle de adjuntos (S-021) necesita un valor que
 * inspeccionar por archivo, no una excepcion que interrumpiria el `for` si no se envolviera en un
 * try/catch por iteracion.
 *
 * `nombre`/`mime` (no `fileName`/`mimeType`, que son las claves del PAYLOAD del comando, un
 * concepto distinto) usan los mismos nombres de campo que `AdjuntoRechazado`
 * (`src/domain/adjuntos/types.ts`, S-017), para que S-021 trate ambos catalogos de avisos con el
 * mismo shape mental.
 *
 * Ningun campo se llama `key`: `REDACT_PATHS` incluye `'key'` y `'*.key'`, y un campo `key`
 * saldria redactado en un log sin fallar y sin avisar (mismo cuidado que `AdjuntoRechazado`).
 */
export type UploadResultado =
  | {
      readonly tipo: 'concedido';
      readonly fileId: number;
      readonly uploadUrl: string;
    }
  | {
      /**
       * Un `failure` de NEGOCIO de `core` (el archivo paso el filtro local pero `core` lo
       * rechaza). NO expone el `cause` original ni ningun dato del error del SDK mas alla del
       * `codigo` -- es un resultado de dominio, no un error tecnico envuelto (CA-4: "aviso de
       * rechazo, la misma clase que un rechazo local").
       */
      readonly tipo: 'rechazado';
      readonly codigo: 'file_type_not_allowed' | 'file_too_large';
      readonly nombre: string;
      readonly mime: string;
    }
  | {
      /**
       * Cualquier OTRO fallo de publicacion (las 9 ramas de `diagnosePublishFailure()`, sin
       * ninguna rama nueva -- CA-6). Reutiliza `PublishDiagnosis` importado, nunca redeclarado --
       * mismo tipo que ya usa `PublishError.diagnosis`.
       */
      readonly tipo: 'fallido';
      readonly diagnosis: PublishDiagnosis;
      readonly nombre: string;
      readonly mime: string;
    };
