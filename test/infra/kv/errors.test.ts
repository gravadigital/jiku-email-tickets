import {
  JikuError,
  JikuKVPermissionDenied,
  JikuNoBucket,
  JikuNotConnected,
  requiredKVPermissions,
} from '@gravadigital/jiku';
import { describe, expect, it } from 'vitest';

import { KvSpaceUnavailableError, diagnoseKvFailure } from '#infra/kv/errors.js';
import { AppError } from '#shared/errors/index.js';

import { readSource, sourceFiles } from '../../shared/source-scan.js';

/**
 * TS-12 a TS-20 del Story Plan de S-032: el diagnostico del fallo de `client.kv()` y el error del
 * arranque.
 *
 * Desde REQ-008 las clases de error del KV SON importables desde la entrada principal del SDK
 * (`JikuNoBucket`, `JikuKVPermissionDenied`), asi que el diagnostico es por `instanceof` y los tests
 * construyen las clases REALES con sus constructores publicos. Es la forma de cubrir
 * `kv_sin_permisos` sin un servidor con permisos (el E2E real de permisos es S-033). Los escenarios
 * contra un JetStream REAL —donde el error lo produce el servidor y no este archivo— estan en
 * `space.test.ts`.
 */

const NO_BUCKET_MESSAGE =
  'jiku: kv: binding the bucket: the bucket JIKU_KV does not exist on this deployment.';
const TIMEOUT_MESSAGE = 'jiku: kv: binding the bucket: JetStream did not answer within 15000ms.';
const STREAM_INFO_SUBJECT = '$JS.API.STREAM.INFO.KV_JIKU_KV';

describe('diagnoseKvFailure — por clase del SDK', () => {
  // TS-12
  it('TS-12: JikuNoBucket es bucket_no_usable', () => {
    expect(diagnoseKvFailure(new JikuNoBucket(NO_BUCKET_MESSAGE))).toBe('bucket_no_usable');
  });

  // TS-13
  it('TS-13: JikuKVPermissionDenied es kv_sin_permisos', () => {
    const error = new JikuKVPermissionDenied(
      `jiku: kv: the bus refused binding the bucket (${STREAM_INFO_SUBJECT})`,
      STREAM_INFO_SUBJECT,
    );

    expect(diagnoseKvFailure(error)).toBe('kv_sin_permisos');
  });

  // TS-14
  it('TS-14: todo lo demas es desconocido, sin mapearse a otra causa', () => {
    // Un timeout del SDK es un `JikuError` (no un `JikuTimeout`), y NO se adivina: puede ser
    // JetStream caido o un permiso rechazado en silencio, y un diagnostico equivocado manda a
    // revisar el sistema equivocado (ADR-006).
    for (const error of [new JikuError(TIMEOUT_MESSAGE), new JikuNotConnected(), new Error('boom'), 'x', undefined]) {
      expect(diagnoseKvFailure(error)).toBe('desconocido');
    }
  });

  // TS-15 — el test mas importante del set.
  it('TS-15: NO clasifica por el texto del mensaje, ni por name, ni por code', () => {
    // El mensaje correcto, o el `name` de la clase, o el `err_code` de JetStream, pero NO una
    // instancia de la clase del SDK. Si alguno de estos diera otra cosa que 'desconocido', la
    // clasificacion estaria leyendo prosa o campos copiables, y ADR-002 manda las CLASES del SDK.
    const impostores = [
      Object.assign(new Error('the bucket JIKU_KV does not exist'), { name: 'JikuNoBucket' }),
      Object.assign(new Error('stream not found'), { code: 10059 }),
      Object.assign(new Error('the bus refused … pub: allow:'), { name: 'JikuKVPermissionDenied' }),
    ];

    for (const impostor of impostores) {
      expect(diagnoseKvFailure(impostor)).toBe('desconocido');
    }
  });
});

describe('KvSpaceUnavailableError', () => {
  // TS-16
  it('TS-16: el bucket no usable expone sus campos y no sugiere grants', () => {
    const cause = new JikuNoBucket(
      `${NO_BUCKET_MESSAGE}\n\nJetStream said: stream not found (code 404, err_code 10059)`,
    );

    const error = new KvSpaceUnavailableError({ diagnosis: 'bucket_no_usable', cause });

    expect(error.code).toBe('KV_SPACE_UNAVAILABLE_ERROR');
    expect(error.httpStatus).toBe(500);
    expect(error.name).toBe('KvSpaceUnavailableError');
    expect(error.diagnosis).toBe('bucket_no_usable');
    expect(error.bucket).toBe('JIKU_KV');
    expect(error.subject).toBeUndefined();
    expect(error.errorClass).toBe('JikuNoBucket');
    // COMPLETO, con el `\n`: truncar a la primera linea perderia la explicacion del SDK.
    expect(error.causes).toEqual([cause.message]);
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(AppError);

    expect(error.message).toContain('JIKU_KV');
    // Sugerir grants seria el arreglo EQUIVOCADO: el bucket no existe, no tiene allow_direct o
    // JetStream esta apagado (CA-4).
    expect(error.message).not.toMatch(/grant|permis|pub:/i);
  });

  // TS-17
  it('TS-17: el de permisos trae el subject y los grants completos en causes', () => {
    const cause = new JikuKVPermissionDenied(
      `jiku: kv: the bus refused binding the bucket (${STREAM_INFO_SUBJECT})\n` +
        '  The bus refused the subject before JetStream saw anything…\n\n' +
        requiredKVPermissions('dev'),
      STREAM_INFO_SUBJECT,
    );

    const error = new KvSpaceUnavailableError({ diagnosis: 'kv_sin_permisos', cause });

    expect(error.subject).toBe(STREAM_INFO_SUBJECT);
    expect(error.errorClass).toBe('JikuKVPermissionDenied');
    // Los grants vienen DESPUES de la primera linea del mensaje del SDK: con `causes` truncados se
    // perderian, y son el dato que hace accionable el fallo (CA-5).
    expect(error.causes[0]).toContain('$KV.JIKU_KV.dev.{{user_id}}.>');
    expect(error.causes[0]).toContain('$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.dev.{{user_id}}.>');
    // La conexion al bus funciono: el remedio no la pone en duda.
    expect(error.message).not.toMatch(/inalcanzable|no se pudo conectar/i);
  });

  // TS-18
  it('TS-18: un timeout es desconocido, con su clase y su cadena', () => {
    const cause = new JikuError(TIMEOUT_MESSAGE, { cause: new Error('TIMEOUT') });

    const error = new KvSpaceUnavailableError({ diagnosis: diagnoseKvFailure(cause), cause });

    expect(error.diagnosis).toBe('desconocido');
    expect(error.errorClass).toBe('JikuError');
    expect(error.causes).toEqual([TIMEOUT_MESSAGE, 'TIMEOUT']);
  });

  // TS-19
  it('TS-19: tolera una causa que no es un Error', () => {
    const build = (): KvSpaceUnavailableError =>
      new KvSpaceUnavailableError({ diagnosis: 'desconocido', cause: 'texto' });

    expect(build).not.toThrow();
    expect(build().errorClass).toBe('string');
    expect(build().causes).toEqual([]);
  });
});

describe('lo viejo desaparecio y el diagnostico no inspecciona texto', () => {
  // TS-20
  it('TS-20: ningun archivo de src/ nombra el error ni los diagnosticos viejos', () => {
    const viejos = [
      'KvBucketMissingError',
      'KV_BUCKET_MISSING_ERROR',
      'isValidBucketName',
      'nombre_de_bucket_invalido',
      'bucket_inexistente',
      'kv_no_disponible',
      'MS_PER_DAY',
      'expectedTtlDays',
    ];

    for (const { relativePath, code } of sourceFiles()) {
      for (const viejo of viejos) {
        expect(code, `${relativePath} todavia nombra ${viejo}`).not.toContain(viejo);
      }
    }

    const errors = readSource('infra/kv/errors.ts');
    expect(errors).not.toMatch(/\.name\s*===/);
    expect(errors).not.toMatch(/err_code|10059/);
    expect(errors).not.toMatch(/\.message\s*(===|\.includes|\.match|\.startsWith)/);
  });
});
