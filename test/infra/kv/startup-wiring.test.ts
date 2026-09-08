import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { ConfigValidationError } from '#config/errors.js';
import { BusConnectError, KeyLoadError } from '#infra/bus/errors.js';
import { KvBucketMissingError } from '#infra/kv/errors.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';

/**
 * TS-27 a TS-30 del Story Plan de S-024: la rama de `reportStartupFailure()` para el KV.
 *
 * La rama del KV es SUYA y no la del bus, y la diferencia es el punto entero: cuando falta un
 * bucket, la conexion al bus funciono perfectamente. Reportarlo como "el conector no pudo
 * conectarse al bus" mandaria al operador a revisar Zitadel, la red y los montajes de credenciales
 * cuando el arreglo es un `nats kv add` — el diagnostico equivocado que ADR-006 existe para evitar.
 *
 * # POR QUE SE MOCKEA `getLogger()`
 *
 * `initLogger()` construye el singleton SIN aceptar un destino, asi que la unica forma de leer lo
 * que `reportStartupFailure()` emite es interceptar `getLogger()`. No se cambia el codigo de
 * produccion para hacerlo testeable: el modulo del logger ya expone `createLogger(config,
 * destination)` para exactamente esto, y el mock solo hace que el singleton sea ESE logger.
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'dev',
} as unknown as AppConfig;

let capture: LogCapture;

vi.mock('#shared/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/logger.js')>();
  return {
    ...actual,
    // `getLogger()` devuelve el logger de captura del caso en curso. Todo lo demas del modulo
    // —`createLogger`, la redaccion, los formatters— es el REAL: lo que se testea es el reporte,
    // no el logger.
    getLogger: (): ReturnType<typeof actual.createLogger> =>
      actual.createLogger(BASE_CONFIG, capture.stream),
  };
});

// Se importa DESPUES del `vi.mock` para que `startup.ts` resuelva el `getLogger()` mockeado.
const { reportStartupFailure } = await import('../../../src/startup.js');

const kvError = (bucket = 'TICKETS'): KvBucketMissingError =>
  new KvBucketMissingError({
    diagnosis: 'bucket_inexistente',
    bucket,
    operation: 'status',
    cause: Object.assign(new Error('stream not found'), {
      name: 'StreamNotFoundError',
      code: 10059,
    }),
  });

describe('reportStartupFailure con un bucket del KV faltante', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = createLogCapture();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TS-27
  it('sale por logger.fatal con el diagnostico y el bucket en el contexto', () => {
    reportStartupFailure(kvError('TICKETS'));

    const fatals = capture.lines().filter((line) => line['level'] === 'fatal');
    expect(fatals).toHaveLength(1);

    const line = fatals[0];
    expect(line?.['code']).toBe('KV_BUCKET_MISSING_ERROR');
    expect(line?.['diagnosis']).toBe('bucket_inexistente');
    expect(line?.['bucket']).toBe('TICKETS');
    expect(line?.['operation']).toBe('status');

    // El mensaje NO dice que no se pudo conectar al bus: la conexion funciono.
    expect(String(line?.['msg'])).not.toMatch(/conectar|conexion/i);

    // Y NADA sale por stderr: este fallo ocurre con el logger ya construido.
    expect(stderr).not.toHaveBeenCalled();
  });

  // TS-28
  it('el contexto es PLANO: un solo nivel, sin objetos anidados', () => {
    reportStartupFailure(kvError('MAIL_THREADS'));

    const line = capture.lines().find((entry) => entry['level'] === 'fatal');
    expect(line).toBeDefined();

    for (const [key, value] of Object.entries(line ?? {})) {
      if (key === 'causes') {
        // `causes` es un array de STRINGS, no de objetos: la redaccion de pino no tiene comodin
        // profundo, asi que un objeto anidado podria dejar un valor sin redactar.
        expect(Array.isArray(value)).toBe(true);
        for (const cause of value as unknown[]) {
          expect(typeof cause).toBe('string');
        }
        continue;
      }
      expect(typeof value).not.toBe('object');
    }

    // Y no viaja el AppConfig ni el bloque kv completo por ningun nombre.
    expect(line).not.toHaveProperty('config');
    expect(line).not.toHaveProperty('appConfig');
    expect(line).not.toHaveProperty('kv');
  });

  it('el bucket que nombra es el que fallo', () => {
    reportStartupFailure(kvError('MAIL_THREADS'));

    const line = capture.lines().find((entry) => entry['level'] === 'fatal');
    expect(line?.['bucket']).toBe('MAIL_THREADS');
  });
});

describe('reportStartupFailure: las ramas preexistentes no cambian', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = createLogCapture();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TS-29 (primera mitad)
  it('ConfigValidationError sigue saliendo por stderr y NO loguea', () => {
    reportStartupFailure(new ConfigValidationError('configuracion invalida', ['X']));

    expect(stderr).toHaveBeenCalledOnce();
    expect(capture.lines()).toHaveLength(0);
  });

  // TS-29 (segunda mitad)
  it('BusConnectError sigue emitiendo su fatal con su mensaje de conexion', () => {
    reportStartupFailure(new BusConnectError('bus_inalcanzable', new Error('boom')));

    const line = capture.lines().find((entry) => entry['level'] === 'fatal');
    expect(line?.['diagnosis']).toBe('bus_inalcanzable');
    expect(line?.['msg']).toBe('el arranque fallo: el conector no pudo conectarse al bus');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('KeyLoadError sigue emitiendo su fatal', () => {
    reportStartupFailure(new KeyLoadError('la key no se pudo cargar'));

    const line = capture.lines().find((entry) => entry['level'] === 'fatal');
    expect(line?.['code']).toBe('BUS_KEY_LOAD_ERROR');
    expect(line?.['diagnosis']).toBe('key_ilegible');
  });

  // TS-30
  it('un error desconocido sigue cayendo en el fallback de stderr', () => {
    reportStartupFailure(new Error('algo raro'));

    expect(stderr).toHaveBeenCalledOnce();
    const written = String(stderr.mock.calls[0]?.[0]);
    expect(written).toContain('fallo el arranque');
    // NO loguea un fatal: no puede asumir que el logger existe.
    expect(capture.lines().filter((line) => line['level'] === 'fatal')).toHaveLength(0);
  });
});
