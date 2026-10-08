import { JikuKVPermissionDenied, JikuNoBucket, KV_BUCKET } from '@gravadigital/jiku';

import { causeChain } from '#infra/bus/errors.js';
import { AppError } from '#shared/errors/index.js';

/**
 * El error de apertura del Espacio KV y su diagnostico.
 *
 * Mismo motivo que `src/infra/bus/errors.ts` y misma forma: el log tiene que decir QUE hay que
 * arreglar, porque los arreglos estan en lugares distintos. "Fallo el KV" a secas obliga a revisar
 * el bucket, JetStream y los grants del rol a la vez — tres sistemas, y en un worker sin nadie
 * mirando una pantalla esa ambiguedad se paga en horas.
 *
 * ---
 *
 * POR QUE EL DIAGNOSTICO ES POR CLASE DEL SDK (REQ-008).
 *
 * Con el KV crudo de `@nats-io/kv` las clases de error no eran importables y "sin permisos" era
 * indistinguible de "JetStream apagado", asi que se clasificaba por `name` y `code`. Con el Espacio
 * KV las dos cosas cambiaron: el SDK EXPORTA sus clases desde la entrada principal
 * (`@gravadigital/jiku`, con una sola copia en el arbol) y DISTINGUE los casos — `JikuNoBucket`
 * (no existe, sin `allow_direct`, JetStream apagado) contra `JikuKVPermissionDenied` (el bus rechazo
 * el subject). ADR-002 manda manejar los errores del bus por las clases del SDK, asi que el
 * diagnostico es un `instanceof` y NADA mas:
 *
 * - NO se lee el `message`: el texto del SDK es para humanos y puede cambiar en cualquier patch.
 * - NO se compara `name` ni `code`: cualquier `Error` puede llevar un `name` copiado, y una
 *   clasificacion que se deja enganar por un `name` es una clasificacion por texto con otro nombre.
 *
 * Un `JikuError` de timeout NO es ninguno de los dos casos conocidos: es `desconocido`, y se loguea
 * como tal.
 */

/**
 * El diagnostico de un fallo de `client.kv()`.
 *
 * Union de literales y no un `enum`: es lo que hace que un `switch` en el punto de log sea
 * exhaustivo para el typechecker cuando se agregue el cuarto caso.
 *
 * - `bucket_no_usable` -> `JIKU_KV` no existe, no tiene `allow_direct`, o JetStream esta apagado.
 *                        Lo arregla el deploy de Jiku. NO es un problema de grants.
 * - `kv_sin_permisos`  -> el bus rechazo un subject del espacio: al rol le faltan los grants.
 * - `desconocido`      -> no encaja en ninguna. Se loguea como tal, SIN mapearse a otra.
 */
export type KvDiagnosis = 'bucket_no_usable' | 'kv_sin_permisos' | 'desconocido';

/**
 * Clasifica un fallo de `client.kv()` por CLASE del SDK.
 *
 * Devolver `'desconocido'` es un resultado LEGITIMO y no se mapea a otro por descarte (ADR-006).
 * Un diagnostico equivocado es peor que uno ausente: manda a revisar el sistema equivocado, que es
 * el fallo exacto que ADR-006 existe para evitar.
 */
export function diagnoseKvFailure(error: unknown): KvDiagnosis {
  if (error instanceof JikuNoBucket) return 'bucket_no_usable';
  if (error instanceof JikuKVPermissionDenied) return 'kv_sin_permisos';
  return 'desconocido';
}

/**
 * El nombre de la clase de un error, para el log.
 *
 * De `constructor.name`: sirve para leer el log, no para decidir nada — las decisiones se toman
 * con `instanceof` en `diagnoseKvFailure()`. Un valor que no es `Error` se nombra por su `typeof`.
 */
export function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/** Que revisar para cada diagnostico. Textos del CONECTOR; la causa exacta va en `causes`. */
const KV_REMEDIES: Record<KvDiagnosis, string> = {
  // NO menciona grants ni permisos (CA-4): sugerirlos seria mandar a arreglar el sistema
  // equivocado. Y el conector no crea el bucket a proposito: lo crea y lo configura el deploy.
  bucket_no_usable:
    'El bucket no existe, no tiene allow_direct, o JetStream esta apagado en el bus (la causa ' +
    'exacta va en `causes`). Lo crea y lo configura el deploy de Jiku: el conector nunca lo crea.',

  kv_sin_permisos:
    'El bus rechazo un subject del Espacio KV: al rol del conector le faltan los grants del ' +
    'espacio, y los que faltan van en `causes`. La conexion al bus funciona — si no, el arranque ' +
    'habria fallado antes, en el paso de conexion.',

  desconocido:
    'El fallo no encaja en ninguna causa conocida. La clase del error y la cadena de causas van ' +
    'en el contexto de esta linea.',
};

/** Lo que se necesita para construir el error. Nombrado y no posicional. */
export interface KvSpaceUnavailableErrorInput {
  readonly diagnosis: KvDiagnosis;
  readonly cause: unknown;
}

/**
 * El Espacio KV no esta usable al arrancar.
 *
 * Expone `diagnosis`, `bucket`, `subject`, `errorClass` y `causes` como CAMPOS y no solo dentro del
 * `message`, imitando a `BusConnectError` con su `diagnosis`: asi el punto de log y los tests
 * afirman sobre estructura en vez de sobre texto capturado, que es lo que permite reescribir el
 * mensaje sin romper nada.
 *
 * Tiene su PROPIA rama en `reportStartupFailure()`, separada de `BusConnectError`: cuando falla el
 * KV la conexion al bus funciono, y decir lo contrario manda a revisar la red.
 */
export class KvSpaceUnavailableError extends AppError {
  readonly code = 'KV_SPACE_UNAVAILABLE_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. 500 porque un espacio no usable es un fallo del despliegue.
  readonly httpStatus = 500;

  /** Que hay que arreglar. */
  readonly diagnosis: KvDiagnosis;

  /** Siempre `JIKU_KV` (`KV_BUCKET` del SDK): el bucket es fijo, no configuracion. */
  readonly bucket: string;

  /** El subject que el bus rechazo. Solo con `JikuKVPermissionDenied`. */
  readonly subject: string | undefined;

  /** La clase del error subyacente (`errorClassOf()`), para el log. */
  readonly errorClass: string;

  /**
   * Los mensajes COMPLETOS de la cadena de causas, del mas externo al mas interno.
   *
   * SIN truncar a la primera linea: el mensaje de `JikuKVPermissionDenied` es multilinea, y los
   * grants que faltan (`requiredKVPermissions()`) vienen DESPUES de la primera linea. Truncar
   * perderia justo el dato que hace accionable el fallo. Ninguno de estos mensajes trae
   * credenciales: nombran el bucket, subjects y el placeholder `{{user_id}}`.
   *
   * Van como campo de strings —y no como el `Error` entero— porque el contexto de log tiene que ser
   * PLANO: la redaccion de S-003 no tiene comodin profundo.
   */
  readonly causes: string[];

  constructor({ diagnosis, cause }: KvSpaceUnavailableErrorInput) {
    const errorClass = errorClassOf(cause);
    const subject = cause instanceof JikuKVPermissionDenied ? cause.subject : undefined;

    super(`El espacio KV (bucket "${KV_BUCKET}") no esta usable. ${KV_REMEDIES[diagnosis]}`, {
      diagnosis,
      bucket: KV_BUCKET,
      errorClass,
      ...(subject !== undefined ? { subject } : {}),
    });

    this.diagnosis = diagnosis;
    this.bucket = KV_BUCKET;
    this.subject = subject;
    this.errorClass = errorClass;
    this.causes = causeChain(cause).map((error) => error.message);
    this.cause = cause;
  }
}
