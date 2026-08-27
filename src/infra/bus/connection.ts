import { type Client, type TokenSource, connect } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';
import { BusConnectError, causeChain, diagnoseConnectFailure } from '#infra/bus/errors.js';

/**
 * La UNICA conexion del proceso al bus.
 *
 * Este es el unico archivo del servicio que invoca `connect()`, y hay un test de propiedad que
 * escanea `src/` para afirmarlo. La razon es de costo y de superficie: conectar cuesta un
 * round-trip a Zitadel MAS el handshake que corre el auth-callout, asi que una conexion por
 * operacion multiplicaria las dos cosas. El propio SDK lo dice de su `Client`: *"should be
 * long-lived: one per process, not one per request"*.
 *
 * El modulo no lee `process.env` y no llama a `getLogger()`: la configuracion y el logger llegan
 * por parametro. Eso es lo que permite que los tests le inyecten un logger de captura sin tocar el
 * singleton del proceso.
 */

export interface ConnectToBusOptions {
  readonly config: AppConfig;
  /** La identidad: el `ServiceUser` en produccion, un doble en el borde en los tests. */
  readonly auth: TokenSource;
  readonly logger: Logger;
  /**
   * El contenido del creds, SOLO para tests.
   *
   * `null` le dice al SDK que este bus no necesita creds, que es como se apunta el cliente a un
   * NATS pelado. El SDK lo documenta como `null` y no `''` a proposito, *"so 'no creds' can only
   * ever be something you wrote deliberately"*. En produccion NO se pasa: se usa `credsFile`.
   */
  readonly creds?: string | null | undefined;
}

/**
 * El cliente conservado por toda la vida del proceso.
 *
 * Module-local y no un parametro que se pase de mano en mano: lo que CA-3 exige es que exista UNA
 * conexion por proceso, y un singleton de modulo es la forma directa de decir eso en ESM.
 */
let client: Client | undefined;

/**
 * Cuantas veces se invoco `connect()` del SDK.
 *
 * Expuesto solo para tests, y no es redundante con el escaneo de fuentes: el escaneo prueba que no
 * hay OTRO `connect()` en el codigo; este contador prueba que ESTE no se invoco dos veces. Las dos
 * propiedades juntas son lo que cierra CA-3; ninguna sola alcanza.
 */
let connectInvocations = 0;

/** Solo para tests: cuantas veces se invoco el `connect()` del SDK en este proceso. */
export function connectInvocationCount(): number {
  return connectInvocations;
}

/**
 * Las opciones con que se invoco `connect()`, para tests.
 *
 * Es un SEAM de diagnostico, no un mock: lo que hay que poder afirmar es que las opciones que el
 * conector le pasa al SDK son exactamente las prescriptas —con `onTokenError` presente y sin
 * `userId` ni `inboxPrefix`— y esas tres propiedades NO tienen ningun otro sintoma observable. Si
 * la clave `onTokenError` se borrara, el SDK caeria en su default (un `console.warn` sin redactar)
 * en silencio, y ningun test de comportamiento lo notaria.
 */
let lastConnectOptions: Record<string, unknown> | undefined;

/** Solo para tests: las opciones de la ultima invocacion de `connect()`. */
export function capturedConnectOptions(): Record<string, unknown> | undefined {
  return lastConnectOptions;
}

/** Solo para tests: descarta el cliente conservado para que otro caso pueda construir el suyo. */
export function resetBusForTests(): void {
  client = undefined;
  connectInvocations = 0;
  lastConnectOptions = undefined;
}

/**
 * El callback del refresh del token.
 *
 * REGISTRARLO NO ES OPCIONAL EN LA PRACTICA. El default documentado del SDK es *"a warning on the
 * console"* — o sea un `console.warn` fuera de Pino y por lo tanto SIN `redact`, en un servicio
 * cuyo unico borde es el log y que acaba de invertir una story entera en garantizar que nada sin
 * censurar salga por ahi. Registrarlo no es solo CA-6: es cerrar un escape a la redaccion de S-003.
 *
 * Y no termina el proceso — ni `process.exit()`, ni `throw`, ni cerrar el cliente. Un fallo AL
 * ARRANCAR es fatal; un fallo del refresh EN BACKGROUND no lo es. Son dos momentos distintos y las
 * dos reglas conviven: el token vigente sigue sirviendo, y lo unico que se rompe es el proximo
 * reconnect (NFR-R04).
 */
export function reportTokenRefreshFailure(logger: Logger, error: unknown): void {
  // El contexto es PLANO, de un solo nivel, y eso es una restriccion real y no un gusto: la
  // redaccion de S-003 no tiene comodin profundo, asi que un contexto de tres niveles dejaria un
  // secreto en claro sin fallar ni avisar. Si algun dia hiciera falta anidar mas, hay que agregar
  // la ruta explicita a REDACT_PATHS en la misma tarea.
  logger.error(
    {
      diagnosis: 'refresh_del_token_fallo',
      sdkErrorClass: error instanceof Error ? error.constructor.name : typeof error,
      causes: causeChain(error).map((cause) => cause.message.split('\n')[0] ?? ''),
    },
    'fallo el refresh del token; el proceso sigue vivo con el token vigente y el proximo reconnect se va a rechazar',
  );
}

/**
 * Abre la conexion al bus. Se invoca UNA vez, en el arranque.
 *
 * Una segunda invocacion NO abre una segunda conexion: devuelve el cliente ya conservado y lo
 * avisa por `warn`. Se eligio devolver en vez de lanzar porque lanzar convertiria un descuido de
 * cableado en una caida del proceso en un punto arbitrario —posiblemente con una conexion sana ya
 * abierta— mientras que devolver preserva la invariante que importa (una sola conexion) y deja
 * rastro para arreglar el llamador.
 */
export async function connectToBus({
  config,
  auth,
  logger,
  creds,
}: ConnectToBusOptions): Promise<Client> {
  if (client !== undefined) {
    logger.warn(
      { diagnosis: 'conexion_ya_abierta' },
      'connectToBus() se invoco mas de una vez; se reusa la conexion existente',
    );
    return client;
  }

  // El token se pide ACA, antes de connect(), y no es una duplicacion del trabajo del SDK aunque el
  // SDK haga lo mismo internamente (y el token quede cacheado, asi que no cuesta un round-trip de
  // mas).
  //
  // La razon es el DIAGNOSTICO. Si se deja que falle adentro de connect(), el error llega como un
  // `JikuError` envolviendo lo que sea que el TokenSource haya lanzado —un fetch fallido, un
  // OAuthError, un TypeError— y no hay ninguna forma POSITIVA de reconocerlo por estructura: sale
  // igual que un fallo inclasificable. Atribuirlo por descarte seria adivinar, y un diagnostico
  // equivocado manda a revisar el sistema equivocado (ADR-006).
  //
  // Pidiendolo aca, la atribucion es directa: el error lo produjo una llamada que el conector hizo
  // sabiendo que era la de obtener el token.
  try {
    await auth.token();
  } catch (cause) {
    // El contador NO se incrementa: `connect()` no llego a invocarse. El contador cuenta
    // invocaciones reales del SDK, que es lo que CA-3 afirma.
    throw new BusConnectError('zitadel_no_entrego_token', cause);
  }

  connectInvocations += 1;

  // El objeto se construye una vez y se guarda, en vez de escribirse inline en la llamada: es lo
  // que permite afirmar sobre las opciones REALES —las que el SDK recibio— y no sobre una copia
  // que un test hubiera tenido que reconstruir y que podria divergir sin que nada falle.
  const options = {
    servers: config.servers,
    instance: config.instance,

    // El creds va como RUTA, no como contenido: el SDK lo lee al conectar. Pasarle el contenido
    // implicaria leerlo en el conector, y no hay ninguna razon para tener ese byte en memoria.
    // El `creds` explicito es exclusivo de los tests, que apuntan a un NATS sin operador.
    ...(creds === undefined ? { credsFile: config.credsFile } : { creds }),

    auth,

    // El piso de 15000 lo garantiza el schema de S-002. NO se baja: un timeout mas corto que el
    // del bus convierte una respuesta lenta en un ticket perdido sin reintento (ADR-006).
    timeoutMs: config.timeoutMs,

    onTokenError: (error: unknown) => {
      reportTokenRefreshFailure(logger, error);
    },

    // `userId` NO se pasa, y el `d.ts` del SDK es explicito: *"LEAVE IT UNSET"*. Se deriva del
    // `sub` del token, y el callout solo autoriza publicar bajo la identidad propia — un valor
    // que no coincida con el token produce una violacion de autorizacion, no acceso al espacio
    // de otro. Es tambien CA-2: el user-id sale de la key, nunca de una variable.
    //
    // `inboxPrefix` tampoco se fija: lo fija el SDK siempre, como `_INBOX.<hash(sub)>`. Cualquier
    // otro prefijo —incluido el aleatorio que genera todo cliente NATS por default— hace que la
    // reply se publique donde nadie escucha, y la request expira SIN NINGUN ERROR VISIBLE.
  };

  lastConnectOptions = options;

  try {
    client = await connect(options);

    return client;
  } catch (cause) {
    // El diagnostico se calcula por estructura, no por el texto del mensaje del SDK: ver el
    // comentario largo de `diagnoseConnectFailure()`.
    throw new BusConnectError(diagnoseConnectFailure(cause), cause);
  }
}

/**
 * Cierra la conexion, drenando lo que este en vuelo.
 *
 * Usa `client.close()`, que drena antes de cerrar el socket. NUNCA `await using`: `Symbol.asyncDispose`
 * existe en el `Client`, pero la sintaxis `await using` necesita Node 24 y es un ERROR DE SINTAXIS
 * en Node 22, que es el runtime de este servicio.
 *
 * En esta story nadie la invoca desde produccion: el proceso queda vivo con la conexion abierta y
 * S-005 la hereda. Existe para los tests y para el apagado ordenado que llegara con el tick de
 * FG-2 — agregarlo ahora seria codigo sin criterio que lo verifique.
 */
export async function closeBus(): Promise<void> {
  const open = client;
  client = undefined;
  await open?.close();
}
