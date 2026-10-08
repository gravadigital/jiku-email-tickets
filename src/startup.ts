import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import { ConfigValidationError } from '#config/errors.js';
import { type AppConfig, loadAppConfig } from '#config/index.js';
import { connectToBus } from '#infra/bus/connection.js';
import { BusConnectError, KeyLoadError } from '#infra/bus/errors.js';
import { buildServiceUser } from '#infra/bus/identity.js';
import { KvSpaceUnavailableError } from '#infra/kv/errors.js';
import { type KvSpace, openKvSpace } from '#infra/kv/space.js';
import { getLogger, initLogger } from '#shared/logger.js';
import { SERVICE_NAME } from '#shared/service-info.js';

/**
 * La secuencia de arranque, compartida por los DOS entry points.
 *
 * Vive extraida y no inline en `src/index.ts` porque desde S-005 hay dos procesos que arrancan
 * igual: el worker (`npm run start`) y el modo de verificacion (`npm run verify`). Copiar la
 * secuencia produciria dos arranques que divergen en el primer cambio, y el que divergiria en
 * silencio es el que casi nunca se corre.
 *
 * Lo que NO cambia al extraerla: sigue habiendo UNA sola conexion por proceso (ADR-002), porque
 * `connectToBus()` conserva el cliente y tiene el contador que lo afirma.
 */

export interface Startup {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly client: Client;
  /**
   * El Espacio KV de la identidad del conector (REQ-008 / S-032), ya abierto sobre la conexion
   * unica. Guarda los dos mapas (`tickets.*` y `hilos.*`) y viaja por parametro hasta el tick: es el
   * unico handle del KV del proceso.
   */
  readonly space: KvSpace;
}

/**
 * Carga la configuracion, construye el logger, la identidad, conecta al bus y abre el Espacio KV.
 *
 * Devuelve todo para que el llamador decida que hacer despues: el worker queda vivo, el modo de
 * verificacion publica y cierra. Los dos entry points heredan la apertura del espacio por usar esta
 * funcion, y eso es correcto: arrancar contra un despliegue sin `JIKU_KV` usable tiene que fallar en
 * los dos.
 */
export async function runStartup(): Promise<Startup> {
  const config = await loadAppConfig();

  // El logger se construye ACA, apenas la configuracion valido y antes que cualquier otra cosa. No
  // es una preferencia de orden: el Paso 3 (cargar la key), el Paso 4 (obtener el token) y el Paso 5
  // (conectar) son todos posteriores y todos tienen que poder loguear sus fallos por un logger que
  // redacta. Un logger agregado despues de la conexion dejaria sin cubrir exactamente el tramo mas
  // sensible del arranque.
  const logger = initLogger(config);

  // Se loguean solo tres valores no sensibles. NUNCA credsFile, keyFile, zitadelProjectId ni
  // servers: las dos primeras son rutas a secretos —y una ruta a un archivo de credenciales es
  // informacion sobre donde esta el secreto— y las otras dos son topologia del despliegue (ADR-006).
  // Esta decision es de S-002 y se preserva textualmente: sin este comentario, el proximo que toque
  // la linea la va a "completar".
  //
  // Objeto de contexto primero, mensaje estatico segundo (convencion `logging`): asi las lineas son
  // agrupables por mensaje y consultables por campo. timeoutMs va como numero, no como String() —
  // esa es una de las ganancias concretas de loguear estructurado.
  logger.info(
    { instance: config.instance, logLevel: config.logLevel, timeoutMs: config.timeoutMs },
    'configuracion valida',
  );

  // Paso 3: la identidad sale de la KEY, no del entorno. No hace ninguna llamada de red — el
  // `userId` y el `subject()` se derivan del archivo — asi que un fallo aca es siempre del montaje
  // de la key, nunca de Zitadel ni de la red.
  const auth = await buildServiceUser(config);

  // Pasos 4 y 5, en una sola llamada porque el SDK los encadena: pide el token a Zitadel ANTES de
  // abrir el socket, deliberadamente, para que una identidad mal configurada falle diciendo cual de
  // las dos credenciales fue el problema en vez de con un `Authorization Violation` que no nombra
  // ninguna. El cliente resultante se conserva por toda la vida del proceso.
  //
  // El logger va POR PARAMETRO y no por `getLogger()` desde el modulo del bus: asi esas funciones
  // se testean con un logger de captura sin tocar el singleton del proceso.
  const client = await connectToBus({ config, auth, logger });

  // La linea de arranque exitoso. Los tres campos son deliberados y ninguno es una credencial:
  //
  // - `userId` es la identidad PUBLICA en cada subject, y es lo que permite cruzar este log con el
  //   de core cuando falta la fila en `users`.
  // - `inboxPrefix` es un hash del `sub`, no un secreto, y es el dato que diagnostica la trampa
  //   n.1 del bus —una reply publicada donde nadie escucha— sin adivinar. El SDK lo expone
  //   explicitamente *"for diagnostics"*.
  // - `instance` es el token de despliegue de cada subject.
  //
  // Y NO van: credsFile, keyFile, zitadelProjectId, servers ni el token, por lo mismo que la linea
  // de S-002 no los lleva.
  logger.info(
    { instance: client.instance, userId: client.userId, inboxPrefix: client.inboxPrefix },
    'conectado al bus',
  );

  // Paso 5.5 del flujo: el Espacio KV, sobre la conexion que ACABA de abrirse. Es 5.5 y no 6
  // porque el Paso 6 del flujo ya existe y es de otro sistema —Jiku creando la fila del conector en
  // `users` por el evento del auth-callout, que no es un paso de este codigo.
  //
  // Va DESPUES de conectar y no antes por una razon dura y no de estilo: `client.kv()` viaja por
  // `client.connection`, asi que sin cliente no hay conexion sobre la que abrirlo (y no se abre
  // ninguna otra: ADR-002).
  //
  // Y va ANTES de que el llamador schedule el tick: un espacio no usable (sin `JIKU_KV`, sin
  // `allow_direct`, JetStream apagado, o un rol sin los grants) tiene que impedir el arranque, no
  // descubrirse en el primer mail — donde cada mail nuevo se descartaria como `slug_no_consultable`.
  //
  // El error se PROPAGA sin envolverse de nuevo: ya trae su diagnostico, y `reportStartupFailure()`
  // tiene su propia rama para el.
  //
  // (Hasta S-032 habia un Paso 5.6 —el `watch()` del Mapa de Tickets con su carga inicial—. Desde
  // REQ-008 no existe: el slug se consulta una vez por mail, asi que no hay nada que cargar antes
  // del primer tick.)
  const space = await openKvSpace({ client, logger });

  return { config, logger, client, space };
}

/**
 * Reporta un fallo de arranque por el canal que corresponde a su momento.
 *
 * Extraida porque los DOS entry points fallan con las mismas tres clases, y el modo de verificacion
 * agrega una cuarta (`PublishError`, que se loguea en su propia funcion y llega aca ya reportada).
 * Sin esta funcion habria dos copias de la misma logica de reporte, divergiendo en silencio.
 */
export function reportStartupFailure(error: unknown): void {
  // Este reporte NO usa el logger para ConfigValidationError, y la asimetria es deliberada: un
  // fallo de validacion de configuracion ocurre ANTES de que el logger exista, asi que su reporte
  // sale por stderr directo. Del Paso 2 en adelante se falla con logger; el Paso 1 falla sin el.
  // Esta en la tabla de errores del flow y no es un descuido.
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${error.message}\n`);
    return;
  }

  if (error instanceof KeyLoadError || error instanceof BusConnectError) {
    // Estos dos SI salen por el logger: ocurren despues de que se construyo, y el log estructurado
    // es lo unico que hace diagnosticable un worker sin nadie mirando. El contexto lleva el
    // diagnostico —QUE SISTEMA rechazo— porque los arreglos estan en lugares distintos y un
    // "no pudo conectar" a secas obliga a revisar Zitadel, la red y los montajes a la vez.
    //
    // `fatal` y no `error`: el servicio no puede continuar (convencion `logging`).
    //
    // El contexto es PLANO: la redaccion de S-003 no tiene comodin profundo, asi que un contexto
    // anidado dejaria un secreto en claro sin fallar ni avisar. Y no lleva `err`, que arrastraria
    // el stack completo con la cadena de causas: los mensajes viajan ya extraidos en `causes`.
    getLogger().fatal(
      {
        code: error.code,
        ...(error instanceof BusConnectError
          ? { diagnosis: error.diagnosis, sdkErrorClass: error.sdkErrorClass, causes: error.causes }
          : // KeyLoadError NO aporta `causes`: su mensaje nombra la RUTA de la key, que es una ruta
            // a un secreto y por lo tanto no va al log estructurado (ADR-006). El diagnostico que
            // el operador necesita —"la key no se pudo cargar"— esta en el mensaje de la linea y en
            // el `code`; la ruta la sabe, porque es la que configuro en JIKU_KEY_FILE.
            { diagnosis: 'key_ilegible' }),
      },
      'el arranque fallo: el conector no pudo conectarse al bus',
    );
    return;
  }

  // El KV tiene su PROPIA rama y no comparte la del bus, y la diferencia no es cosmetica: cuando
  // el espacio no esta usable, la conexion al bus funciono perfectamente. Reportarlo como "el
  // conector no pudo conectarse al bus" mandaria al operador a revisar Zitadel, la red y los
  // montajes de credenciales cuando el arreglo es el bucket o los grants del rol — el diagnostico
  // equivocado que ADR-006 existe para evitar, y el motivo de que esta rama exista.
  //
  // Sale por el logger porque en este punto YA existe: `initLogger()` corre en el paso 2 y el
  // espacio se abre en el 5.5.
  if (error instanceof KvSpaceUnavailableError) {
    // Contexto PLANO, y sin `err`: los mensajes de la cadena viajan ya extraidos en `causes`,
    // igual que en la rama del bus. `subject` solo cuando el bus rechazo uno (`kv_sin_permisos`).
    // El mensaje no menciona la conexion (funciono) ni los grants (con `bucket_no_usable` serian el
    // arreglo equivocado): los grants que falten, si faltan, viajan en `causes`.
    getLogger().fatal(
      {
        code: error.code,
        diagnosis: error.diagnosis,
        bucket: error.bucket,
        ...(error.subject !== undefined ? { subject: error.subject } : {}),
        errorClass: error.errorClass,
        causes: error.causes,
      },
      'el arranque fallo: el espacio KV no esta usable',
    );
    return;
  }

  // Fallback para lo no reconocido: tampoco puede asumir que el logger se construyo, porque el
  // fallo puede venir de loadAppConfig() o de la construccion misma del logger.
  process.stderr.write(`${SERVICE_NAME}: fallo el arranque: ${String(error)}\n`);
}
