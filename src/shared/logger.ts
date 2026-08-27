import pino from 'pino';

import type { AppConfig } from '#config/index.js';
import { REDACT_CENSOR, REDACT_PATHS } from '#shared/log-redaction.js';
import { SERVICE_NAME } from '#shared/service-info.js';

/**
 * El logger unico del conector.
 *
 * En este servicio el log no es decoracion: es el UNICO borde observable. No hay usuario mirando
 * una pantalla ni request que responder — un ticket perdido no tiene sintoma (ADR-006). De ahi las
 * cuatro propiedades que tienen que valer a la vez: una sola instancia, stdout siempre, el nivel
 * desde la configuracion validada, y `redact` cableado.
 *
 * Este modulo no lee el entorno: recibe todo por parametro. `src/config/env.ts` es el unico lector
 * del entorno de todo el servicio, y esa propiedad esta afirmada por un test que escanea `src/`.
 */

/**
 * Las opciones resueltas, expuestas para poder afirmar sobre ellas.
 *
 * Existe como funcion separada porque TS-2 y TS-3 verifican el TRANSPORTE, y el transporte no se
 * puede observar emitiendo lineas: en desarrollo la salida se va por `pino-pretty` a stdout, no al
 * sink del test. Inspeccionar las opciones resueltas es directo y no depende de internals de Pino.
 */
export function buildLoggerOptions(config: AppConfig): pino.LoggerOptions {
  return {
    // Sin default propio: el default `info` ya vive en `envSchema` (S-002). Duplicarlo aca crearia
    // dos fuentes de verdad que se desincronizan en silencio. `silent` pasa tal cual — Pino lo
    // soporta nativamente y suprime todo.
    level: config.logLevel,

    base: { service: SERVICE_NAME, env: config.nodeEnv },

    // ISO 8601 UTC: lo que la convencion `_base` exige para las fechas en los bordes del sistema, y
    // el log es el borde de este servicio.
    timestamp: pino.stdTimeFunctions.isoTime,

    // La etiqueta textual (`'info'`), no el numero. Un log que hay que traducir mentalmente de 30 a
    // `info` para leerlo es un log peor.
    formatters: { level: (label) => ({ level: label }) },

    // `redact.paths` de Pino espera `string[]` mutable y la constante es readonly, de ahi el spread.
    // NO volver mutable la constante para evitarlo: la inmutabilidad de la lista es deseable.
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  };
}

/**
 * El transporte de desarrollo, o `undefined`.
 *
 * `pino-pretty` es una devDependency y la stage de produccion del Dockerfile instala con
 * `--omit=dev`: en la imagen final el paquete NO EXISTE. Por eso solo se referencia con
 * `nodeEnv === 'development'`, y por eso `createLogger` degrada si igual no resuelve.
 *
 * Esta EXPORTADA para que un test pueda afirmar el target resuelto por entorno. No es un detalle
 * cosmetico: sin este seam, un test solo puede verificar que el logger se construye, y un
 * `developmentTransport` que devolviera `undefined` siempre —o que apuntara al target equivocado—
 * pasaria igual. Lo que hay que poder afirmar es QUE transporte se eligio, no que no exploto.
 */
export const DEVELOPMENT_TRANSPORT_TARGET = 'pino-pretty';

export function developmentTransport(
  config: AppConfig,
  target: string = DEVELOPMENT_TRANSPORT_TARGET,
): pino.TransportSingleOptions | undefined {
  if (config.nodeEnv !== 'development') return undefined;
  return { target, options: { colorize: true } };
}

/**
 * Construye un logger.
 *
 * `destination` es PARA TESTS: permite afirmar sobre la linea serializada (CA-8) sin interceptar
 * `process.stdout`, que con `fileParallelism: false` contaminaria los demas archivos de la suite.
 * El codigo de produccion NO lo pasa — usa el singleton, y sin destino Pino escribe a stdout (fd 1).
 *
 * En ningun caso se configura un transporte de archivo ni un `destination` a un path: los logs van
 * a stdout siempre, en todos los entornos (ADR-006). El antecedente que lo justifica es concreto:
 * los dos backends de Jiku tienen sus transports de archivo con `filename: undefined` en produccion
 * y sus logs no existen desde entonces, sin que nadie se diera cuenta.
 *
 * `transportTarget` TAMBIEN es para tests, y existe por una razon concreta: la degradacion del
 * criterio 12 solo ocurre cuando el target no resuelve, y con `pino-pretty` instalado como
 * devDependency eso nunca pasa corriendo la suite. Sin este parametro el `catch` de abajo quedaria
 * sin cobertura automatizada — verificable a mano en una imagen `--omit=dev`, pero no en CI. El
 * default es el target real, asi que produccion no cambia.
 */
export function createLogger(
  config: AppConfig,
  destination?: pino.DestinationStream,
  transportTarget: string = DEVELOPMENT_TRANSPORT_TARGET,
): pino.Logger {
  const options = buildLoggerOptions(config);

  // Sin transporte (todo lo que no es development) el camino es directo: con destino explicito para
  // los tests, o a stdout (fd 1) para produccion.
  const buildPlain = (): pino.Logger =>
    destination === undefined ? pino(options) : pino(options, destination);

  const transport = developmentTransport(config, transportTarget);
  if (transport === undefined) {
    return buildPlain();
  }

  try {
    // Verificado contra pino@10.3.1: pasar `transport` Y un `destination` NO lanza, pero el
    // transporte GANA y el destino queda sin recibir nada. Un test que inyectara un sink leeria
    // vacio y pasaria en verde — el peor modo de falla posible para una suite cuyo trabajo es
    // detectar un secreto sin censurar. De ahi que el transporte se construya SIN el destino, y que
    // la degradacion de abajo si lo honre: asi su warn queda afirmable sin contaminar la salida.
    return pino({ ...options, transport });
  } catch (error) {
    // Verificado: un target no resoluble lanza EN LA CONSTRUCCION, sincronicamente. Es el escenario
    // real de la imagen de produccion corriendo con NODE_ENV=development.
    //
    // Se degrada a JSON en stdout antes que quedarse sin logger: un worker sin logs es
    // indiagnosticable y el log es su unico borde. Pero NO en silencio — un fallback callado es como
    // se pierde un diagnostico, asi que el logger degradado avisa por que quedo degradado.
    const degraded = buildPlain();
    degraded.warn(
      { transportTarget, reason: String(error) },
      'transporte de desarrollo no disponible, se degrada a JSON en stdout',
    );
    return degraded;
  }
}

let singleton: pino.Logger | undefined;

/**
 * Inicializa el logger del proceso. Se invoca UNA vez, desde `src/index.ts`, apenas la
 * configuracion valido.
 *
 * Se eligio la inicializacion explicita y no la construccion perezosa en el import porque el
 * `AppConfig` se resuelve de forma ASINCRONA (`loadAppConfig()` es async): construirlo en el import
 * obligaria a disparar la carga de configuracion como efecto de importar el modulo, y eso rompe la
 * propiedad de S-002 de que importar `#config/index.js` no valida nada por su cuenta.
 */
export function initLogger(config: AppConfig): pino.Logger {
  singleton ??= createLogger(config);
  return singleton;
}

/**
 * El logger del proceso.
 *
 * Falla claro si se usa antes de `initLogger()`: en un servicio cuyo unico borde es el log,
 * degradarse a un logger silencioso o a uno con configuracion por defecto —sin `redact`— seria peor
 * que fallar. Un logger sin `redact` es exactamente el modo de falla que esta story existe para
 * cerrar.
 */
export function getLogger(): pino.Logger {
  if (singleton === undefined) {
    throw new Error(
      `${SERVICE_NAME}: el logger se uso antes de initLogger(). Inicializalo en el arranque, ` +
        'apenas la configuracion valido.',
    );
  }
  return singleton;
}

/** Solo para tests: descarta el singleton para que otro caso pueda construir el suyo. */
export function resetLoggerForTests(): void {
  singleton = undefined;
}
