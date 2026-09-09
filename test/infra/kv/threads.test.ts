import { createHash } from 'node:crypto';

import type { KV } from '@gravadigital/jiku/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { lookupThread, recordThreadEntry, sha256hex } from '#infra/kv/threads.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * TS-1 a TS-16 del Story Plan de S-026: las tres operaciones del Mapa de Hilos, contra un NATS
 * **real con JetStream** (convencion `testing`: el bus no se mockea).
 *
 * Lo unico que se dobla es el borde que no se puede provocar contra un bucket sano: un `put()` o un
 * `get()` que RECHAZAN. Para eso hay dos dobles minimos de `KV`, porque tirar abajo el contenedor a
 * mitad de un test seria lento y no determinista.
 *
 * El `KV` ESPIA de TS-10/TS-11/TS-13 es distinto: envuelve el handle REAL y solo registra las
 * claves consultadas antes de delegar. No reemplaza el KV — la asercion de orden y de corte tiene
 * que valer contra el KV de verdad, no contra un doble que devuelve lo que el test quiera.
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'dev',
} as unknown as AppConfig;

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function expectedHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Envuelve un handle REAL y registra las claves de cada `get()`, en orden, antes de delegar.
 *
 * Un doble completo no serviria: la asercion "corta en el primer hit" tiene que valer contra el KV
 * de verdad, no contra un objeto que devuelve lo que el test le diga.
 */
function spyOnGets(real: KV): { kv: KV; gets: string[] } {
  const gets: string[] = [];
  const kv = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return async (key: string) => {
          gets.push(key);
          return target.get(key);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as KV;
  return { kv, gets };
}

/** Un `KV` cuyo `put()` rechaza siempre. El unico modo de provocar el bucket inaccesible en caliente. */
function kvWithFailingPut(): KV {
  return {
    put: (): Promise<number> => Promise.reject(new Error('bucket inaccesible')),
  } as unknown as KV;
}

/** Un `KV` cuyo `get()` rechaza siempre. */
function kvWithFailingGet(): { kv: KV; calls: number } {
  const state = { calls: 0 };
  const kv = {
    get: (): Promise<never> => {
      state.calls += 1;
      return Promise.reject(new Error('bucket inaccesible'));
    },
  } as unknown as KV;
  return {
    kv,
    get calls(): number {
      return state.calls;
    },
  };
}

let nats: JetStreamNats;
let bucketCounter = 0;

/** Un bucket VACIO propio por test: sin aislamiento, el conteo de entradas de un test ve el del otro. */
async function freshBucket(): Promise<{ handle: KV; name: string }> {
  bucketCounter += 1;
  const name = `THREADS_T${String(bucketCounter)}`;
  await nats.seedBucket(name);
  return { handle: await nats.openBucket(name), name };
}

beforeAll(async () => {
  nats = await startJetStreamNats();
}, 120_000);

afterAll(async () => {
  await nats.stop();
});

describe('sha256hex — la clave del Mapa de Hilos', () => {
  // TS-1
  it('TS-1: es el sha256 en hex y coincide con el valor de referencia', () => {
    const messageId = '<abc@cliente.com>';
    expect(sha256hex(messageId)).toBe(expectedHash(messageId));
    expect(sha256hex(messageId)).toMatch(/^[0-9a-f]{64}$/);
  });

  // TS-2
  it('TS-2: la clave siempre matchea validKeyRe de la libreria', () => {
    // `validKeyRe` de `@nats-io/kv` (`lib/kv.js:86`). Copiado aca a proposito: el test no debe
    // importar la constante que verifica.
    const validKeyRe = /^[-/=.\w]+$/;
    const entradas = [
      '<abc@cliente.com>',
      '<CAF=+7Kx_9@mail.gmail.com>',
      '<a<b>c@x>',
      '<>',
      'sin-brackets@x.com',
      '<ñ-acentos@cliente.com>',
    ];

    for (const entrada of entradas) {
      const key = sha256hex(entrada);
      expect(key, `${entrada} produjo una clave que la libreria rechazaria`).toMatch(validKeyRe);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // TS-3
  it('TS-3: el hash se calcula sobre el Message-Id CRUDO, con brackets', () => {
    expect(sha256hex('<abc@cliente.com>')).not.toBe(sha256hex('abc@cliente.com'));
    expect(sha256hex('<abc@cliente.com>')).toBe(expectedHash('<abc@cliente.com>'));
  });

  // TS-4
  it('TS-4: no hay normalizacion — el caso y los espacios cambian la clave', () => {
    expect(sha256hex('<ABC@cliente.com>')).not.toBe(sha256hex('<abc@cliente.com>'));
    expect(sha256hex(' <abc@cliente.com> ')).not.toBe(sha256hex('<abc@cliente.com>'));
  });
});

describe('recordThreadEntry — el write despues del alta', () => {
  // TS-5
  it('TS-5: escribe la entrada bajo la clave hasheada', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();

    await recordThreadEntry({
      threads: handle,
      messageId: '<abc@cliente.com>',
      requirementId: 500,
      logger,
    });

    const entry = await handle.get(sha256hex('<abc@cliente.com>'));
    expect(entry).not.toBeNull();
    expect(Number.parseInt(entry?.string() ?? '', 10)).toBe(500);
  });

  // TS-6
  it('TS-6: no escribe bajo el Message-Id sin hashear — el bucket tiene UNA entrada, de 64 hex', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();

    await recordThreadEntry({
      threads: handle,
      messageId: '<abc@cliente.com>',
      requirementId: 500,
      logger,
    });

    const keys: string[] = [];
    for await (const key of await handle.keys()) keys.push(key);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]).toBe(sha256hex('<abc@cliente.com>'));
  });

  // TS-7
  it('TS-7: un put() que rechaza NO propaga: se loguea warn y se sigue', async () => {
    const { logger, capture } = loggerWithCapture();

    await expect(
      recordThreadEntry({
        threads: kvWithFailingPut(),
        messageId: '<abc@cliente.com>',
        requirementId: 500,
        logger,
      }),
    ).resolves.toBeUndefined();

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ messageId: '<abc@cliente.com>', requirementId: 500 });
  });

  // TS-8
  it('TS-8: el warn del write fallido lleva messageIdHash y NO lleva contenido del mail', async () => {
    const { logger, capture } = loggerWithCapture();

    await recordThreadEntry({
      threads: kvWithFailingPut(),
      messageId: '<abc@cliente.com>',
      requirementId: 500,
      logger,
    });

    const warn = capture.lines().find((line) => line['level'] === 'warn');
    expect(warn?.['messageIdHash']).toBe(sha256hex('<abc@cliente.com>'));
    // El campo NO se llama `key`: `REDACT_PATHS` incluye `'key'` y saldria `[REDACTED]`.
    for (const prohibido of ['body', 'subject', 'senderEmail', 'recipient', 'key', 'text', 'html']) {
      expect(warn?.[prohibido], `el warn lleva ${prohibido}`).toBeUndefined();
    }
    expect(JSON.stringify(warn)).not.toContain('[REDACTED]');
  });
});

describe('lookupThread — el lookup ordenado que corta en el primer hit', () => {
  // TS-9
  it('TS-9: devuelve el requirementId cuando la unica referencia matchea', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();
    await handle.put(sha256hex('<r1@x>'), '77');

    const result = await lookupThread({ threads: handle, referenceIds: ['<r1@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 77 });
  });

  // TS-10
  it('TS-10: itera en ORDEN y corta en el primer hit', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();
    await handle.put(sha256hex('<r2@x>'), '88');

    const { kv, gets } = spyOnGets(handle);
    const result = await lookupThread({ threads: kv, referenceIds: ['<r1@x>', '<r2@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 88 });
    expect(gets).toEqual([sha256hex('<r1@x>'), sha256hex('<r2@x>')]);
  });

  // TS-11
  it('TS-11: con hit en la primera, NO se consulta el resto', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();
    await handle.put(sha256hex('<r1@x>'), '99');
    await handle.put(sha256hex('<r2@x>'), '11');

    const { kv, gets } = spyOnGets(handle);
    const result = await lookupThread({ threads: kv, referenceIds: ['<r1@x>', '<r2@x>'], logger });

    expect(result).toEqual({ found: true, requirementId: 99 });
    expect(gets).toEqual([sha256hex('<r1@x>')]);
  });

  // TS-12
  it('TS-12: ninguna referencia matchea es "sin match", distinguible de un error', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();

    const { kv, gets } = spyOnGets(handle);
    const result = await lookupThread({ threads: kv, referenceIds: ['<r1@x>', '<r2@x>'], logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(gets).toEqual([sha256hex('<r1@x>'), sha256hex('<r2@x>')]);
  });

  // TS-13
  it('TS-13: referenceIds vacio no paga ningun round-trip', async () => {
    const { handle } = await freshBucket();
    const { logger } = loggerWithCapture();

    const { kv, gets } = spyOnGets(handle);
    const result = await lookupThread({ threads: kv, referenceIds: [], logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(gets).toEqual([]);
  });

  // TS-14
  it('TS-14: un get() que rechaza es "no se pudo consultar", no "sin match"', async () => {
    const { logger, capture } = loggerWithCapture();
    const failing = kvWithFailingGet();

    const result = await lookupThread({
      threads: failing.kv,
      referenceIds: ['<r1@x>'],
      logger,
    });

    expect(result).toEqual({ found: false, consultable: false });
    expect(capture.lines().filter((line) => line['level'] === 'warn')).toHaveLength(1);
  });

  it('TS-14b: un get() que rechaza CORTA — no sigue con las referencias restantes', async () => {
    const { logger } = loggerWithCapture();
    const failing = kvWithFailingGet();

    await lookupThread({
      threads: failing.kv,
      referenceIds: ['<r1@x>', '<r2@x>', '<r3@x>'],
      logger,
    });

    // Un bucket inaccesible no se vuelve accesible en la referencia siguiente.
    expect(failing.calls).toBe(1);
  });

  // TS-15
  it('TS-15: un valor mal formado no es un hit y la iteracion CONTINUA', async () => {
    const { handle } = await freshBucket();
    const { logger, capture } = loggerWithCapture();
    await handle.put(sha256hex('<r1@x>'), 'no-es-un-numero');
    await handle.put(sha256hex('<r2@x>'), '55');

    const result = await lookupThread({
      threads: handle,
      referenceIds: ['<r1@x>', '<r2@x>'],
      logger,
    });

    expect(result).toEqual({ found: true, requirementId: 55 });
    const warn = capture.lines().find((line) => line['level'] === 'warn');
    expect(warn?.['messageIdHash']).toBe(sha256hex('<r1@x>'));
  });

  // TS-16
  it('TS-16: un valor 0, negativo o no entero tampoco es un hit', async () => {
    const { handle } = await freshBucket();
    const { logger, capture } = loggerWithCapture();
    await handle.put(sha256hex('<r1@x>'), '0');
    await handle.put(sha256hex('<r2@x>'), '-3');
    await handle.put(sha256hex('<r3@x>'), '4.5');

    const result = await lookupThread({
      threads: handle,
      referenceIds: ['<r1@x>', '<r2@x>', '<r3@x>'],
      logger,
    });

    expect(result).toEqual({ found: false, consultable: true });
    expect(capture.lines().filter((line) => line['level'] === 'warn')).toHaveLength(3);
  });
});
