import { Kvm } from '@gravadigital/jiku/nats';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { KvBucketMissingError } from '#infra/kv/errors.js';
import { openKvStores } from '#infra/kv/stores.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * TS-11 a TS-19 del Story Plan de S-024, contra un NATS **real**.
 *
 * Estos tests son el par indispensable de `errors.test.ts`: alla la clasificacion se afirma sobre
 * formas de error construidas a mano, y aca sobre los errores que el SERVIDOR produce de verdad.
 * Sin este archivo, los unit tests podrian estar afirmando sobre una forma que NATS no emite
 * nunca — que es el modo de falla exacto que la convencion `testing` senala para los dobles.
 *
 * El contenedor con `-js` se levanta UNA vez por archivo (`beforeAll`) y se detiene en `afterAll`.
 * Cada caso usa NOMBRES DE BUCKET PROPIOS en vez de limpiar entre casos: un caso que espera "el
 * bucket no existe" no debe encontrarse con el que sembro el caso anterior, y con nombres unicos
 * eso es imposible por construccion en vez de depender de un teardown que alguien puede romper.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const BASE_CONFIG = {
  servers: 'nats://localhost:4222',
  instance: 'dev',
  credsFile: '/run/secrets/sentinel.creds',
  keyFile: '/run/secrets/machine-user.json',
  zitadelProjectId: '307f1f77bcf86cd799439011',
  issuer: 'https://id.grava.io',
  timeoutMs: 15_000,
  verifyProjectId: 42,
  logLevel: 'info',
  nodeEnv: 'production',
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    user: 'u',
    password: 'p',
    mailbox: 'INBOX',
    secure: true,
    connectTimeoutMs: 30_000,
  },
  poll: { cron: '*/5 * * * *', batchSize: 25 },
  ruteo: { subaddressPrefix: 'req', ticketMap: {}, placeholderPrefix: '[archivo' },
  adjuntos: { maxCount: 10, maxSizeBytes: 10_485_760, putTimeoutMs: 30_000 },
} as unknown as AppConfig;

/** Un `AppConfig` con el bloque `kv` del caso. Nada mas del config participa de esta story. */
const configWithKv = (kv: AppConfig['kv']): AppConfig => ({ ...BASE_CONFIG, kv });

const kvConfig = (
  ticketsBucket: string,
  threadsBucket: string,
  threadsTtlDays = 90,
): AppConfig['kv'] => ({
  ticketsBucket,
  threadsBucket,
  threadsTtlDays,
  watchRetryMs: 30_000,
});

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

const warnsOf = (capture: LogCapture): Record<string, unknown>[] =>
  // El logger de este servicio serializa `level` como la ETIQUETA (`'warn'`), no como el numero
  // 40 de pino por default: `createLogger()` configura `formatters.level`. Filtrar por 40 no
  // encuentra nada y el test pasaria en verde sin verificar nada.
  capture.lines().filter((line) => line['level'] === 'warn');

describe('openKvStores contra un NATS con JetStream', () => {
  let nats: JetStreamNats;

  beforeAll(async () => {
    nats = await startJetStreamNats();
  }, 120_000);

  afterAll(async () => {
    await nats?.stop();
  });

  // TS-11
  it('abre los dos buckets cuando existen y el TTL coincide', async () => {
    await nats.seedBucket('OK_TICKETS');
    await nats.seedBucket('OK_THREADS', 90);
    const { logger, capture } = loggerWithCapture();

    const stores = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('OK_TICKETS', 'OK_THREADS', 90)),
      logger,
    });

    expect(stores.tickets).toBeDefined();
    expect(stores.threads).toBeDefined();
    // Los handles son usables, que es lo que S-025 y S-026 van a consumir.
    await expect(stores.tickets.status()).resolves.toBeDefined();
    await expect(stores.threads.status()).resolves.toBeDefined();

    // El TTL coincide, asi que NO hay warn.
    expect(warnsOf(capture)).toHaveLength(0);

    const info = capture.lines().find((line) => line['msg'] === 'buckets del KV abiertos y verificados');
    expect(info).toBeDefined();
    expect(info?.['ticketsBucket']).toBe('OK_TICKETS');
    expect(info?.['threadsBucket']).toBe('OK_THREADS');
  });

  // TS-12
  it('falla rapido NOMBRANDO el bucket de slugs cuando no existe', async () => {
    // Solo el de hilos existe.
    await nats.seedBucket('T12_THREADS', 90);
    const { logger } = loggerWithCapture();

    const error = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T12_TICKETS', 'T12_THREADS')),
      logger,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KvBucketMissingError);
    const kvError = error as KvBucketMissingError;
    expect(kvError.code).toBe('KV_BUCKET_MISSING_ERROR');
    expect(kvError.diagnosis).toBe('bucket_inexistente');
    expect(kvError.bucket).toBe('T12_TICKETS');
    expect(kvError.operation).toBe('status');
    expect(kvError.message).toContain('T12_TICKETS');

    // Y el bucket NO se creo: el conector verifica, nunca crea.
    const kvm = new Kvm(nats.connection);
    const handle = await kvm.open('T12_TICKETS');
    await expect(handle.status()).rejects.toThrow();
  });

  // TS-13
  it('falla rapido NOMBRANDO el bucket de hilos cuando no existe', async () => {
    // Solo el de slugs existe.
    await nats.seedBucket('T13_TICKETS');
    const { logger } = loggerWithCapture();

    const error = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T13_TICKETS', 'T13_THREADS')),
      logger,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KvBucketMissingError);
    const kvError = error as KvBucketMissingError;
    expect(kvError.diagnosis).toBe('bucket_inexistente');
    expect(kvError.bucket).toBe('T13_THREADS');
    expect(kvError.message).toContain('T13_THREADS');

    const kvm = new Kvm(nats.connection);
    const handle = await kvm.open('T13_THREADS');
    await expect(handle.status()).rejects.toThrow();
  });

  // TS-14 — el que verifica que el error nombre el bucket CORRECTO.
  it('nombra el de slugs, y solo ese, cuando faltan los dos', async () => {
    const { logger } = loggerWithCapture();

    const error = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T14_TICKETS', 'T14_THREADS')),
      logger,
    }).catch((caught: unknown) => caught);

    const kvError = error as KvBucketMissingError;
    // El de slugs se verifica primero y se corta ahi: sin el Mapa de Tickets no se rutea nada.
    expect(kvError.bucket).toBe('T14_TICKETS');
    // Y el mensaje NO menciona el otro, para que el operador no dude de cual crear primero.
    expect(kvError.message).not.toContain('T14_THREADS');
  });

  // TS-16
  it('avisa con un warn —y arranca igual— si el TTL del bucket de hilos no coincide', async () => {
    await nats.seedBucket('T16_TICKETS');
    // Sembrado SIN ttl: `status().ttl` reporta 0, que significa "sin TTL".
    await nats.seedBucket('T16_THREADS');
    const { logger, capture } = loggerWithCapture();

    const stores = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T16_TICKETS', 'T16_THREADS', 90)),
      logger,
    });

    // NO rechaza: un TTL distinto no rompe el ruteo, solo cambia la ventana.
    expect(stores.threads).toBeDefined();

    const warns = warnsOf(capture);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.['bucket']).toBe('T16_THREADS');
    expect(warns[0]?.['expectedTtlDays']).toBe(90);
    expect(warns[0]?.['actualTtlMs']).toBe(0);
  });

  // TS-17 — el otro lado de TS-16: verifica que la conversion dias->ms sea correcta.
  it('no avisa cuando el TTL coincide', async () => {
    await nats.seedBucket('T17_TICKETS');
    await nats.seedBucket('T17_THREADS', 30);
    const { logger, capture } = loggerWithCapture();

    await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T17_TICKETS', 'T17_THREADS', 30)),
      logger,
    });

    // 30 * 86400000 === 2592000000. Si la conversion estuviera mal, este warn aparecería.
    expect(warnsOf(capture)).toHaveLength(0);
    expect(30 * MS_PER_DAY).toBe(2_592_000_000);
  });

  // TS-18
  it('no verifica ningun TTL sobre el bucket de slugs', async () => {
    // Un TTL cualquiera en el de slugs, distinto del configurado, y el correcto en el de hilos.
    await nats.seedBucket('T18_TICKETS', 5);
    await nats.seedBucket('T18_THREADS', 90);
    const { logger, capture } = loggerWithCapture();

    await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('T18_TICKETS', 'T18_THREADS', 90)),
      logger,
    });

    // El TTL del bucket de slugs es irrelevante y no se compara contra nada (CA-13).
    expect(warnsOf(capture)).toHaveLength(0);
  });

  // TS-19
  it('rechaza un nombre de bucket invalido con su propio diagnostico', async () => {
    const { logger } = loggerWithCapture();

    const error = await openKvStores({
      client: nats.client,
      config: configWithKv(kvConfig('bad name!', 'T19_THREADS')),
      logger,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KvBucketMissingError);
    const kvError = error as KvBucketMissingError;
    // No cae en 'desconocido': el nombre se valida antes de cualquier I/O, asi que el
    // diagnostico es positivo.
    expect(kvError.diagnosis).toBe('nombre_de_bucket_invalido');
    expect(kvError.bucket).toBe('bad name!');
    expect(kvError.operation).toBe('validate');
  });
});

/**
 * TS-15, contra el contenedor COMPARTIDO — que por no tener JetStream es el doble perfecto y
 * gratis de un despliegue sin JetStream habilitado.
 */
describe('openKvStores contra un NATS sin JetStream', () => {
  let bus: TestBusContext;

  beforeAll(async () => {
    bus = await setupTestBus(inject('natsUrl'));
  });

  afterAll(async () => {
    await bus.cleanup();
  });

  // TS-15
  it('falla nombrando JetStream y los permisos de KV como las dos cosas a revisar', async () => {
    const { logger } = loggerWithCapture();

    const error = await openKvStores({
      client: bus.client,
      config: configWithKv(kvConfig('TICKETS', 'MAIL_THREADS')),
      logger,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KvBucketMissingError);
    const kvError = error as KvBucketMissingError;
    // NO es 'bucket_inexistente' ni 'desconocido': el KV entero no esta disponible.
    expect(kvError.diagnosis).toBe('kv_no_disponible');
    expect(kvError.message).toMatch(/JetStream/i);
    expect(kvError.message).toMatch(/permisos/i);
    // Y NO dice que el bus este inalcanzable: la conexion funciono perfectamente.
    expect(kvError.message).not.toMatch(/inalcanzable|no se pudo conectar/i);
  });
});
