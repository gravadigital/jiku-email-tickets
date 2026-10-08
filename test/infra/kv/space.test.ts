import { Client } from '@gravadigital/jiku';
import { connect } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { KvSpaceUnavailableError } from '#infra/kv/errors.js';
import { openKvSpace } from '#infra/kv/space.js';
import { createLogger } from '#shared/logger.js';

import { TEST_INSTANCE, TEST_USER_ID, setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * TS-21 a TS-26 del Story Plan de S-032: `openKvSpace()`, contra un NATS **real**.
 *
 * Es el par indispensable de `errors.test.ts`: alla el diagnostico se afirma sobre clases del SDK
 * construidas a mano, y aca sobre los errores que el SDK produce de verdad contra el servidor. Sin
 * este archivo, los unit tests podrian estar afirmando sobre una forma que el SDK no emite nunca —
 * el modo de falla exacto que la convencion `testing` senala para los dobles.
 *
 * - JetStream con `JIKU_KV`: el contenedor propio de `helpers.ts`.
 * - JetStream apagado: el contenedor COMPARTIDO, que arranca sin `-js` (doble gratis).
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'test',
} as unknown as AppConfig;

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

/**
 * Un cliente NUEVO de la misma identidad, sobre la misma conexion.
 *
 * El SDK cachea la promesa de `client.kv()` por cliente (un fallo no se cachea, un exito si): una vez
 * que `nats.client` abrio el espacio, borrar el bucket no cambia lo que devuelve. Los escenarios
 * "el bucket no esta usable" necesitan un cliente que todavia no lo ligo, que es lo que es un
 * proceso del conector recien arrancado.
 */
function freshClient(): Client {
  return Client.fromConnection(nats.connection, { instance: TEST_INSTANCE, userId: TEST_USER_ID });
}

function opened(capture: LogCapture): Record<string, unknown>[] {
  return capture.lines().filter((line) => line['msg'] === 'espacio KV abierto');
}

let nats: JetStreamNats;
let bus: TestBusContext;

beforeAll(async () => {
  nats = await startJetStreamNats();
  bus = await setupTestBus(inject('natsUrl'));
}, 120_000);

afterAll(async () => {
  await bus?.cleanup();
  await nats?.stop();
});

describe('el helper de tests crea y borra JIKU_KV', () => {
  it('bucketExists / deleteBucket / createBucket', async () => {
    expect(await nats.bucketExists()).toBe(true);
    await nats.deleteBucket();
    expect(await nats.bucketExists()).toBe(false);
    await nats.createBucket();
    expect(await nats.bucketExists()).toBe(true);
  });
});

describe('openKvSpace — el espacio se abre', () => {
  // TS-21
  it('TS-21: abre el espacio con UNA llamada a client.kv() y loguea bucket y kvPrefix', async () => {
    const { logger, capture } = loggerWithCapture();
    const kvSpy = vi.spyOn(nats.client, 'kv');

    try {
      const space = await openKvSpace({ client: nats.client, logger });

      expect(kvSpy).toHaveBeenCalledTimes(1);
      const lines = opened(capture);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        msg: 'espacio KV abierto',
        bucket: 'JIKU_KV',
        kvPrefix: 'test.test-machine-user.',
      });
      // El campo NO se llama `key`: REDACT_PATHS lo redactaria en silencio.
      expect(lines[0]).not.toHaveProperty('key');

      await space.put('tickets.alfa', '42');
      const entry = await space.get('tickets.alfa');
      expect(entry).toBeDefined();
      expect(new TextDecoder().decode(entry?.value)).toBe('42');
    } finally {
      kvSpy.mockRestore();
    }
  });

  // TS-22
  it('TS-22: el conector maneja solo la parte derecha: la entrada vive bajo el prefijo de la identidad', async () => {
    const { logger } = loggerWithCapture();
    const space = await openKvSpace({ client: nats.client, logger });
    await space.put('tickets.alfa', '42');

    // El direct get CRUDO, con la clave completa: el prefijo `test.test-machine-user.` lo agrego el
    // SDK. Si el conector armara la clave entera, aca habria un prefijo duplicado.
    const reply = await nats.connection.request(
      '$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.test.test-machine-user.tickets.alfa',
      '',
    );
    expect(reply.string()).toBe('42');
  });
});

describe('openKvSpace — el espacio no esta usable', () => {
  afterEach(async () => {
    // Estos casos borran o reconfiguran JIKU_KV: se deja como lo dejo el helper para lo que venga.
    if (await nats.bucketExists()) await nats.deleteBucket();
    await nats.createBucket();
  });

  // TS-23
  it('TS-23: sin JIKU_KV no abre, no loguea la linea info y NO lo crea', async () => {
    const { logger, capture } = loggerWithCapture();
    await nats.deleteBucket();

    const error: unknown = await openKvSpace({ client: freshClient(), logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvSpaceUnavailableError);
    expect(error).toMatchObject({
      diagnosis: 'bucket_no_usable',
      bucket: 'JIKU_KV',
      errorClass: 'JikuNoBucket',
    });
    expect((error as KvSpaceUnavailableError).causes[0]).toContain('does not exist');
    expect(opened(capture)).toEqual([]);
    // El conector nunca crea el bucket: despues del fallo, sigue sin existir.
    expect(await nats.bucketExists()).toBe(false);
  });

  // TS-24
  it('TS-24: un bucket sin allow_direct es bucket_no_usable y no sugiere grants', async () => {
    const { logger } = loggerWithCapture();
    await nats.deleteBucket();
    await nats.createBucket({ allow_direct: false });

    const error: unknown = await openKvSpace({ client: freshClient(), logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvSpaceUnavailableError);
    expect(error).toMatchObject({ diagnosis: 'bucket_no_usable' });
    expect((error as KvSpaceUnavailableError).causes[0]).toContain('allow_direct');
    // El texto del CONECTOR no manda a pedir grants: el arreglo es el bucket.
    expect((error as KvSpaceUnavailableError).message).not.toMatch(/grant|permis/i);
  });
});

describe('openKvSpace — JetStream apagado y cliente cerrado', () => {
  // TS-25
  it('TS-25: JetStream apagado (el contenedor compartido) es bucket_no_usable', async () => {
    const { logger } = loggerWithCapture();

    const error: unknown = await openKvSpace({ client: bus.client, logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvSpaceUnavailableError);
    expect(error).toMatchObject({ diagnosis: 'bucket_no_usable', errorClass: 'JikuNoBucket' });
    expect((error as KvSpaceUnavailableError).causes[0]).toMatch(/JetStream/);
  });

  // TS-26
  it('TS-26: un cliente cerrado es desconocido, sin mapearse a otra causa', async () => {
    const { logger } = loggerWithCapture();
    const nc = await connect({ servers: nats.url });
    const closed = Client.fromConnection(nc, { instance: 'test', userId: 't-closed' });
    await nc.close();

    const error: unknown = await openKvSpace({ client: closed, logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KvSpaceUnavailableError);
    expect(error).toMatchObject({ diagnosis: 'desconocido', errorClass: 'JikuNotConnected' });
  });
});
