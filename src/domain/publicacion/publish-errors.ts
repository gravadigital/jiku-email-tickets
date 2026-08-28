import {
  ErrorCode,
  JikuFailure,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuPermissionDenied,
  JikuTimeout,
  isCode,
  isJikuError,
} from '@gravadigital/jiku';

import { MIN_TIMEOUT_MS } from '#config/schema.js';
import { AppError } from '#shared/errors/index.js';

/**
 * La traduccion de un fallo de publicacion al diagnostico de QUIEN RECHAZO.
 *
 * Es el entregable central de S-005. Sin esto el log dice "fallo el comando" y el operador tiene
 * que revisar TRES sistemas a la vez —el rol en Zitadel, la fila en `users` de Jiku, y el
 * payload— con tres arreglos distintos. El peor caso real no es no saber: es revisar el payload
 * cuando el problema esta en Zitadel.
 *
 * La forma imita deliberadamente a `src/infra/bus/errors.ts` (S-004): una union de literales para
 * el diagnostico, un `Record` de remedios, y una clase de error que expone el diagnostico como
 * CAMPO y no solo dentro del mensaje. No es consistencia estetica — es lo que permite que el punto
 * de log y los tests afirmen sobre ESTRUCTURA en vez de sobre texto capturado, y por lo tanto que
 * el mensaje se pueda reescribir sin romper ningun test.
 */

/**
 * Que sistema rechazo la publicacion, y por lo tanto donde esta el arreglo.
 *
 * El eje del diagnostico son tres sistemas y, dentro de `core`, dos motivos:
 *
 * - `rechazo_del_bus_por_subject`  -> EL BUS, por subject, antes de que `core` viera nada. Zitadel.
 * - `bus_sin_endpoint`            -> EL BUS dice de inmediato que nada esta suscripto. `core` caido.
 * - `error_de_armado_del_conector` -> EL CONECTOR. Rechazado LOCALMENTE: nada llego a la red.
 * - `core_rechazo_por_rol`        -> `core`, por ROL. Tipicamente la fila ausente en `users`.
 * - `core_rechazo_por_forma`      -> `core`, por FORMA. El payload o el proyecto.
 * - `core_rechazo_desconocido`    -> `core` rechazo con un codigo que el conector no conoce.
 * - `nada_respondio`             -> Nadie contesto en el timeout. `core` caido o lento.
 * - `respuesta_ilegible`          -> `core` dijo exito y la respuesta no trae un `id` usable.
 * - `desconocido`                -> No es un error del SDK. Se loguea como tal, sin mapearse.
 */
export type PublishDiagnosis =
  | 'rechazo_del_bus_por_subject'
  | 'bus_sin_endpoint'
  | 'error_de_armado_del_conector'
  | 'core_rechazo_por_rol'
  | 'core_rechazo_por_forma'
  | 'core_rechazo_desconocido'
  | 'nada_respondio'
  | 'respuesta_ilegible'
  | 'desconocido';

/**
 * Clasifica un fallo de publicacion por CLASE DEL SDK y por CODIGO, nunca por el texto del mensaje.
 *
 * ADR-002 lo exige literalmente: "Los errores del bus MUST manejarse por las clases del SDK, no
 * inspeccionando strings de mensaje". Y el propio SDK lo refuerza para los codigos: su catalogo
 * NO ES CERRADO —`core` lo posee y lo hace crecer— asi que la advertencia del `.d.ts` dice "Use
 * `isCode`, never a `switch` with a `default` that assumes it has seen everything".
 *
 * EL ORDEN DE LAS RAMAS IMPORTA y no es intercambiable: `JikuFailure` se evalua ANTES que
 * cualquier rama generica de `isJikuError`, y las ramas de codigo van DENTRO de la de
 * `JikuFailure`. Escrito al revés, un `caller_not_authorized` caeria en `'desconocido'` y se
 * perderia el diagnostico mas valioso del conjunto — el unico que se arregla solo reconectando.
 */
export function diagnosePublishFailure(error: unknown): PublishDiagnosis {
  // 1. `core` CONTESTO. Es la rama mas informativa y por eso va primero: hubo reply, asi que el
  //    bus dejo pasar y el plano de escritura esta abierto para esta identidad.
  if (error instanceof JikuFailure) {
    if (isCode(error, ErrorCode.CallerNotAuthorized)) return 'core_rechazo_por_rol';

    // `unknown_caller` es el otro codigo de "no te conozco": Gate 2 del SDK, el caller sin fila en
    // `users`. Es el MISMO arreglo que `caller_not_authorized` (reconectar crea la fila), asi que
    // comparte diagnostico. El SDK los distingue porque son preguntas distintas; el operador no
    // necesita la distincion porque hace lo mismo con las dos.
    if (isCode(error, ErrorCode.UnknownCaller)) return 'core_rechazo_por_rol';

    // Los dos codigos de forma comparten diagnostico A PROPOSITO: son el mismo eje (`core` acepto
    // el caller y rechazo la forma) y el mismo mensaje operativo (el plano de escritura esta
    // abierto). Lo que los distingue —el `projectId` en el caso de `project_not_found`— viaja en
    // el `code` y en el contexto del log, no en el diagnostico. Un diagnostico por codigo haria la
    // union mas larga sin agregar nada accionable.
    if (isCode(error, ErrorCode.InvalidFields)) return 'core_rechazo_por_forma';
    if (isCode(error, ErrorCode.ProjectNotFound)) return 'core_rechazo_por_forma';

    // CUALQUIER OTRO codigo. NO se mapea a ninguno de los anteriores y NO hay `switch` exhaustivo:
    // un codigo desconocido es un resultado NORMAL Y ESPERADO de un catalogo que `core` hace
    // crecer, no un caso residual (CA-13).
    return 'core_rechazo_desconocido';
  }

  // 2. EL BUS rechazo por subject, antes de que `core` viera nada. Otro sistema, otro arreglo.
  if (error instanceof JikuPermissionDenied) return 'rechazo_del_bus_por_subject';

  // 3. EL BUS dice de inmediato que nada esta suscripto. Verificado: llega en 11 ms, no espera el
  //    timeout. Es una señal mas firme que un timeout.
  if (error instanceof JikuNoEndpoint) return 'bus_sin_endpoint';

  // 4. EL CONECTOR. El SDK lo rechazo LOCALMENTE y nada llego a la red.
  if (error instanceof JikuInvalidRequest) return 'error_de_armado_del_conector';

  // 5. Nadie contesto.
  if (error instanceof JikuTimeout) return 'nada_respondio';

  // 6. Un error del SDK que no es ninguna de las cinco clases de arriba (p. ej. `JikuNotConnected`),
  //    o algo que no es del SDK. Se devuelve `'desconocido'` y NO se mapea a otro: un diagnostico
  //    equivocado manda a revisar el sistema equivocado, que es el fallo exacto que ADR-006 existe
  //    para evitar. `isJikuError` participa del `if` para dejar constancia de que la distincion se
  //    considero: las dos ramas dan el mismo diagnostico, pero `sdkErrorClass` las distingue en el
  //    log.
  if (isJikuError(error)) return 'desconocido';

  return 'desconocido';
}

/**
 * El `hint()` del error, cuando la clase lo tiene.
 *
 * HALLAZGO VERIFICADO CONTRA EL SDK INSTALADO, y la razon de que esta funcion exista: `hint()`
 * esta declarado SOLO en `JikuFailure`. `JikuTimeout`, `JikuNoEndpoint`, `JikuPermissionDenied` y
 * `JikuInvalidRequest` extienden `JikuError`, que NO lo declara — llamarlo sobre cualquiera de
 * ellas es un `TypeError`, y ocurriria exactamente en el peor momento: cuando el conector ya esta
 * fallando y el log es lo unico que queda.
 *
 * Es una FUNCION y no un acceso inline porque tiene que existir UN SOLO lugar donde se decida si
 * `hint()` se puede llamar. Un `error instanceof JikuFailure ? error.hint() : undefined` repetido
 * en dos puntos de log es la forma de que el tercero se escriba sin la guarda.
 *
 * Y devuelve `undefined` legitimamente: verificado, `hint()` no cubre `project_not_found` ni
 * ningun codigo desconocido (su `default` devuelve `undefined`). Esos dos casos son justo los que
 * CA-9 y CA-13 piden loguear "con su hint()". Lo que viaja en su lugar es `code` y `errorMessage`
 * —el mensaje que mando `core`, verbatim— y ESE es el dato de diagnostico real ahi. No inventar
 * texto para tapar la ausencia.
 */
export function hintOf(error: unknown): string | undefined {
  return error instanceof JikuFailure ? error.hint() : undefined;
}

/**
 * El `errorMessage` que mando `core`, cuando lo hay.
 *
 * Separado de `hintOf()` por la misma razon estructural: solo `JikuFailure` lo tiene, y es el
 * dato de diagnostico que reemplaza al `hint()` ausente en `project_not_found` y en los codigos
 * desconocidos. Verbatim y sin parsear: el que lo parsee con un regex esta reintroduciendo la
 * inspeccion de strings que ADR-002 prohibe.
 */
export function coreMessageOf(error: unknown): string | undefined {
  return error instanceof JikuFailure ? error.errorMessage : undefined;
}

/**
 * El codigo que mando `core`, cuando lo hay.
 *
 * `undefined` para las cuatro clases que no son `JikuFailure`: ahi no hay codigo porque no hubo
 * reply de `core` — y esa ausencia es informacion, no un hueco a rellenar.
 */
export function codeOf(error: unknown): string | undefined {
  return error instanceof JikuFailure ? error.code : undefined;
}

/**
 * Que revisar para cada diagnostico. Es lo unico que el operador necesita del mensaje.
 *
 * Cada texto nombra EL SISTEMA y EL ARREGLO. Los tres puntos que la story exige explicitamente:
 * el del bus dice que NO implica nada sobre `core`; los de `core` por forma dicen que SON PRUEBA
 * de que el plano de escritura esta abierto; el de rol dice que tipicamente es la fila ausente en
 * `users` y que RECONECTAR LO CORRIGE SOLO.
 */
export const REMEDIES: Record<PublishDiagnosis, string> = {
  rechazo_del_bus_por_subject:
    'EL BUS rechazo la publicacion por subject, antes de que core viera nada. El arreglo esta en ' +
    'Zitadel: el rol internal-app asignado al machine user en el project de gestion, el Access ' +
    'Token Type en JWT, y JIKU_PROJECT_ID configurado para que el token lleve el claim de roles. ' +
    'NO implica nada sobre core: core no llego a recibir el comando.',

  bus_sin_endpoint:
    'EL BUS respondio de inmediato que nada esta suscripto al subject del comando. Revisa que core ' +
    'este corriendo y suscripto al queue group jiku-commands, y que JIKU_INSTANCE coincida con la ' +
    'instancia donde core escucha. No es un problema de permisos ni del payload.',

  error_de_armado_del_conector:
    'EL SDK rechazo el comando LOCALMENTE: nada llego a la red. Es un error de armado del conector, ' +
    'no del bus ni de core. La causa mas comun es una clave prohibida en el payload (actor es la ' +
    'unica que el plano de escritura rechaza de plano).',

  core_rechazo_por_rol:
    'CORE rechazo por ROL, no por el payload: el bus dejo pasar el comando y core no autorizo al ' +
    'caller. Tipicamente es la fila ausente en users, que Jiku crea sola en la primera ' +
    'autenticacion — RECONECTAR LO CORRIGE SOLO, y la corrida siguiente tiene exito. No revises el ' +
    'payload por este error.',

  core_rechazo_por_forma:
    'CORE acepto al caller y rechazo LA FORMA: el payload o el proyecto. Esto ES PRUEBA de que el ' +
    'plano de escritura esta abierto para esta identidad — el bus dejo pasar y core autorizo el rol. ' +
    'Revisa el payload y el JIKU_VERIFY_PROJECT_ID, no Zitadel.',

  core_rechazo_desconocido:
    'CORE rechazo con un codigo que este conector no conoce. El catalogo de errores es de la ' +
    'instancia de Jiku y crece: un codigo nuevo es esperable y NO se mapea a ningun caso conocido. ' +
    'El code y el mensaje que mando core van en el contexto de esta linea. Tambien esto es prueba ' +
    'de que el plano de escritura esta abierto.',

  // El numero sale de `MIN_TIMEOUT_MS` y NO se escribe como literal, aunque sea prosa para el
  // operador: es el mismo valor que el schema garantiza como piso, y dos copias se desincronizarian
  // en silencio — el remedio diria "15000 ms" mientras el proceso espera otra cosa, que es
  // exactamente el diagnostico enganoso que este modulo existe para evitar. Hay un test de
  // propiedad que prohibe el literal fuera de `src/config/`.
  nada_respondio:
    `NADIE RESPONDIO en el timeout del comando (${String(MIN_TIMEOUT_MS)} ms). core esta caido, ` +
    'esta lento, o no hay nadie atendiendo el subject en esta instancia. No se reintenta: si core ' +
    'no respondio, la escritura no ocurrio.',

  respuesta_ilegible:
    'CORE respondio exito pero la respuesta no trae un id de requisito usable. El comando puede ' +
    'haber creado el requisito: verificalo en Jiku antes de volver a correr, porque el conector no ' +
    'tiene comando de compensacion y no puede deshacerlo.',

  desconocido:
    'El fallo no encaja en ninguna causa conocida y NO se mapea a otra. La clase del error va en el ' +
    'contexto de esta linea.',
};

/**
 * Los diagnosticos que prueban que el plano de escritura esta abierto.
 *
 * Si `core` CONTESTO —cualquiera sea el codigo— entonces el bus dejo pasar el comando y la
 * identidad tiene permiso sobre el subject. Es informacion POSITIVA y por eso viaja como campo
 * booleano y no enterrada en prosa: es lo que le dice al operador que dejo de tener un problema de
 * Zitadel.
 */
const CORE_ANSWERED: ReadonlySet<PublishDiagnosis> = new Set<PublishDiagnosis>([
  'core_rechazo_por_rol',
  'core_rechazo_por_forma',
  'core_rechazo_desconocido',
  // `respuesta_ilegible` tambien: `core` contesto exito. La respuesta no sirvio, pero llego.
  'respuesta_ilegible',
]);

/** Si `core` contesto, el plano de escritura esta abierto para esta identidad. */
export function isWritePlaneOpen(diagnosis: PublishDiagnosis): boolean {
  return CORE_ANSWERED.has(diagnosis);
}

/**
 * No se pudo publicar `requirements.new`.
 *
 * Expone `diagnosis`, `sdkErrorClass`, `errorCode`, `hint` y `planoDeEscrituraAbierto` como
 * CAMPOS, no solo dentro del `message`, imitando a `BusConnectError` de S-004: asi el punto de
 * log y los tests afirman sobre estructura en vez de sobre texto capturado.
 *
 * NI el `message` NI ningun campo lleva el payload, ni `title`, ni `description`. La razon es
 * concreta y verificada: `REDACT_PATHS` cubre `text`, `content` y `body`, pero NO `title` ni
 * `description`. En esta story son literales del codigo y no habria filtracion, pero en FG-3 el
 * payload deriva del mail y si la habria. La regla se establece aca, cuando es gratis.
 */
export class PublishError extends AppError {
  readonly code = 'PUBLISH_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. Mismo patron que `KeyLoadError` y `BusConnectError`.
  readonly httpStatus = 500;

  /** Que sistema rechazo. */
  readonly diagnosis: PublishDiagnosis;

  /**
   * El nombre de la clase del error del SDK.
   *
   * De `constructor.name` y no de un `instanceof` por clase: sirve para el log y no depende de la
   * identidad de constructor entre copias del paquete.
   */
  readonly sdkErrorClass: string;

  /** El `code` que mando `core`, o `undefined` si no hubo reply de `core`. */
  readonly errorCode: string | undefined;

  /** El `hint()` del SDK, cuando la clase lo tiene Y el codigo lo tiene. */
  readonly hint: string | undefined;

  /**
   * El mensaje que mando `core`, verbatim.
   *
   * Es el dato de diagnostico REAL para `project_not_found` y para los codigos desconocidos, que
   * son justo los dos casos donde `hint()` devuelve `undefined`.
   */
  readonly coreMessage: string | undefined;

  /** Si `core` contesto, el bus dejo pasar: informacion positiva. */
  readonly planoDeEscrituraAbierto: boolean;

  constructor(diagnosis: PublishDiagnosis, cause: unknown) {
    super(`No se pudo publicar requirements.new. ${REMEDIES[diagnosis]}`, { diagnosis });

    this.diagnosis = diagnosis;
    this.sdkErrorClass = cause instanceof Error ? cause.constructor.name : typeof cause;
    this.errorCode = codeOf(cause);
    this.hint = hintOf(cause);
    this.coreMessage = coreMessageOf(cause);
    this.planoDeEscrituraAbierto = isWritePlaneOpen(diagnosis);
    this.cause = cause;
  }

  /**
   * El contexto de log de este fallo.
   *
   * PLANO, de un solo nivel, y no es un gusto: la redaccion de S-003 no tiene comodin profundo,
   * asi que un contexto anidado dejaria un secreto en claro sin fallar ni avisar. Mismo criterio
   * que `reportTokenRefreshFailure()` de S-004.
   *
   * `code`, `hint` y `errorMessage` se OMITEN cuando son `undefined`, con spread condicional. No
   * se loguea `hint: null`: es ruido en una linea que se lee para diagnosticar, y sugiere que el
   * SDK contesto algo cuando no contesto nada. La ausencia de `code` tambien es informacion: quiere
   * decir que `core` nunca contesto.
   *
   * La clave del log es `code` y NO `errorCode`, mientras el campo de la clase se llama `errorCode`.
   * La asimetria es deliberada: en el log, `code` es el codigo que mando `core` —el dato que se
   * cruza con el log de `core`, que lo llama asi— y no se usa para `PublishError.code`, que es la
   * constante `PUBLISH_ERROR` y no aporta nada al diagnostico de una linea que ya lleva `diagnosis`.
   *
   * `projectId` va SIEMPRE. CA-9 lo pide explicitamente para `project_not_found`, y no hay razon
   * para tenerlo solo ahi: es el dato que cruza este log con el de `core`.
   */
  logContext(projectId: number): Record<string, unknown> {
    return {
      diagnosis: this.diagnosis,
      sdkErrorClass: this.sdkErrorClass,
      projectId,
      planoDeEscrituraAbierto: this.planoDeEscrituraAbierto,
      ...(this.errorCode === undefined ? {} : { code: this.errorCode }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.coreMessage === undefined ? {} : { errorMessage: this.coreMessage }),
    };
  }
}
