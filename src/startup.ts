import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import { ConfigValidationError } from '#config/errors.js';
import { type AppConfig, loadAppConfig, withTicketMap } from '#config/index.js';
import { connectToBus } from '#infra/bus/connection.js';
import { BusConnectError, KeyLoadError } from '#infra/bus/errors.js';
import { buildServiceUser } from '#infra/bus/identity.js';
import { KvBucketMissingError } from '#infra/kv/errors.js';
import { type KvStores, openKvStores } from '#infra/kv/stores.js';
import { startTicketMapWatch, type TicketMapWatch } from '#infra/kv/ticket-map.js';
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
  /**
   * La configuracion FINAL, ya compuesta con el Mapa de Tickets vivo del KV (S-025).
   *
   * `config.ruteo.ticketMap` es el MISMO objeto `Map` que el watch muta en caliente, no una copia:
   * el tick lo propaga a `routeMail()` tal cual, y un slug agregado con `nats kv put` aparece sin
   * reiniciar el proceso.
   */
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly client: Client;
  /**
   * Los dos buckets del KV, ya abiertos y verificados. El de slugs lo sigue `ticketMapWatch`; el de
   * hilos lo consume S-026, y por eso este campo se conserva entero.
   */
  readonly kv: KvStores;
  /**
   * El watch del Mapa de Tickets (S-025), con su `stop()` para el apagado ordenado.
   *
   * Se expone ademas del `config` porque el `stop()` es lo que baja el loop de background y cancela
   * el reintento pendiente: sin el, el apagado dependeria de que el orden de cierre del bus mate el
   * iterador.
   */
  readonly ticketMapWatch: TicketMapWatch;
}

/**
 * Carga la configuracion, construye el logger, la identidad, conecta al bus, abre los dos buckets
 * del KV y da de alta el watch del Mapa de Tickets.
 *
 * Devuelve todo para que el llamador decida que hacer despues: el worker queda vivo, el modo de
 * verificacion publica y cierra. Los dos entry points heredan la verificacion de los buckets y el
 * alta del watch por usar esta funcion, y eso es correcto: arrancar contra un despliegue sin
 * buckets tiene que fallar en los dos.
 *
 * El `config` que devuelve es el FINAL: el que sale de `loadAppConfig()` es parcial —le falta el
 * Mapa de Tickets, que no puede existir hasta que haya conexion— y se completa en el paso 5.6.
 */
export async function runStartup(): Promise<Startup> {
  // PARCIAL: su `ruteo.ticketMap` es un Map vacio de relleno. El FINAL se compone en el paso 5.6,
  // con el mapa vivo del watch — ver `withTicketMap()` en src/config/index.ts. Todo lo que corre
  // entre aca y el 5.6 (el logger, la identidad, la conexion, los buckets) usa campos que ya estan
  // completos y ninguno mira el mapa, asi que el parcial les alcanza.
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

  // Paso 5.5 del flujo: los dos buckets del KV, sobre la conexion que ACABA de abrirse. Es 5.5 y
  // no 6 porque el Paso 6 del flujo ya existe y es de otro sistema —Jiku creando la fila del
  // conector en `users` por el evento del auth-callout, que no es un paso de este codigo.
  //
  // Va DESPUES de conectar y no antes por una razon dura y no de estilo: el `Kvm` se construye
  // sobre `client.connection`, asi que sin cliente no hay conexion sobre la que construirlo.
  //
  // Y va ANTES de que el llamador schedule el tick: un bucket faltante tiene que impedir el
  // arranque, no descubrirse en el primer mail. Sin el Mapa de Tickets no se puede rutear nada, y
  // un conector arrancado que descarta todo en silencio es el modo de falla que esta verificacion
  // existe para cerrar.
  //
  // El error se PROPAGA sin envolverse de nuevo: ya trae su diagnostico y el nombre del bucket, y
  // `reportStartupFailure()` tiene su propia rama para el.
  const kv = await openKvStores({ client, config, logger });

  // Paso 5.6 del flujo: el `watch()` del Mapa de Tickets sobre el handle que el 5.5 dejo abierto.
  //
  // Va DESPUES del 5.5 porque necesita ese handle, y el mismo razonamiento del comentario de arriba
  // —"un bucket faltante tiene que impedir el arranque, no descubrirse en el primer mail"— se
  // extiende acá con una razon propia y mas dura: `startTicketMapWatch()` ESPERA la carga inicial
  // antes de devolver, y por eso el primer tick nunca corre con el mapa a medio llenar. Si corriera,
  // descartaria como `slug_no_mapeado` mails que rutean bien — y esos mails ya quedaron `\Seen`, o
  // sea que SE PIERDEN. No es una degradacion recuperable.
  //
  // NO se mueve dentro de `openKvStores()`: son dos responsabilidades distintas (abrir/verificar vs.
  // seguir), y `openKvStores()` tiene tests de propiedad sobre su superficie que mezclarlas romperia.
  //
  // Y `reportStartupFailure()` NO gana ninguna rama por esto: la caida del watch en caliente no es
  // un fallo de arranque —es un `warn` con reintento—, y si el ALTA fallara, el error que sale es el
  // `KvBucketMissingError` que S-024 ya traduce, cuya rama ya existe.
  const ticketMapWatch = await startTicketMapWatch({ tickets: kv.tickets, config, logger });

  // El config FINAL: `ruteo.ticketMap` NACE apuntando al Map vivo del watch, y nadie lo reasigna
  // despues. Es lo que hace que el tick vea en caliente los slugs que el operador agrega.
  return {
    config: withTicketMap(config, ticketMapWatch.ticketMap),
    logger,
    client,
    kv,
    ticketMapWatch,
  };
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
  // falta un bucket, la conexion al bus funciono perfectamente. Reportarlo como "el conector no
  // pudo conectarse al bus" mandaria al operador a revisar Zitadel, la red y los montajes de
  // credenciales cuando el arreglo es un `nats kv add` — el diagnostico equivocado que ADR-006
  // existe para evitar, y el motivo de que esta rama exista.
  //
  // Sale por el logger porque en este punto YA existe: `initLogger()` corre en el paso 2 y el KV
  // se abre en el 5.5.
  if (error instanceof KvBucketMissingError) {
    // Contexto PLANO, y sin `err`: los mensajes de la cadena viajan ya extraidos en `causes`,
    // igual que en la rama del bus.
    getLogger().fatal(
      {
        code: error.code,
        diagnosis: error.diagnosis,
        bucket: error.bucket,
        operation: error.operation,
        errorClass: error.errorClass,
        causes: error.causes,
      },
      'el arranque fallo: un bucket del KV no esta usable',
    );
    return;
  }

  // Fallback para lo no reconocido: tampoco puede asumir que el logger se construyo, porque el
  // fallo puede venir de loadAppConfig() o de la construccion misma del logger.
  process.stderr.write(`${SERVICE_NAME}: fallo el arranque: ${String(error)}\n`);
}
