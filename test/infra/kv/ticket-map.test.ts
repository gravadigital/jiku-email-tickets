import type { KV, QueuedIterator, KvWatchEntry } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { routeMail } from '#domain/ruteo/route-mail.js';
import { startTicketMapWatch, type TicketMapWatch } from '#infra/kv/ticket-map.js';
import { createLogger } from '#shared/logger.js';

import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * TS-1 a TS-26 del Story Plan de S-025, contra un NATS **real con JetStream**.
 *
 * Los cinco HALLAZGOS del plan tienen cada uno su test de regresion aca, y cada uno esta anotado
 * con el hallazgo que protege: un "simplificador" futuro que rompa uno tiene que leer por que.
 *
 * - TS-4  -> HALLAZGO 2: un bucket VACIO no emite ningun entry. Una espera implementada como
 *            "resolver con el primer entry isUpdate" CUELGA PARA SIEMPRE, y este test lo detecta
 *            por timeout. Es el primer arranque de todo despliegue nuevo.
 * - TS-2  -> HALLAZGO 1: el ULTIMO entry de la carga inicial ya viene con `isUpdate: true`, asi
 *            que hay que APLICARLO antes de resolver, no despues.
 * - TS-9  -> HALLAZGO 4: un `delete` llega como `operation: 'DEL'` y hay que BORRAR la clave.
 * - TS-15 -> HALLAZGO 5: el valor llega como bytes y `string()` no valida nada; `json()` LANZA.
 * - TS-20 -> HALLAZGO 3: cuando el watch se cae, el `for await` TERMINA NORMALMENTE, no lanza.
 *
 * # POR QUE UN CONTENEDOR PROPIO
 *
 * El compartido de `test/global-setup.ts` arranca sin `-js`, asi que no tiene KV. Ver la cabecera
 * de `./helpers.ts`: no se le agrega `-js` al compartido.
 *
 * # NADA DE `sleep`
 *
 * La convencion `testing` lo prohibe. Los efectos asincronicos del watch se esperan con
 * `waitFor(predicado)`, que hace polling de la CONDICION OBSERVABLE y falla nombrandola.
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'dev',
} as unknown as AppConfig;

/** El bloque `kv` del caso. Nada mas del config participa de esta story. */
const kvConfig = (ticketsBucket: string, watchRetryMs = 30_000): Pick<AppConfig, 'kv'> => ({
  kv: {
    ticketsBucket,
    threadsBucket: 'MAIL_THREADS',
    threadsTtlDays: 90,
    watchRetryMs,
  },
});

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

/**
 * Espera a que un predicado se cumpla, haciendo polling de la CONDICION OBSERVABLE.
 *
 * El `label` no es decorativo: un `waitFor` que expira con "timeout" a secas hace que un test rojo
 * cueste media hora de diagnostico. El tope es holgado pero muy por debajo del `testTimeout`
 * global (30_000), para que el fallo sea el mensaje de aca y no el del runner.
 */
async function waitFor(
  label: string,
  predicate: () => boolean,
  { timeoutMs = 10_000, intervalMs = 15 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor expiro tras ${String(timeoutMs)} ms esperando: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Un nombre de bucket unico por caso: dos casos nunca comparten estado del servidor. */
let bucketCounter = 0;
const nextBucket = (prefix: string): string => {
  bucketCounter += 1;
  return `${prefix}_${String(bucketCounter)}`;
};

let nats: JetStreamNats;

/** Los watches abiertos por el caso en curso, para detenerlos en el `afterEach`. */
const openWatches: TicketMapWatch[] = [];

/** Siembra un bucket y lo llena con los pares dados, y devuelve su handle. */
async function seed(bucket: string, entries: Record<string, string> = {}): Promise<KV> {
  await nats.seedBucket(bucket);
  const handle = await nats.openBucket(bucket);
  for (const [key, value] of Object.entries(entries)) {
    await handle.put(key, new TextEncoder().encode(value));
  }
  return handle;
}

/** Da de alta un watch y lo registra para el teardown del caso. */
async function watch(
  tickets: KV,
  bucket: string,
  logger: ReturnType<typeof createLogger>,
  watchRetryMs?: number,
): Promise<TicketMapWatch> {
  const started = await startTicketMapWatch({
    tickets,
    config: kvConfig(bucket, watchRetryMs),
    logger,
  });
  openWatches.push(started);
  return started;
}

beforeAll(async () => {
  nats = await startJetStreamNats();
}, 120_000);

afterEach(() => {
  // Cada caso deja su watch detenido: un loop de background vivo mantendria el proceso ocupado y
  // un `setTimeout` de reintento pendiente podria interferir con el caso siguiente.
  while (openWatches.length > 0) {
    openWatches.pop()?.stop();
  }
});

afterAll(async () => {
  await nats.stop();
});

describe('startTicketMapWatch: initial load', () => {
  // TS-1
  it('populates the map with the existing entries before resolving', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42', beta: '7' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.get('alfa')).toBe(42);
    expect(ticketMap.get('beta')).toBe(7);
    expect(ticketMap.size).toBe(2);
    // Los valores son NUMBER, no el string que vino del bucket.
    expect(typeof ticketMap.get('alfa')).toBe('number');
  });

  // TS-2 — HALLAZGO 1: el ultimo entry inicial ya trae `isUpdate: true`; aplicar ANTES de resolver.
  it('does not resolve until the whole initial load is applied', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { x: '1', y: '2', z: '3' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    // Se inspecciona EN EL MISMO tick en que la promesa resolvio, sin ningun await intermedio: si
    // la implementacion resolviera antes de aplicar el ultimo entry, aca habria 2 y no 3.
    expect(ticketMap.size).toBe(3);
  });

  // TS-3
  it('a mail routes with the map that came from the KV', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+alfa@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  // TS-4 — HALLAZGO 2. Este es el test que protege del bug mas peligroso de la story: contra un
  // bucket vacio el watch NO emite ningun entry, asi que una espera que aguarde un entry no
  // resuelve NUNCA y `runStartup()` cuelga sin log y sin morirse.
  it('resolves immediately against an EMPTY bucket and does not hang', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket);
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.size).toBe(0);
  });

  // TS-5
  it('with an empty map every mail is discarded as slug_no_mapeado', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket);
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+alfa@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: false, motivo: 'slug_no_mapeado', slug: 'alfa' });
  });
});

describe('startTicketMapWatch: hot updates', () => {
  // TS-6
  it('a NEW slug shows up in the map without restarting anything', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    // El equivalente exacto de `nats kv put TICKETS beta 77`.
    await tickets.put('beta', new TextEncoder().encode('77'));

    await waitFor("ticketMap.get('beta') === 77", () => ticketMap.get('beta') === 77);
  });

  // TS-7
  it('the mail of the new slug routes to the new project', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    await tickets.put('beta', new TextEncoder().encode('77'));
    await waitFor("ticketMap.get('beta') === 77", () => ticketMap.get('beta') === 77);

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+beta@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: true, projectId: 77, slug: 'beta' });
  });

  // TS-8
  it('an existing slug CHANGES project in flight', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    await tickets.put('alfa', new TextEncoder().encode('99'));

    await waitFor("ticketMap.get('alfa') === 99", () => ticketMap.get('alfa') === 99);
    expect(ticketMap.size).toBe(1);
  });

  // TS-9 — HALLAZGO 4: el `delete` llega como `operation: 'DEL'`. Aplicar toda entrada como un
  // `set()` dejaria una clave borrada por el operador viviendo para siempre en memoria.
  it('a DELETED slug disappears from the in-memory copy', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42', beta: '7' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    await tickets.delete('beta');

    await waitFor("!ticketMap.has('beta')", () => !ticketMap.has('beta'));
    expect(ticketMap.get('alfa')).toBe(42);
  });

  // TS-10
  it('the mail of a deleted slug degrades to slug_no_mapeado', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42', beta: '7' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    await tickets.delete('beta');
    await waitFor("!ticketMap.has('beta')", () => !ticketMap.has('beta'));

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+beta@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: false, motivo: 'slug_no_mapeado', slug: 'beta' });
  });

  // TS-11 — el bug MAS PROBABLE de la story: si la implementacion REEMPLAZA el Map en cada cambio
  // en vez de mutarlo, `config.ruteo.ticketMap` queda apuntando al primero y el conector nunca ve
  // un slug nuevo. TS-6 podria pasar igual; este test es el que lo detecta.
  it('the Map reference is STABLE: a consumer never has to re-read it', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    const mapaCapturado = ticketMap;

    await tickets.put('gamma', new TextEncoder().encode('55'));

    await waitFor("mapaCapturado.get('gamma') === 55", () => mapaCapturado.get('gamma') === 55);
  });
});

describe('startTicketMapWatch: lowercase normalization', () => {
  // TS-12
  it('an UPPERCASE key in the bucket is normalized when populating the map', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { ALFA: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.get('alfa')).toBe(42);
    expect(ticketMap.has('ALFA')).toBe(false);
  });

  // TS-13
  it('a mail with an uppercase slug routes: normalization on BOTH ends', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+ALFA@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  // TS-14
  it('normalization also applies to an entry that arrives in flight', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);
    await tickets.put('GAMMA', new TextEncoder().encode('88'));

    await waitFor("ticketMap.get('gamma') === 88", () => ticketMap.get('gamma') === 88);
    expect(ticketMap.has('GAMMA')).toBe(false);
  });
});

describe('startTicketMapWatch: malformed values degrade per entry', () => {
  // TS-15 — HALLAZGO 5: `entry.json()` LANZA con un payload que no es JSON, y una excepcion dentro
  // del loop de background mataria el watch entero por un dato malo de UNA clave.
  it('a NON-NUMERIC value is skipped with a warn that names the key', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42', malo: 'no-es-numero' });
    const { logger, capture } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.get('alfa')).toBe(42);
    expect(ticketMap.has('malo')).toBe(false);

    const warns = capture.lines().filter((line) => line['level'] === 'warn');
    expect(warns.some((line) => line['slug'] === 'malo')).toBe(true);
  });

  // TS-16
  it('a zero or negative value is rejected as invalid', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { cero: '0', neg: '-5' });
    const { logger, capture } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.has('cero')).toBe(false);
    expect(ticketMap.has('neg')).toBe(false);

    const warnedSlugs = capture
      .lines()
      .filter((line) => line['level'] === 'warn')
      .map((line) => line['slug']);
    expect(warnedSlugs).toContain('cero');
    expect(warnedSlugs).toContain('neg');
  });

  // TS-17
  it('a non-integer value is rejected', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { frac: '4.5' });
    const { logger, capture } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.has('frac')).toBe(false);
    expect(
      capture
        .lines()
        .filter((line) => line['level'] === 'warn')
        .map((line) => line['slug']),
    ).toContain('frac');
  });

  // TS-18
  it('a malformed value IN FLIGHT does not kill the watch', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    await tickets.put('malo2', new TextEncoder().encode('xyz'));
    await tickets.put('bueno', new TextEncoder().encode('31'));

    // Que la entrada POSTERIOR se aplique es la prueba de que el watch sigue vivo tras el dato malo.
    await waitFor("ticketMap.get('bueno') === 31", () => ticketMap.get('bueno') === 31);
    expect(ticketMap.has('malo2')).toBe(false);
  });

  // TS-19
  it('the projectId is NOT validated against Jiku', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { delta: '999' });
    const { logger } = loggerWithCapture();

    const { ticketMap } = await watch(tickets, bucket, logger);

    expect(ticketMap.get('delta')).toBe(999);
    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+delta@grava.io' },
        { ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: true, projectId: 999, slug: 'delta' });
  });
});

/**
 * La caida del watch (TS-20 a TS-26).
 *
 * El doble se inyecta POR PARAMETRO (`watchFn`), siguiendo el precedente del repo (`imapFlowCtor`
 * en `infra/imap/client.ts`, `Normalize` en `tick.ts`, `cronScheduleFn` en `scheduler.ts`): es lo
 * que permite provocar la caida de forma determinista sin mockear el paquete del KV a nivel de
 * modulo y sin ensanchar la superficie publica.
 *
 * El doble NO simula el watch: delega en el `watch()` real del bucket real y solo CONSERVA el
 * iterador para poder llamarle `stop()`. La caida que provoca es la caida real (HALLAZGO 3: el
 * `for await` sale por la puerta de adelante).
 */
describe('startTicketMapWatch: the watch goes down', () => {
  interface WatchSpy {
    readonly watchFn: () => Promise<QueuedIterator<KvWatchEntry>>;
    /** Detiene el iterador vivo, que es el doble EXACTO de la caida limpia. */
    readonly crash: () => void;
    /** Cuantas veces se dio de alta un watch: el reintento suma uno. */
    readonly calls: () => number;
  }

  function spyOnWatch(tickets: KV): WatchSpy {
    let current: QueuedIterator<KvWatchEntry> | undefined;
    let calls = 0;

    return {
      watchFn: async (): Promise<QueuedIterator<KvWatchEntry>> => {
        calls += 1;
        current = await tickets.watch();
        return current;
      },
      crash: (): void => {
        current?.stop();
      },
      calls: (): number => calls,
    };
  }

  // TS-20 — HALLAZGO 3: `stop()` empuja un centinela que termina el QueuedIterator LIMPIAMENTE. Un
  // `try/catch` alrededor del `for await` NO detecta esta caida, que es la que ocurre de verdad.
  it('detects the crash when the iterator ends NORMALLY (not only on throw)', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 3_600_000),
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(started);

    spy.crash();

    await waitFor('un warn por la caida del watch', () =>
      capture.lines().some((line) => line['level'] === 'warn'),
    );
  });

  // TS-21
  it('with the watch down the map is PRESERVED and routing keeps working', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 3_600_000),
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(started);

    const sizeBefore = started.ticketMap.size;
    spy.crash();
    await waitFor('un warn por la caida del watch', () =>
      capture.lines().some((line) => line['level'] === 'warn'),
    );

    expect(started.ticketMap.size).toBe(sizeBefore);
    expect(
      routeMail(
        { referenceIds: [], recipient: 'tickets+alfa@grava.io' },
        { ticketMap: started.ticketMap, subaddressPrefix: 'tickets' },
      ),
    ).toEqual({ ok: true, projectId: 42, slug: 'alfa' });
  });

  // TS-22 / TS-23
  it('with the watch down a new slug does NOT appear: the map is frozen, and the log names it', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    // El reintento va MUY alto a proposito: no debe interferir con lo que este test observa.
    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 3_600_000),
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(started);

    spy.crash();
    await waitFor('un warn por la caida del watch', () =>
      capture.lines().some((line) => line['level'] === 'warn'),
    );

    await tickets.put('gamma', new TextEncoder().encode('88'));

    const result = routeMail(
      { referenceIds: [], recipient: 'tickets+gamma@grava.io' },
      { ticketMap: started.ticketMap, subaddressPrefix: 'tickets' },
    );

    // La degradacion es la falla SEGURA, y el slug viaja en el resultado: es lo que hace
    // diagnosticable un watch caido (ADR-006, TS-23).
    expect(result).toEqual({ ok: false, motivo: 'slug_no_mapeado', slug: 'gamma' });
  });

  // TS-24 / TS-25
  it('retries in background and REPOPULATES the whole map, not only the news', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 50),
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(started);

    spy.crash();
    await tickets.put('delta', new TextEncoder().encode('11'));

    // Sin ninguna llamada externa a startTicketMapWatch(): el reintento se dio de alta solo.
    await waitFor("ticketMap.get('delta') === 11", () => started.ticketMap.get('delta') === 11);

    // TS-25: `include` quedo en su default (LastValue), asi que la reanudacion trae el ultimo
    // valor de CADA clave, no solo las novedades.
    expect(started.ticketMap.get('alfa')).toBe(42);
    expect(spy.calls()).toBeGreaterThan(1);
  });

  // TS-26
  it('does not accumulate watches or background loops across retries', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 50),
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(started);

    const warnCount = (): number =>
      capture.lines().filter((line) => line['level'] === 'warn').length;

    // Primera caida y su reintento exitoso.
    spy.crash();
    await waitFor('el primer warn de caida', () => warnCount() >= 1);
    await waitFor('el reintento exitoso', () => spy.calls() >= 2);

    // Segunda caida.
    spy.crash();
    await waitFor('el segundo warn de caida', () => warnCount() >= 2);
    await waitFor('el segundo reintento exitoso', () => spy.calls() >= 3);

    // Exactamente un warn por caida, no N crecientes: no hay loops apilados.
    expect(warnCount()).toBe(2);

    // Y tras el segundo reintento el mapa se actualiza UNA sola vez por put: si hubiera dos loops
    // vivos, el valor seria el mismo pero `spy.calls()` seguiria creciendo sin nuevas caidas.
    const callsAfter = spy.calls();
    await tickets.put('epsilon', new TextEncoder().encode('5'));
    await waitFor("ticketMap.get('epsilon') === 5", () => started.ticketMap.get('epsilon') === 5);
    expect(spy.calls()).toBe(callsAfter);
  });

  it('stop() halts the loop and cancels any pending retry', async () => {
    const bucket = nextBucket('TICKETS');
    const tickets = await seed(bucket, { alfa: '42' });
    const { logger } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    const started = await startTicketMapWatch({
      tickets,
      config: kvConfig(bucket, 50),
      logger,
      watchFn: spy.watchFn,
    });

    started.stop();
    const callsAtStop = spy.calls();

    // Tras el stop no se da de alta ningun watch nuevo, ni siquiera pasado el intervalo de
    // reintento: el `setTimeout` pendiente se cancelo.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(spy.calls()).toBe(callsAtStop);
  });
});
