import { isJikuError } from '@gravadigital/jiku';

import { AppError } from '#shared/errors/index.js';

/**
 * Los errores de arranque del bus y su diagnostico.
 *
 * Este modulo existe por ADR-006: el log tiene que decir QUE SISTEMA rechazo, porque los arreglos
 * estan en lugares distintos. Un log que dice "no pudo conectar" obliga a revisar Zitadel, la red,
 * el creds y el montaje de la key a la vez — y en un servicio sin nadie mirando una pantalla, esa
 * ambiguedad se paga en horas.
 */

/**
 * El diagnostico de un fallo de arranque del bus.
 *
 * Union de literales y no strings sueltos: es lo que hace que un `switch` en el punto de log sea
 * exhaustivo para el typechecker cuando se agregue el sexto caso.
 *
 * Cada valor nombra UN SISTEMA distinto y UN ARREGLO distinto:
 *
 * - `key_ilegible`             -> la key del machine user no se pudo cargar. El montaje del archivo.
 * - `zitadel_no_entrego_token`  -> Zitadel no minteo el token. Key, issuer, reloj, red a Zitadel.
 * - `rechazo_del_bus_por_subject` -> Zitadel SI minteo, el bus lo rechazo. Rol `internal-app`,
 *   Access Token Type = JWT, `JIKU_PROJECT_ID`. NO es el payload.
 * - `bus_inalcanzable`          -> nada contesto. URL, red, el bus caido.
 * - `creds_ilegible`            -> el creds del sentinel no se pudo leer. El montaje del archivo.
 * - `refresh_del_token_fallo`   -> NO es de arranque: el refresh en background. No es fatal.
 * - `desconocido`               -> no encaja en ninguna. Se loguea como tal, sin mapearse a otra.
 */
export type ConnectDiagnosis =
  | 'key_ilegible'
  | 'zitadel_no_entrego_token'
  | 'rechazo_del_bus_por_subject'
  | 'bus_inalcanzable'
  | 'creds_ilegible'
  | 'refresh_del_token_fallo'
  | 'desconocido';

/**
 * La key del machine user no se pudo cargar.
 *
 * Los CUATRO modos de fallo de `ServiceUser.fromKeyFile()` llegan aca (verificados contra el SDK
 * instalado: archivo ausente, JSON mal formado, forma equivocada, y un `key` que no es una private
 * key leible). Se colapsan en un solo error a proposito: los cuatro tienen el mismo arreglo —
 * revisar el archivo montado— y la causa exacta viaja intacta en `cause`.
 */
export class KeyLoadError extends AppError {
  readonly code = 'BUS_KEY_LOAD_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. 500 porque una key ilegible es un fallo del despliegue.
  readonly httpStatus = 500;

  constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, details);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Cuantos niveles de `cause` se recorren antes de rendirse. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Los errores de la cadena de `cause`, del mas externo al mas interno.
 *
 * Con tope de profundidad Y con un set de visitados: un `cause` ciclico —que un envoltorio
 * descuidado puede producir— colgaria el arranque en el unico momento donde el proceso todavia no
 * tiene logger para contarlo.
 */
export function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

/** Los codigos de `errno` que significan "no se llego al servidor". */
const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

/** Los codigos de `errno` que significan "no se pudo leer el archivo". */
const FILESYSTEM_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'EPERM']);

function codeOf(error: Error): string | undefined {
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/**
 * Clasifica un fallo de `connect()` por ESTRUCTURA.
 *
 * NINGUNA rama compara el texto del mensaje del SDK con un literal, y no es purismo: el propio
 * regex del `connectError()` del SDK es
 * `/no servers available|CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND/i`, y `@nats-io/transport-node`
 * reporta un puerto cerrado como `"connection refused"` — minuscula, con espacio — que no matchea
 * ninguna de las cuatro. Verificado: un puerto cerrado cae en la rama GENERICA del SDK
 * (`jiku: connecting to ...`) mientras un host irresoluble cae en la especifica. Clasificar por
 * texto haria que el diagnostico de un puerto cerrado fuera 'desconocido' — o peor, que alguien
 * "arreglara" el regex y mandara al operador a revisar Zitadel por un problema de red.
 *
 * Lo que SI se lee es la forma: el nombre del constructor del error del transporte y los `code` de
 * `errno` de la cadena de causas. Son datos estructurados, no prosa.
 *
 * Devolver `'desconocido'` es un resultado legitimo y NO se mapea a otro (ADR-006: un codigo
 * desconocido se loguea con su clase y su cadena, sin mapearse a nada). Un diagnostico equivocado
 * es peor que uno ausente: manda a revisar el sistema equivocado, que es el fallo exacto que
 * ADR-006 existe para evitar.
 */
export function diagnoseConnectFailure(error: unknown): ConnectDiagnosis {
  if (!isJikuError(error)) return 'desconocido';

  const chain = causeChain(error);
  // El primero es el propio JikuError; lo que clasifica es lo que envuelve.
  const causes = chain.slice(1);

  if (causes.length === 0) return 'desconocido';

  // 1. El bus rechazo el token. `@nats-io/nats-core` lanza AuthorizationError, y el SDK lo
  //    envuelve tal cual. Se compara el `name` y no `instanceof`: dos copias de la libreria en el
  //    arbol tienen dos constructores distintos, y este es el mismo motivo por el que el propio
  //    SDK prefiere `isJikuError()` a `instanceof` para lo suyo.
  if (causes.some((cause) => cause.name === 'AuthorizationError')) {
    return 'rechazo_del_bus_por_subject';
  }

  // 2. El bus no contesto. Se reconoce por los codigos de red de la cadena — que estan tanto en la
  //    rama especifica del SDK como en la generica— y ademas por el ConnectionError del
  //    transporte, que es el envoltorio bajo el que viaja el ECONNREFUSED de un puerto cerrado.
  if (causes.some((cause) => NETWORK_CODES.has(codeOf(cause) ?? '') || cause.name === 'ConnectionError')) {
    return 'bus_inalcanzable';
  }

  // 3. El creds no se pudo leer. Es un modo de fallo que la story no enumera y que el SDK produce
  //    ANTES de abrir el socket, en `readCredsBytes()`. Se distingue de la key porque este error
  //    viene de connect() y aquel de fromKeyFile(); su arreglo esta en el montaje del archivo, no
  //    en Zitadel ni en la red, asi que colapsarlo en 'desconocido' desperdiciaria un diagnostico
  //    que la estructura si permite dar.
  if (causes.some((cause) => FILESYSTEM_CODES.has(codeOf(cause) ?? ''))) {
    return 'creds_ilegible';
  }

  // 4. Cualquier otra cosa es DESCONOCIDA, y se devuelve como tal.
  //
  //    Es tentador cerrar aca con 'zitadel_no_entrego_token' por descarte —el SDK pide el token
  //    antes de abrir el socket, asi que "lo que queda" suele ser eso— y es exactamente lo que no
  //    hay que hacer. La excepcion que lanza un TokenSource puede ser cualquier cosa (un fetch
  //    fallido, un OAuthError, un TypeError), asi que NO hay ninguna forma positiva de reconocerla
  //    por estructura; adivinarla convertiria todo fallo de conexion inclasificable en "revisa
  //    Zitadel", que es precisamente el diagnostico equivocado que ADR-006 existe para evitar.
  //
  //    El fallo de token SI se reconoce con certeza, pero no aca: se detecta en el llamador,
  //    pidiendo el token ANTES de invocar connect() — ver `connectToBus()`. Ahi la atribucion es
  //    positiva y no por descarte, porque el error lo produjo una llamada que el conector hizo.
  return 'desconocido';
}

/** Que revisar para cada diagnostico. Es lo unico que el operador necesita del mensaje. */
const REMEDIES: Record<ConnectDiagnosis, string> = {
  key_ilegible:
    'La key del machine user no se pudo cargar. Revisa que el archivo este montado, sea legible y ' +
    'sea el JSON que Zitadel genero para el machine user.',

  zitadel_no_entrego_token:
    'Zitadel no entrego el access token. Revisa la key del machine user, JIKU_ISSUER, el reloj ' +
    'del host y la red hacia Zitadel. El bus no llego a ver nada.',

  rechazo_del_bus_por_subject:
    'El bus rechazo la conexion por subject: Zitadel SI entrego el token y el auth-callout lo ' +
    'rechazo. El arreglo esta en Zitadel — el rol internal-app asignado en el project de gestion, ' +
    'el Access Token Type en JWT, y JIKU_PROJECT_ID configurado para que el token lleve el claim ' +
    'de roles. NO es un problema del payload ni de core.',

  bus_inalcanzable:
    'Ningun servidor del bus contesto. Revisa JIKU_SERVERS, que el bus este corriendo y que este ' +
    'proceso corra dentro de la red del bus.',

  creds_ilegible:
    'El archivo creds del sentinel no se pudo leer. Revisa que este montado y sea legible: sin el ' +
    'la conexion no llega al auth-callout, aunque no conceda permisos por si mismo.',

  refresh_del_token_fallo:
    'Fallo el refresh del token en background. El token vigente sigue sirviendo: lo que se rompe ' +
    'es el proximo reconnect.',

  desconocido:
    'El fallo no encaja en ninguna causa conocida. La clase del SDK y la cadena de causas van en ' +
    'el contexto de esta linea.',
};

/**
 * No se pudo conectar al bus al arrancar.
 *
 * Expone `diagnosis`, `sdkErrorClass` y `causes` como CAMPOS, no solo dentro del `message`,
 * imitando a `ConfigValidationError` con su `variables`: asi el punto de log y los tests afirman
 * sobre estructura en vez de sobre texto capturado, que es lo que hace que el mensaje se pueda
 * reescribir sin romper nada.
 */
export class BusConnectError extends AppError {
  readonly code = 'BUS_CONNECT_ERROR';
  readonly httpStatus = 500;

  /** Que sistema rechazo. */
  readonly diagnosis: ConnectDiagnosis;

  /**
   * El nombre de la clase del error del SDK.
   *
   * De `constructor.name` y no de un `instanceof` por clase: sirve para el log y no depende de la
   * identidad de constructor entre copias del paquete.
   */
  readonly sdkErrorClass: string;

  /**
   * Los mensajes de la cadena de causas, del mas externo al mas interno.
   *
   * Van como campo porque el mensaje del SDK YA TRAE las causas probables redactadas, y perderlo
   * al envolver seria tirar el mejor diagnostico disponible. Ninguno de ellos contiene
   * credenciales: verificado contra el SDK instalado para los seis modos de fallo.
   */
  readonly causes: string[];

  constructor(diagnosis: ConnectDiagnosis, cause: unknown) {
    const chain = causeChain(cause);
    const sdkErrorClass =
      cause instanceof Error ? cause.constructor.name : typeof cause;

    super(`No se pudo conectar al bus. ${REMEDIES[diagnosis]}`, { diagnosis, sdkErrorClass });

    this.diagnosis = diagnosis;
    this.sdkErrorClass = sdkErrorClass;
    this.causes = chain.map((error) => error.message.split('\n')[0] ?? '');
    this.cause = cause;
  }
}
