import { AppError } from '#shared/errors/index.js';

import { causeChain } from '#infra/bus/errors.js';

/**
 * Los errores de apertura del KV y su diagnostico.
 *
 * Mismo motivo que `src/infra/bus/errors.ts` y misma forma: el log tiene que decir QUE hay que
 * arreglar, porque los arreglos estan en lugares distintos. "Fallo el KV" a secas obliga a revisar
 * el nombre del bucket, si el bucket existe, si JetStream esta habilitado y si la cuenta tiene
 * permisos de KV — cuatro sistemas, y en un worker sin nadie mirando una pantalla esa ambiguedad
 * se paga en horas.
 *
 * ---
 *
 * HALLAZGO 3: las clases de error del KV NO son importables, asi que la clasificacion es
 * ESTRUCTURAL y no por `instanceof`.
 *
 * `@gravadigital/jiku/nats` re-exporta `@nats-io/kv`, y ese paquete expone `Kvm`, `Bucket` y
 * `KvWatchInclude` — pero NO sus clases de error. `StreamNotFoundError`, `JetStreamNotEnabled` y
 * `JetStreamApiError` viven en `@nats-io/jetstream`, que este proyecto NO declara y NO debe
 * declarar (ADR-002 / S-023: el KV entra por el subpath del SDK para que haya UNA sola copia de
 * `nats-core` en el arbol).
 *
 * Y NO hay que "resolverlo" importandolas de `@nats-io/jetstream` ni de su subpath `/internal`:
 *
 * 1. Seria una dependencia FANTASMA — no declarada en `package.json`, presente solo por hoisting
 *    de npm, y por lo tanto rota en silencio ante cualquier de-hoisting futuro.
 * 2. Traeria una SEGUNDA copia de `nats-core` si npm decidiera no deduplicar, y entonces el
 *    `instanceof` que se buscaba daria `false` contra la copia que lanzo el error. Es exactamente
 *    la falla que S-023 existe para hacer imposible.
 *
 * Asi que se clasifica por `name` y por `code`, que son datos ESTRUCTURADOS del error, igual que
 * `diagnoseConnectFailure()` clasifica por `constructor.name` y por los `code` de `errno`. Lo que
 * NO se hace, en ninguna rama, es comparar el TEXTO del mensaje: ver el comentario de
 * `diagnoseKvFailure()`.
 *
 * ---
 *
 * HALLAZGO 4: "sin permisos de KV" es INDISTINGUIBLE de "JetStream deshabilitado", y no hay que
 * intentar distinguirlos.
 *
 * Una violacion de permisos sobre un subject de JetStream (`$JS.API.>`) no llega como respuesta a
 * la request: llega como un `-ERR` ASINCRONICO por el stream de status de la conexion, y la
 * request en curso muere por timeout. El cliente la envuelve entonces igual que cuando el servidor
 * no tiene JetStream: como `JetStreamNotEnabled`.
 *
 * Correlacionar el error asincronico con la request para separarlos exigiria suscribirse al stream
 * de status de la conexion y adivinar cual `-ERR` corresponde a cual llamada. CA-6 no lo pide, y
 * el remedio no lo necesita: `kv_no_disponible` nombra LAS DOS cosas a revisar, que es lo unico
 * que el operador necesita saber para arreglarlo.
 */

/**
 * El diagnostico de un fallo al abrir o verificar un bucket del KV.
 *
 * Union de literales y no un `enum`, igual que `ConnectDiagnosis`: es lo que hace que un `switch`
 * en el punto de log sea exhaustivo para el typechecker cuando se agregue el quinto caso.
 *
 * Cada valor nombra UN arreglo distinto:
 *
 * - `bucket_inexistente`        -> el bucket no existe. Lo crea el OPERADOR con `nats kv add`.
 * - `kv_no_disponible`          -> JetStream deshabilitado, o sin permisos de KV en el
 *                                 auth-callout. Indistinguibles (Hallazgo 4): el remedio nombra
 *                                 las dos.
 * - `nombre_de_bucket_invalido` -> el nombre configurado no puede ser un bucket. Es un error de
 *                                 configuracion y se detecta ANTES de cualquier I/O.
 * - `desconocido`               -> no encaja en ninguna. Se loguea como tal, SIN mapearse a otra.
 */
export type KvDiagnosis =
  | 'bucket_inexistente'
  | 'kv_no_disponible'
  | 'nombre_de_bucket_invalido'
  | 'desconocido';

/**
 * El `err_code` de la API de JetStream para "el stream no existe".
 *
 * Un bucket del KV ES un stream (`KV_<nombre>`), asi que "el bucket no existe" llega desde el
 * servidor como este codigo. Se lee del campo `code` del error, que es un dato estructurado de la
 * API y no prosa.
 */
const STREAM_NOT_FOUND_CODE = 10059;

/**
 * El regex de nombre de bucket valido, copiado de `@nats-io/kv` (`lib/kv.js:88`).
 *
 * Se valida ACA, antes de llamar a `open()`, en vez de reconocer el error que lanza la libreria.
 * `validateBucket()` (`lib/kv.js:126-128`) lanza un `Error` PLANO y sincronico —
 * `invalid bucket name: <name>` — sin `name` ni `code` distintivos, asi que reconocerlo obligaria
 * a leer el texto del mensaje, que es precisamente lo que este modulo no hace.
 *
 * Validando antes, el diagnostico es POSITIVO: se sabe que el nombre es invalido porque se
 * comprobo, no porque un error se parezca a otro.
 *
 * Si esta constante y la de la libreria divergen, el sintoma es benigno: la libreria rechaza igual
 * y el diagnostico cae en `desconocido`. Nunca se acepta un nombre que la libreria rechazaria.
 */
const VALID_BUCKET_RE = /^[-\w]+$/;

/** Si el nombre configurado puede ser un bucket del KV. No hace ningun I/O. */
export function isValidBucketName(name: string): boolean {
  return VALID_BUCKET_RE.test(name);
}

function codeOf(error: Error): number | undefined {
  // `code` es un getter sobre un campo privado en las clases de error de JetStream, asi que se lee
  // DIRECTAMENTE del error y nunca de una copia serializada (un `structuredClone` o un
  // `JSON.parse(JSON.stringify(...))` lo perderian).
  const { code } = error as { code?: unknown };
  return typeof code === 'number' ? code : undefined;
}

/**
 * Clasifica un fallo del KV por ESTRUCTURA.
 *
 * NINGUNA rama compara el texto del mensaje con un literal, y no es purismo: el propio
 * `Kvm.create()` de la libreria lo hace (`err.message === "stream not found"`) y es un bug latente
 * — el dia que el servidor cambie esa cadena, o que llegue traducida, la comparacion falla en
 * silencio. Esa es la razon de que este modulo lea `name` y `code`, que son campos.
 *
 * TS-24 es el test que protege esta decision: un `Error` con el mensaje `'stream not found'` pero
 * SIN `name` ni `code` da `'desconocido'`, no `'bucket_inexistente'`.
 *
 * Recorre la CADENA de causas y no solo el error de arriba: `JetStreamNotEnabled` puede llegar
 * envuelto, y ser uniforme evita que un envoltorio nuevo de la libreria rompa el diagnostico.
 *
 * Devolver `'desconocido'` es un resultado LEGITIMO y no se mapea a otro por descarte (ADR-006).
 * Un diagnostico equivocado es peor que uno ausente: manda a revisar el sistema equivocado, que es
 * el fallo exacto que ADR-006 existe para evitar.
 */
export function diagnoseKvFailure(error: unknown): KvDiagnosis {
  const chain = causeChain(error);

  if (chain.length === 0) return 'desconocido';

  // 1. El bucket no existe. El `name` de la clase de JetStream O el `err_code` de la API: cualquiera
  //    de los dos alcanza por si solo, asi que un renombre de la clase no rompe el diagnostico y un
  //    cambio de codigo tampoco.
  if (
    chain.some(
      (cause) => cause.name === 'StreamNotFoundError' || codeOf(cause) === STREAM_NOT_FOUND_CODE,
    )
  ) {
    return 'bucket_inexistente';
  }

  // 2. No hay KV disponible: JetStream deshabilitado o sin permisos de KV. Los dos escenarios
  //    llegan aca (Hallazgo 4) y el remedio nombra los dos.
  if (chain.some((cause) => cause.name === 'JetStreamNotEnabled')) {
    return 'kv_no_disponible';
  }

  // 3. Cualquier otra cosa es DESCONOCIDA, y se devuelve como tal.
  //
  //    `nombre_de_bucket_invalido` NO se decide aca: se decide ANTES de cualquier I/O, validando el
  //    nombre con `isValidBucketName()`. Llegar a este punto con un nombre invalido es imposible
  //    por construccion, y por eso no hay una rama que lo adivine.
  return 'desconocido';
}

/** Que revisar para cada diagnostico. Es lo unico que el operador necesita del mensaje. */
const KV_REMEDIES: Record<KvDiagnosis, string> = {
  bucket_inexistente:
    'El bucket no existe en el bus. Lo crea el OPERADOR, no el conector: ' +
    '`nats kv add <bucket>` (y el de hilos con su TTL, `--ttl=90d`). El conector no lo crea a ' +
    'proposito: un typo en el nombre crearia un bucket vacio en silencio, y el sintoma seria que ' +
    'el conector descarta todo sin decir por que.',

  kv_no_disponible:
    'El KV no esta disponible. Revisa LAS DOS cosas, porque desde el cliente son ' +
    'indistinguibles: que JetStream este habilitado en el bus, y que la cuenta del conector tenga ' +
    'permisos de KV ($JS.API.>) en el auth-callout. La conexion al bus funciona — si no, el ' +
    'arranque habria fallado antes, en el paso de conexion.',

  nombre_de_bucket_invalido:
    'El nombre configurado no puede ser un bucket del KV: solo se aceptan letras, digitos, ' +
    'guion y guion bajo. Revisa KV_TICKETS_BUCKET y KV_THREADS_BUCKET.',

  desconocido:
    'El fallo no encaja en ninguna causa conocida. La clase del error y la cadena de causas van ' +
    'en el contexto de esta linea.',
};

/** Los cuatro valores con los que se construye el error. Nombrados y no posicionales: ver Notas. */
export interface KvBucketMissingErrorInput {
  readonly diagnosis: KvDiagnosis;
  readonly bucket: string;
  /** La operacion del KV que fallo (`'open'`, `'status'`, o `'validate'` si no hubo I/O). */
  readonly operation: string;
  readonly cause: unknown;
}

/**
 * Un bucket del KV no esta usable al arrancar.
 *
 * Expone `diagnosis`, `bucket`, `operation`, `errorClass` y `causes` como CAMPOS y no solo dentro
 * del `message`, imitando a `BusConnectError` con su `diagnosis`: asi el punto de log y los tests
 * afirman sobre estructura en vez de sobre texto capturado, que es lo que permite reescribir el
 * mensaje sin romper nada.
 *
 * `bucket` es el campo que hace verificable el fail-fast de la story: el error tiene que nombrar
 * CUAL bucket falta, porque con dos buckets un "falta un bucket" no dice donde esta el arreglo.
 */
export class KvBucketMissingError extends AppError {
  readonly code = 'KV_BUCKET_MISSING_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. 500 porque un bucket ausente es un fallo del despliegue.
  readonly httpStatus = 500;

  /** Que hay que arreglar. */
  readonly diagnosis: KvDiagnosis;

  /** CUAL de los dos buckets. Es el dato que convierte el fallo en accionable. */
  readonly bucket: string;

  /** La operacion del KV que fallo, para ubicar el punto exacto de la secuencia. */
  readonly operation: string;

  /**
   * El nombre de la clase del error subyacente.
   *
   * De `constructor.name` y no de un `instanceof` por clase: sirve para el log y no depende de la
   * identidad de constructor entre copias del paquete — que es justamente lo que no se puede
   * asumir aca (Hallazgo 3).
   */
  readonly errorClass: string;

  /**
   * Los mensajes de la cadena de causas, del mas externo al mas interno, primera linea de cada uno.
   *
   * Van como campo de strings —y no como el `Error` entero— porque el contexto de log tiene que ser
   * PLANO: la redaccion de S-003 no tiene comodin profundo, asi que un objeto anidado podria dejar
   * un valor sin redactar. Ninguno de estos mensajes contiene credenciales: los errores del KV
   * nombran streams y subjects, nunca tokens ni rutas de archivos.
   */
  readonly causes: string[];

  constructor({ diagnosis, bucket, operation, cause }: KvBucketMissingErrorInput) {
    const chain = causeChain(cause);
    const errorClass = cause instanceof Error ? cause.constructor.name : typeof cause;

    // El nombre del bucket va en el mensaje ADEMAS de en el campo: el campo es para consultar el
    // log estructurado, y el mensaje es lo que alguien lee en una terminal a las tres de la mañana.
    super(`El bucket "${bucket}" del KV no esta usable. ${KV_REMEDIES[diagnosis]}`, {
      diagnosis,
      bucket,
      operation,
      errorClass,
    });

    this.diagnosis = diagnosis;
    this.bucket = bucket;
    this.operation = operation;
    this.errorClass = errorClass;
    this.causes = chain.map((error) => error.message.split('\n')[0] ?? '');
    this.cause = cause;
  }
}
