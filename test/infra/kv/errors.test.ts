import { describe, expect, it } from 'vitest';

import {
  KvBucketMissingError,
  diagnoseKvFailure,
  isValidBucketName,
} from '#infra/kv/errors.js';
import { AppError } from '#shared/errors/index.js';

/**
 * TS-20 a TS-26 del Story Plan de S-024.
 *
 * Las formas de error que este archivo construye a mano imitan las de `@nats-io/jetstream`
 * VERIFICADAS contra el paquete instalado: `StreamNotFoundError` con `code === 10059` para un
 * bucket ausente, y `JetStreamNotEnabled` para JetStream deshabilitado o sin permisos de KV. Las
 * clases reales NO son importables desde el subpath del SDK (Hallazgo 3), que es exactamente el
 * motivo de que la clasificacion sea estructural y de que estos tests puedan construir la forma a
 * mano. Los escenarios contra un bus REAL —donde el error lo produce el servidor y no este
 * archivo— estan en `stores.test.ts`: sin ese par, estos unit tests podrian estar afirmando sobre
 * una forma que el servidor no produce nunca.
 */

/** Un bucket que no existe, como lo reporta la API de JetStream. */
const streamNotFound = (): Error =>
  Object.assign(new Error('stream not found'), {
    name: 'StreamNotFoundError',
    code: 10059,
  });

/** JetStream deshabilitado — o sin permisos de KV, que es indistinguible (Hallazgo 4). */
const jetStreamNotEnabled = (): Error =>
  Object.assign(new Error('jetstream is not enabled'), { name: 'JetStreamNotEnabled' });

describe('diagnoseKvFailure', () => {
  // TS-20
  it('reconoce el bucket inexistente por su clase y su codigo', () => {
    expect(diagnoseKvFailure(streamNotFound())).toBe('bucket_inexistente');
  });

  // TS-21
  it('reconoce el codigo 10059 aunque el name cambie', () => {
    const renamed = Object.assign(new Error('otro texto'), { name: 'OtroNombre', code: 10059 });

    // El `code` alcanza por si solo: si la libreria renombra la clase, el diagnostico sobrevive.
    expect(diagnoseKvFailure(renamed)).toBe('bucket_inexistente');
  });

  // TS-21 (el otro lado): el name alcanza por si solo si el codigo no viene.
  it('reconoce el name aunque el codigo no venga', () => {
    const noCode = Object.assign(new Error('stream not found'), { name: 'StreamNotFoundError' });

    expect(diagnoseKvFailure(noCode)).toBe('bucket_inexistente');
  });

  // TS-22
  it('reconoce JetStream deshabilitado', () => {
    expect(diagnoseKvFailure(jetStreamNotEnabled())).toBe('kv_no_disponible');
  });

  it('reconoce JetStream deshabilitado a traves de la cadena de causas', () => {
    // Puede llegar envuelto, y por eso la clasificacion recorre la cadena y no solo el error de
    // arriba.
    const wrapped = new Error('kv: no se pudo abrir', { cause: jetStreamNotEnabled() });

    expect(diagnoseKvFailure(wrapped)).toBe('kv_no_disponible');
  });

  // TS-23
  it('no adivina: lo inclasificable es desconocido', () => {
    expect(diagnoseKvFailure(new Error('cualquier cosa'))).toBe('desconocido');
    expect(diagnoseKvFailure('no soy un Error')).toBe('desconocido');
    expect(diagnoseKvFailure(undefined)).toBe('desconocido');
    expect(diagnoseKvFailure(null)).toBe('desconocido');
  });

  // TS-24 — el test mas importante del set.
  it('NO clasifica por el texto del mensaje', () => {
    // El mensaje correcto, pero sin `name` ni `code`. Si esto diera 'bucket_inexistente', la
    // clasificacion estaria leyendo prosa y se romperia el dia que el servidor cambie la cadena.
    const soloElTexto = new Error('stream not found');

    expect(diagnoseKvFailure(soloElTexto)).toBe('desconocido');
  });

  it('NO clasifica JetStream por el texto del mensaje', () => {
    expect(diagnoseKvFailure(new Error('jetstream is not enabled'))).toBe('desconocido');
  });
});

describe('isValidBucketName', () => {
  it('acepta los nombres de los dos buckets por default', () => {
    expect(isValidBucketName('TICKETS')).toBe(true);
    // El `_` esta en `\w`, asi que MAIL_THREADS es valido.
    expect(isValidBucketName('MAIL_THREADS')).toBe(true);
  });

  it('acepta letras, digitos, guion y guion bajo', () => {
    expect(isValidBucketName('kv-bucket_9')).toBe(true);
  });

  it('rechaza lo que la libreria rechazaria', () => {
    // Un espacio, un `.`, un `>` (comodin de subject) y el vacio: los cuatro rompen el regex de
    // `@nats-io/kv` (lib/kv.js:88), asi que se detectan ANTES de cualquier I/O.
    expect(isValidBucketName('bad name!')).toBe(false);
    expect(isValidBucketName('con.punto')).toBe(false);
    expect(isValidBucketName('con>comodin')).toBe(false);
    expect(isValidBucketName('')).toBe(false);
  });
});

describe('KvBucketMissingError', () => {
  // TS-25
  it('expone su diagnostico como campos, no solo en el mensaje', () => {
    const inner = new Error('la causa mas profunda');
    const cause = Object.assign(new Error('stream not found'), {
      name: 'StreamNotFoundError',
      code: 10059,
      cause: inner,
    });

    const error = new KvBucketMissingError({
      diagnosis: 'bucket_inexistente',
      bucket: 'TICKETS',
      operation: 'status',
      cause,
    });

    expect(error.code).toBe('KV_BUCKET_MISSING_ERROR');
    expect(error.httpStatus).toBe(500);
    expect(error.name).toBe('KvBucketMissingError');
    expect(error.diagnosis).toBe('bucket_inexistente');
    expect(error.bucket).toBe('TICKETS');
    expect(error.operation).toBe('status');
    expect(error.errorClass).toBe('Error');
    expect(error).toBeInstanceOf(AppError);

    // La cadena entera, del mas externo al mas interno, como strings planos.
    expect(error.causes).toEqual(['stream not found', 'la causa mas profunda']);
    expect(error.cause).toBe(cause);
  });

  it('registra la clase real del error subyacente', () => {
    class JetStreamApiError extends Error {}

    const error = new KvBucketMissingError({
      diagnosis: 'kv_no_disponible',
      bucket: 'MAIL_THREADS',
      operation: 'status',
      cause: new JetStreamApiError('boom'),
    });

    expect(error.errorClass).toBe('JetStreamApiError');
  });

  it('tolera una causa que no es un Error', () => {
    const error = new KvBucketMissingError({
      diagnosis: 'desconocido',
      bucket: 'TICKETS',
      operation: 'open',
      cause: 'un string suelto',
    });

    expect(error.errorClass).toBe('string');
    expect(error.causes).toEqual([]);
  });

  // TS-26
  it('el mensaje nombra el bucket y su remedio', () => {
    const message = new KvBucketMissingError({
      diagnosis: 'bucket_inexistente',
      bucket: 'MAIL_THREADS',
      operation: 'status',
      cause: streamNotFound(),
    }).message;

    expect(message).toContain('MAIL_THREADS');
    // El remedio: lo crea el operador con `nats kv add`, y el conector NO lo crea a proposito.
    expect(message).toContain('nats kv add');
    expect(message).toMatch(/no lo crea/i);
  });

  it('el remedio de kv_no_disponible nombra LAS DOS cosas a revisar', () => {
    const message = new KvBucketMissingError({
      diagnosis: 'kv_no_disponible',
      bucket: 'TICKETS',
      operation: 'status',
      cause: jetStreamNotEnabled(),
    }).message;

    // Hallazgo 4: son indistinguibles desde el cliente, asi que el mensaje nombra las dos.
    expect(message).toMatch(/JetStream/i);
    expect(message).toMatch(/permisos/i);
    // Y NO dice que el bus este inalcanzable: la conexion funciono.
    expect(message).not.toMatch(/inalcanzable|no se pudo conectar/i);
  });

  it('el mensaje del nombre invalido nombra las dos variables de configuracion', () => {
    const message = new KvBucketMissingError({
      diagnosis: 'nombre_de_bucket_invalido',
      bucket: 'bad name!',
      operation: 'validate',
      cause: undefined,
    }).message;

    expect(message).toContain('KV_TICKETS_BUCKET');
    expect(message).toContain('KV_THREADS_BUCKET');
  });
});
