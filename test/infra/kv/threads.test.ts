import { createHash } from 'node:crypto';

import { JikuBucketFull } from '@gravadigital/jiku';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { threadKey } from '#infra/kv/keys.js';
import type { KvSpace } from '#infra/kv/space.js';
import { lookupThread, recordThreadEntry } from '#infra/kv/threads.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';
import { spyOnSpace, withFailingGet, withFailingPut } from './space-doubles.js';

/**
 * TS-35 a TS-43 del Story Plan de S-032 (las operaciones del Mapa de Hilos de S-026, TS-5 a TS-16,
 * adaptadas al Espacio KV), contra el `JIKU_KV` **real** (convencion `testing`: el bus no se mockea).
 *
 * Lo que cambio respecto de S-026 es solo a que apuntan: el handle es el ESPACIO de la identidad
 * (no el bucket `MAIL_THREADS`), la clave gana el prefijo `hilos.`, y `get()` devuelve `undefined`
 * en lugar de `null`. Las propiedades son las mismas.
 *
 * Cada test usa un ESPACIO FRESCO (otra identidad sobre el mismo bucket) en lugar de un bucket por
 * test: el prefijo aisla igual, y el `KV` del SDK no lista claves. Por eso "escribio UNA entrada"
 * se afirma con el espia de `put()` y un `get()` dirigido, no contando claves.
 *
 * Lo unico que se dobla es el borde que no se puede provocar contra un bucket sano: un `put()` o un
 * `get()` que RECHAZAN (`space-doubles.ts`). El espia envuelve el espacio REAL y solo registra.
 *
 * Los hashes se calculan en el test con `createHash` propio, nunca importados de `src/`.
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'test',
} as unknown as AppConfig;

const WRITE_FAILED_MESSAGE =
  'no se pudo escribir la entrada del Mapa de Hilos; el requisito ya se creo y no se compensa';
const MALFORMED_MESSAGE = 'una entrada del Mapa de Hilos tiene un requirementId invalido y se saltea';

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function expectedHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function decode(entry: { value: Uint8Array } | undefined): string | undefined {
  return entry === undefined ? undefined : new TextDecoder().decode(entry.value);
}

let nats: JetStreamNats;
let spaceCounter = 0;

/** Un espacio VACIO propio por test: otra identidad sobre el mismo `JIKU_KV`. */
async function freshSpace(): Promise<KvSpace> {
  spaceCounter += 1;
  return nats.spaceFor(`hilos-t${String(spaceCounter)}`);
}

beforeAll(async () => {
  nats = await startJetStreamNats();
}, 120_000);

afterAll(async () => {
  await nats?.stop();
});

describe('recordThreadEntry — el write despues del alta', () => {
  // TS-35 (S-026 TS-5 y TS-6)
  it('TS-35: escribe UNA entrada, bajo hilos.<sha256>, nunca bajo el Message-Id crudo', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnSpace(space);
    const hashedKey = 'hilos.7482ad61199c790f5aa60568566e4a3973cc2f5ebabfbe57fd0a279ce7eef47e';
    expect(hashedKey).toBe(`hilos.${expectedHash('<abc@cliente.com>')}`);

    await recordThreadEntry({ space: spy.space, messageId: '<abc@cliente.com>', requirementId: 1234, logger });

    expect(decode(await space.get(hashedKey))).toBe('1234');
    expect(spy.puts).toEqual([{ key: hashedKey, value: '1234' }]);
    expect(capture.lines()).toEqual([]);
  });

  // TS-36 (S-026 TS-7 y TS-8)
  it('TS-36: un put() que rechaza (bucket lleno incluido) NO propaga y loguea errorClass', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    const failing = withFailingPut(
      space,
      new JikuBucketFull(
        'jiku: kv: put "hilos.7482ad61199c790f5aa60568566e4a3973cc2f5ebabfbe57fd0a279ce7eef47e" was refused because the bucket reached its limit.',
      ),
    );

    await expect(
      recordThreadEntry({ space: failing, messageId: '<abc@cliente.com>', requirementId: 1234, logger }),
    ).resolves.toBeUndefined();

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      messageId: '<abc@cliente.com>',
      // El hash SOLO (64 hex), como hoy: es lo que se cruza con el bucket, sin el prefijo.
      messageIdHash: '7482ad61199c790f5aa60568566e4a3973cc2f5ebabfbe57fd0a279ce7eef47e',
      requirementId: 1234,
      errorClass: 'JikuBucketFull',
      msg: WRITE_FAILED_MESSAGE,
    });
    // El campo NO se llama `key`: `REDACT_PATHS` incluye `'key'` y saldria `[REDACTED]`. Y no viaja
    // contenido del mail.
    for (const prohibido of ['body', 'subject', 'senderEmail', 'recipient', 'key', 'text', 'html']) {
      expect(warns[0]?.[prohibido], `el warn lleva ${prohibido}`).toBeUndefined();
    }
    expect(JSON.stringify(warns[0])).not.toContain('[REDACTED]');
  });
});

describe('lookupThread — el lookup ordenado que corta en el primer hit', () => {
  // TS-37 (S-026 TS-9)
  it('TS-37: devuelve el requirementId cuando la unica referencia matchea', async () => {
    const space = await freshSpace();
    const { logger } = loggerWithCapture();
    const key = 'hilos.f5e704b3f744e5aa2d287e872a9d8a11d41bd938e1165e0bd6902ceeb013bb99';
    expect(key).toBe(`hilos.${expectedHash('<r1@x>')}`);
    await space.put(key, '77');
    const spy = spyOnSpace(space);

    const result = await lookupThread({ space: spy.space, referenceIds: ['<r1@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 77 });
    expect(spy.gets).toEqual([key]);
  });

  // TS-38 (S-026 TS-10)
  it('TS-38: itera en ORDEN y corta en el primer hit', async () => {
    const space = await freshSpace();
    const { logger } = loggerWithCapture();
    await space.put(threadKey('<b@x>'), '5');
    await space.put(threadKey('<c@x>'), '6');
    const spy = spyOnSpace(space);

    const result = await lookupThread({ space: spy.space, referenceIds: ['<a@x>', '<b@x>', '<c@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 5 });
    expect(spy.gets).toEqual([`hilos.${expectedHash('<a@x>')}`, `hilos.${expectedHash('<b@x>')}`]);
  });

  // TS-38 (S-026 TS-11)
  it('TS-38b: con hit en la primera, NO se consulta el resto', async () => {
    const space = await freshSpace();
    const { logger } = loggerWithCapture();
    await space.put(threadKey('<r1@x>'), '99');
    await space.put(threadKey('<r2@x>'), '11');
    const spy = spyOnSpace(space);

    const result = await lookupThread({ space: spy.space, referenceIds: ['<r1@x>', '<r2@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 99 });
    expect(spy.gets).toEqual([`hilos.${expectedHash('<r1@x>')}`]);
  });

  // TS-39 (S-026 TS-12)
  it('TS-39: undefined es "no esta" y sigue con la siguiente; sin match es distinguible de un error', async () => {
    const space = await freshSpace();
    const { logger } = loggerWithCapture();
    const spy = spyOnSpace(space);

    const result = await lookupThread({ space: spy.space, referenceIds: ['<x1@x>', '<x2@x>'], logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(spy.gets).toEqual([`hilos.${expectedHash('<x1@x>')}`, `hilos.${expectedHash('<x2@x>')}`]);
  });

  // TS-40 (S-026 TS-13)
  it('TS-40: referenceIds vacio no paga ningun round-trip', async () => {
    const space = await freshSpace();
    const { logger } = loggerWithCapture();
    const spy = spyOnSpace(space);

    const result = await lookupThread({ space: spy.space, referenceIds: [], logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(spy.gets).toEqual([]);
  });

  // TS-41 (S-026 TS-14 y TS-14b)
  it('TS-41: un get() que rechaza es "no se pudo consultar" y CORTA', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnSpace(withFailingGet(space));

    const result = await lookupThread({ space: spy.space, referenceIds: ['<r1@x>', '<r2@x>'], logger });

    expect(result).toEqual({ found: false, consultable: false });
    // Un espacio inaccesible no se vuelve accesible en la referencia siguiente.
    expect(spy.gets).toHaveLength(1);
    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      messageId: '<r1@x>',
      messageIdHash: 'f5e704b3f744e5aa2d287e872a9d8a11d41bd938e1165e0bd6902ceeb013bb99',
    });
  });

  // TS-42 (S-026 TS-15)
  it('TS-42: un valor mal formado no es un hit y la iteracion CONTINUA', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    await space.put(threadKey('<a@x>'), 'no-es-id');
    await space.put(threadKey('<b@x>'), '9');

    const result = await lookupThread({ space, referenceIds: ['<a@x>', '<b@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 9 });
    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ messageIdHash: expectedHash('<a@x>'), msg: MALFORMED_MESSAGE });
    for (const raw of capture.raw()) expect(raw).not.toContain('no-es-id');
  });

  // TS-42 (S-026 TS-16)
  it('TS-42b: un valor 0, negativo o no entero tampoco es un hit', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    await space.put(threadKey('<r1@x>'), '0');
    await space.put(threadKey('<r2@x>'), '-1');
    await space.put(threadKey('<r3@x>'), '4.5');

    const result = await lookupThread({ space, referenceIds: ['<r1@x>', '<r2@x>', '<r3@x>'], logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(capture.lines().filter((line) => line['level'] === 'warn')).toHaveLength(3);
  });

  // TS-43
  it('TS-43: una entrada de CUALQUIER antiguedad matchea (invariante 32: sin TTL)', async () => {
    const { logger } = loggerWithCapture();
    // Un doble que devuelve una entrada de 2020: nada en el conector lee `created`, asi que la edad
    // no cambia el resultado.
    const space: KvSpace = {
      get: (key) =>
        Promise.resolve({
          key,
          value: new TextEncoder().encode('1234'),
          revision: 1,
          created: new Date('2020-01-01T00:00:00.000Z'),
        }),
      put: () => Promise.resolve(1),
    };

    const result = await lookupThread({ space, referenceIds: ['<viejo@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 1234 });
  });
});
