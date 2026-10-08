import { JikuError, JikuKVPermissionDenied, JikuNoBucket, requiredKVPermissions } from '@gravadigital/jiku';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { ConfigValidationError } from '#config/errors.js';
import { BusConnectError, KeyLoadError } from '#infra/bus/errors.js';
import { KvSpaceUnavailableError, diagnoseKvFailure } from '#infra/kv/errors.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';

/**
 * TS-66 a TS-70 del Story Plan de S-032 (las ramas de S-024, TS-27 a TS-30, sobre el Espacio KV): la
 * rama de `reportStartupFailure()` para el KV.
 *
 * La rama del KV es SUYA y no la del bus, y la diferencia es el punto entero: cuando el espacio no
 * esta usable, la conexion al bus funciono perfectamente. Reportarlo como "el conector no pudo
 * conectarse al bus" mandaria al operador a revisar Zitadel, la red y los montajes de credenciales
 * cuando el arreglo es el bucket o los grants del rol — el diagnostico equivocado que ADR-006
 * existe para evitar.
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

const FATAL_MESSAGE = 'el arranque fallo: el espacio KV no esta usable';
const STREAM_INFO_SUBJECT = '$JS.API.STREAM.INFO.KV_JIKU_KV';
const NO_BUCKET_MESSAGE =
  'jiku: kv: binding the bucket: the bucket JIKU_KV does not exist on this deployment.';

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

/** El error del arranque, con el diagnostico que decide `diagnoseKvFailure()` (como en produccion). */
function spaceError(cause: unknown): KvSpaceUnavailableError {
  return new KvSpaceUnavailableError({ diagnosis: diagnoseKvFailure(cause), cause });
}

function permissionDenied(): JikuKVPermissionDenied {
  return new JikuKVPermissionDenied(
    `jiku: kv: the bus refused binding the bucket (${STREAM_INFO_SUBJECT})\n\n` + requiredKVPermissions('dev'),
    STREAM_INFO_SUBJECT,
  );
}

function fatals(): Record<string, unknown>[] {
  return capture.lines().filter((line) => line['level'] === 'fatal');
}

describe('reportStartupFailure con el Espacio KV no usable', () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = createLogCapture();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TS-66 (S-024 TS-27)
  it('TS-66: el bucket no usable sale por su rama fatal, sin sugerir grants', () => {
    reportStartupFailure(spaceError(new JikuNoBucket(NO_BUCKET_MESSAGE)));

    const lines = fatals();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      code: 'KV_SPACE_UNAVAILABLE_ERROR',
      diagnosis: 'bucket_no_usable',
      bucket: 'JIKU_KV',
      errorClass: 'JikuNoBucket',
      causes: [NO_BUCKET_MESSAGE],
      msg: FATAL_MESSAGE,
    });
    expect(lines[0]).not.toHaveProperty('subject');

    // El mensaje NO dice que no se pudo conectar al bus: la conexion funciono.
    expect(String(lines[0]?.['msg'])).not.toMatch(/conectar|conexion/i);
    // Y no manda a pedir grants: con el bucket roto, ese seria el arreglo equivocado (CA-4).
    for (const raw of capture.raw()) expect(raw).not.toMatch(/grant|permis/i);

    // NADA sale por stderr: este fallo ocurre con el logger ya construido.
    expect(stderr).not.toHaveBeenCalled();
  });

  // TS-67
  it('TS-67: sin permisos sale con el subject y los grants en causes', () => {
    reportStartupFailure(spaceError(permissionDenied()));

    const line = fatals()[0];
    expect(line).toMatchObject({
      diagnosis: 'kv_sin_permisos',
      subject: STREAM_INFO_SUBJECT,
      errorClass: 'JikuKVPermissionDenied',
      msg: FATAL_MESSAGE,
    });
    expect((line?.['causes'] as string[])[0]).toContain('$KV.JIKU_KV.dev.{{user_id}}.>');
  });

  // TS-68
  it('TS-68: un timeout sale como desconocido, sin mapearse a otra causa', () => {
    reportStartupFailure(
      spaceError(new JikuError('jiku: kv: binding the bucket: JetStream did not answer within 15000ms.')),
    );

    expect(fatals()[0]).toMatchObject({ diagnosis: 'desconocido', errorClass: 'JikuError', msg: FATAL_MESSAGE });
  });

  // TS-69 (S-024 TS-28)
  it.each([
    ['bucket_no_usable', (): unknown => new JikuNoBucket(NO_BUCKET_MESSAGE)],
    ['kv_sin_permisos', (): unknown => permissionDenied()],
    ['desconocido', (): unknown => new JikuError('timeout')],
  ])('TS-69: el contexto del fatal es PLANO (%s)', (_diagnosis, cause) => {
    reportStartupFailure(spaceError(cause()));

    const line = fatals()[0];
    expect(line).toBeDefined();

    for (const [key, value] of Object.entries(line ?? {})) {
      if (key === 'causes') {
        // `causes` es un array de STRINGS, no de objetos: la redaccion de pino no tiene comodin
        // profundo, asi que un objeto anidado podria dejar un valor sin redactar.
        expect(Array.isArray(value)).toBe(true);
        for (const item of value as unknown[]) {
          expect(typeof item).toBe('string');
        }
        continue;
      }
      expect(typeof value).not.toBe('object');
    }

    // Y no viaja el AppConfig, ningun bloque kv ni el error entero por ningun nombre.
    expect(line).not.toHaveProperty('config');
    expect(line).not.toHaveProperty('appConfig');
    expect(line).not.toHaveProperty('kv');
    expect(line).not.toHaveProperty('err');
  });
});

// TS-70 (S-024 TS-29 y TS-30)
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
