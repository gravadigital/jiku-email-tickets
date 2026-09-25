import type { KV, KvWatchEntry, QueuedIterator } from '@gravadigital/jiku/nats';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { type AppConfig, withTicketMap } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { startTicketMapWatch, type TicketMapWatch } from '#infra/kv/ticket-map.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { type CoreResponder, respondTo } from '../../bus/responder.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * S-028 Tarea 5 (CA-9): el `watch()` del Mapa de Tickets ENCADENADO CON EL TICK, contra un NATS
 * real con JetStream. TS-40 a TS-46.
 *
 * # QUE VERIFICA ESTE ARCHIVO Y QUE NO
 *
 * `test/infra/kv/ticket-map.test.ts` ya cubre `startTicketMapWatch()` extensamente contra JetStream
 * real: la carga inicial, el bucket vacio que no cuelga, el slug nuevo en caliente, el borrado, la
 * estabilidad de la referencia del `Map`, la caida detectada cuando el iterador termina
 * NORMALMENTE, el mapa preservado, el reintento que repuebla el mapa entero, y el `stop()`. **Ese
 * archivo NO se modifica: es la linea de base de CA-9 al nivel del modulo.**
 *
 * Lo que falta, y es el entregable de esta tarea, es EL NIVEL DEL TICK: que un mail al slug nuevo
 * **rutee de punta a punta y cree el Requisito con el `projectId` nuevo, sin reiniciar el proceso**,
 * y que el descarte con el watch caido sea el del TICK, con su `slug` en la linea. La Negative de
 * ADR-004 —*"agregar o cambiar un slug exige reiniciar el proceso"*— queda DEROGADA acá, y esa
 * derogacion es el valor central de REQ-005: se afirma sobre el efecto observable (un requisito
 * creado en el proyecto nuevo), no sobre el estado de un `Map`.
 *
 * # NADA DE SLEEPS DE RELOJ
 *
 * La convencion `testing` los prohibe para esperar una condicion. La propagacion del `put()` se
 * espera con `waitFor(predicado)`, que poll-ea la CONDICION OBSERVABLE y falla nombrandola, con un
 * TOPE — sin el, un fallo real de la propagacion colgaria la suite hasta el `testTimeout` global y
 * el diagnostico seria "el test cuelga" en vez de "el slug nunca llego al mapa".
 */

const BASE_CONFIG: AppConfig = {
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
    user: 'tickets@ejemplo.com',
    password: 'app-password-de-prueba',
  },
  poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
  ruteo: {
    // VACIO a proposito: el mapa real es el `Map` VIVO que `startTicketMapWatch()` devuelve, y
    // `withTicketMap()` es lo que lo compone en el `config` FINAL. Un mapa precargado aca haria que
    // los escenarios pasaran sin que el watch hiciera nada.
    ticketMap: new Map<string, number>(),
    subaddressPrefix: 'tickets',
    placeholderTitle: 'Ticket recibido por mail',
    placeholderBody: '(mail sin contenido)',
  },
  adjuntos: {
    allowedExtensions: ['.png', '.pdf'],
    allowedMimeTypes: ['image/png', 'application/pdf'],
    maxSizeBytes: 10_485_760,
    putTimeoutMs: 30_000,
  },
  kv: {
    ticketsBucket: 'TICKETS',
    threadsBucket: 'MAIL_THREADS',
    threadsTtlDays: 90,
    watchRetryMs: 30_000,
  },
};

/**
 * Espera a que un predicado se cumpla haciendo polling de la CONDICION OBSERVABLE.
 *
 * El `label` no es decorativo: un `waitFor` que expira con "timeout" a secas hace que un test rojo
 * cueste media hora de diagnostico. El tope es holgado pero muy por debajo del `testTimeout` de los
 * casos, para que el fallo sea el mensaje de aca y no el del runner.
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

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

function sourceWith(mails: Map<number, Buffer>): MailSource & { markSeenCalls: number[] } {
  const markSeenCalls: number[] = [];
  return {
    markSeenCalls,
    searchUnseen: (): Promise<number[]> => Promise.resolve([...mails.keys()]),
    fetch: (uid: number): Promise<RawMessage> => {
      const source = mails.get(uid);
      if (source === undefined) throw new Error(`no hay fuente para uid ${String(uid)}`);
      return Promise.resolve({ uid, source });
    },
    markSeen: (uid: number): Promise<void> => {
      markSeenCalls.push(uid);
      return Promise.resolve();
    },
  };
}

/** Un mail al subaddress del slug indicado. */
function mailAlSlug(uid: number, slug: string): Buffer {
  return Buffer.from(
    `Message-Id: <watch-${String(uid)}@fixtures.local>\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      `To: tickets+${slug}@grava.io\r\n` +
      'Subject: Consulta\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Texto del mensaje.\r\n',
  );
}

/**
 * El espia del `watch()`, inyectado POR PARAMETRO (`watchFn`), siguiendo el precedente del repo
 * (`imapFlowCtor`, `Normalize`, `cronScheduleFn`).
 *
 * NO simula el watch: delega en el `watch()` REAL del bucket REAL y solo CONSERVA el iterador para
 * poder llamarle `stop()`. La caida que provoca es la caida REAL —el HALLAZGO 3: el `for await`
 * TERMINA NORMALMENTE, no lanza, asi que un `try { for await } catch {}` NO la detecta—. Es el
 * mismo espia que `ticket-map.test.ts` ya tiene resuelto: se reusa su forma, no se reinventa.
 */
function spyOnWatch(tickets: KV): {
  watchFn: () => Promise<QueuedIterator<KvWatchEntry>>;
  crash: () => void;
  calls: () => number;
} {
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

let bus: TestBusContext;
let nats: JetStreamNats;
let bucketCounter = 0;
const openResponders: CoreResponder[] = [];
const openWatches: TicketMapWatch[] = [];

/** Un bucket de slugs propio por escenario, con las entradas indicadas. */
async function seedTickets(entries: Record<string, string> = {}): Promise<{ bucket: string; tickets: KV }> {
  bucketCounter += 1;
  const bucket = `S028_WATCH_TICKETS_${String(bucketCounter)}`;
  await nats.seedBucket(bucket);
  const tickets = await nats.openBucket(bucket);
  for (const [slug, projectId] of Object.entries(entries)) {
    await tickets.put(slug, new TextEncoder().encode(projectId));
  }
  return { bucket, tickets };
}

/** Un bucket de hilos vacio y propio: el tick lo necesita, pero esta suite no lo verifica. */
async function seedThreads(): Promise<KV> {
  bucketCounter += 1;
  const name = `S028_WATCH_THREADS_${String(bucketCounter)}`;
  await nats.seedBucket(name);
  return nats.openBucket(name);
}

async function responderFor(
  command: string,
  replies: Parameters<typeof respondTo>[2],
): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  openResponders.push(responder);
  return responder;
}

const tickLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

const discardLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'mail descartado');

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
  // Cada caso deja su watch detenido: un loop de background vivo mantendria el proceso ocupado y
  // un `setTimeout` de reintento pendiente podria interferir con el caso siguiente.
  while (openWatches.length > 0) {
    openWatches.pop()?.stop();
  }
});

afterAll(async () => {
  await nats?.stop();
  await bus.cleanup();
});

/* ==========================================================================================
 * CA-9 — EL SLUG NUEVO RUTEA SIN REINICIAR EL PROCESO
 * ========================================================================================== */
describe('E2E: el watch en caliente encadenado con el tick (CA-9)', () => {
  // TS-40 y TS-41 en una sola cadena, porque la referencia estable solo importa DESPUES de que el
  // slug nuevo llego: separarlos afirmaria la referencia contra un mapa que nunca se actualizo.
  it('TS-40/TS-41: un slug agregado con put() rutea SIN reiniciar, y el Map es EL MISMO objeto', async () => {
    const { bucket, tickets } = await seedTickets({ alfa: '42' });
    const threads = await seedThreads();
    const { logger, capture } = loggerWithCapture();

    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket } },
      logger,
    });
    openWatches.push(watch);

    // `withTicketMap()` compone el `config` FINAL, cuyo `ruteo.ticketMap` ES el `Map` vivo del
    // watch. Si el escenario le pasara al tick un config con una COPIA del mapa, la propiedad
    // entera se evaporaria sin que el test lo note: el slug nuevo nunca llegaria a la copia.
    const config = withTicketMap(BASE_CONFIG, watch.ticketMap);
    expect(config.ruteo.ticketMap).toBe(watch.ticketMap);
    const referenciaInicial = config.ruteo.ticketMap;

    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 800 },
    });

    // ---------- TICK 1: `beta` NO esta mapeado -> se descarta ----------
    await runTick(sourceWith(new Map([[1, mailAlSlug(1, 'beta')]])), config, logger, bus.client, threads);

    expect(discardLine(capture)).toMatchObject({ motivo: 'slug_no_mapeado', slug: 'beta' });
    expect(tickLine(capture)).toMatchObject({ descartados: 1, creados: 0 });
    expect(altas.count()).toBe(0);

    // ---------- El operador carga el slug, con el proceso CORRIENDO ----------
    await tickets.put('beta', new TextEncoder().encode('77'));
    // Se awaitea la CONDICION OBSERVABLE, nunca un sleep de reloj.
    await waitFor("ticketMap.get('beta') === 77", () => config.ruteo.ticketMap.get('beta') === 77);

    // TS-41: EL MISMO OBJETO. Es el bug mas probable de todo el modulo: si el watch reemplazara el
    // `Map` en vez de mutarlo, `config.ruteo.ticketMap` quedaria apuntando al PRIMERO, el conector
    // arrancaria bien, rutearia bien los slugs iniciales y NUNCA veria uno nuevo — el valor central
    // de REQ-005 fallando en silencio, sin una sola linea de log.
    expect(config.ruteo.ticketMap).toBe(referenciaInicial);
    expect(config.ruteo.ticketMap).toBe(watch.ticketMap);

    // ---------- TICK 2: el mismo slug ahora RUTEA, en el proyecto NUEVO ----------
    const { logger: l2, capture: c2 } = loggerWithCapture();
    await runTick(sourceWith(new Map([[2, mailAlSlug(2, 'beta')]])), config, l2, bus.client, threads);

    expect(tickLine(c2)).toMatchObject({ creados: 1, descartados: 0, fallidos: 0 });
    // El efecto OBSERVABLE, medido en el bus: el payload lleva el `projectId` NUEVO.
    expect(altas.count()).toBe(1);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(77);

    // Y el proceso no se reinicio: el watch se dio de alta UNA sola vez en todo el escenario (no
    // hay una segunda llamada a `startTicketMapWatch()` en ninguna parte del caso), el `config` que
    // el tick 2 recibio es EL MISMO objeto que el tick 1, y el slug inicial sigue mapeado.
    expect(openWatches).toHaveLength(1);
    expect(config.ruteo.ticketMap).toBe(referenciaInicial);
    expect(watch.ticketMap.get('alfa')).toBe(42);
  }, 90_000);

  // TS-42
  it('TS-42: un slug BORRADO deja de rutear y el tick lo descarta como slug_no_mapeado', async () => {
    const { bucket, tickets } = await seedTickets({ alfa: '42', beta: '77' });
    const threads = await seedThreads();
    const { logger } = loggerWithCapture();

    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket } },
      logger,
    });
    openWatches.push(watch);
    const config = withTicketMap(BASE_CONFIG, watch.ticketMap);
    expect(config.ruteo.ticketMap.get('beta')).toBe(77);

    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 801 },
    });

    await tickets.delete('beta');
    await waitFor("ticketMap.has('beta') === false", () => !config.ruteo.ticketMap.has('beta'));

    const { logger: l2, capture: c2 } = loggerWithCapture();
    await runTick(sourceWith(new Map([[1, mailAlSlug(1, 'beta')]])), config, l2, bus.client, threads);

    // Aplicar un `DEL` como si fuera un `set()` dejaria el slug ruteando PARA SIEMPRE: el operador
    // lo saca del bucket, ve que el comando funciono, y los mails siguen entrando al proyecto del
    // que lo quiso sacar. Por eso el `operation` se mira PRIMERO (una entrada `DEL` trae el `value`
    // VACIO, asi que leerlo antes daria un valor no parseable en vez de un borrado).
    expect(discardLine(c2)).toMatchObject({ motivo: 'slug_no_mapeado', slug: 'beta' });
    expect(tickLine(c2)).toMatchObject({ descartados: 1, creados: 0 });
    expect(altas.count()).toBe(0);
    // Y `alfa` sigue: se borro una clave, no el mapa.
    expect(config.ruteo.ticketMap.get('alfa')).toBe(42);
  }, 90_000);
});

/* ==========================================================================================
 * CA-9 — LA DEGRADACION CON EL WATCH CAIDO
 *
 * La degradacion es la FALLA SEGURA: lo que se pierde son las ACTUALIZACIONES, no el mapa. Vaciar
 * la copia convertiria una caida del bus en PERDIDA DE TICKETS — todos los mails caerian en
 * `slug_no_mapeado` y quedarian `\Seen`, o sea que SE PERDERIAN.
 * ========================================================================================== */
describe('E2E: la degradacion con el watch caido, medida sobre el tick (CA-9)', () => {
  // TS-43 y TS-44 en una cadena: la conservacion del mapa y el slug que no llega son las dos caras
  // de la misma caida, y provocarla dos veces no agrega nada.
  it('TS-43/TS-44: con el watch caido el mapa SE CONSERVA, el tick rutea, y un slug nuevo cae en slug_no_mapeado', async () => {
    const { bucket, tickets } = await seedTickets({ alfa: '42' });
    const threads = await seedThreads();
    const { logger, capture } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    // El reintento va MUY alto a proposito: no debe interferir con lo que este caso observa.
    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket, watchRetryMs: 3_600_000 } },
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(watch);
    const config = withTicketMap(BASE_CONFIG, watch.ticketMap);

    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 802 },
    });

    const sizeAntes = config.ruteo.ticketMap.size;
    expect(sizeAntes).toBe(1);

    // LA CAIDA LIMPIA: `stop()` empuja un centinela que termina el `QueuedIterator` NORMALMENTE
    // (HALLAZGO 3). Es la caida que ocurre de verdad, y la que un `try/catch` alrededor del
    // `for await` NO detecta — por eso la deteccion va DESPUES del loop, en el camino normal.
    spy.crash();
    await waitFor('un warn por la caida del watch', () =>
      capture.lines().some((line) => line['level'] === 'warn'),
    );

    // TS-43: el mapa SE CONSERVA.
    expect(config.ruteo.ticketMap.size).toBe(sizeAntes);
    expect(config.ruteo.ticketMap.get('alfa')).toBe(42);
    // Y hay una linea `warn` que nombra el bucket, para que el operador sepa cual watch se cayo.
    const warn = capture.lines().find((line) => line['level'] === 'warn');
    expect(warn?.['bucket']).toBe(bucket);

    // Y EL TICK SIGUE RUTEANDO los slugs que ya tenia: la caida no es una interrupcion del
    // servicio, es una congelacion de las actualizaciones.
    const { logger: l2, capture: c2 } = loggerWithCapture();
    await runTick(sourceWith(new Map([[1, mailAlSlug(1, 'alfa')]])), config, l2, bus.client, threads);

    expect(tickLine(c2)).toMatchObject({ creados: 1, descartados: 0, fallidos: 0 });
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);

    // TS-44: un slug agregado DURANTE el corte no llega, y el descarte lo NOMBRA.
    await tickets.put('gamma', new TextEncoder().encode('99'));

    const { logger: l3, capture: c3 } = loggerWithCapture();
    await runTick(sourceWith(new Map([[2, mailAlSlug(2, 'gamma')]])), config, l3, bus.client, threads);

    // El `slug` viaja en la linea: es EL DATO QUE HACE FALTA para cargarlo (ADR-006). Sin el, el
    // operador sabe que algo se descarto pero no que buscar en el bucket.
    expect(discardLine(c3)).toMatchObject({ motivo: 'slug_no_mapeado', slug: 'gamma' });
    expect(tickLine(c3)).toMatchObject({ descartados: 1, creados: 0 });
    // Un solo alta en todo el escenario: el de `alfa`.
    expect(altas.count()).toBe(1);
  }, 90_000);

  // TS-45
  it('TS-45: el reintento repuebla el mapa ENTERO, y el mail del slug nuevo entonces SI rutea', async () => {
    const { bucket, tickets } = await seedTickets({ alfa: '42' });
    const threads = await seedThreads();
    const { logger } = loggerWithCapture();
    const spy = spyOnWatch(tickets);

    // `watchRetryMs` se baja SOLO desde el test: el default de produccion (30 s) haria este
    // escenario inviable, y bajarlo en produccion cambiaria el comportamiento del reintento.
    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket, watchRetryMs: 50 } },
      logger,
      watchFn: spy.watchFn,
    });
    openWatches.push(watch);
    const config = withTicketMap(BASE_CONFIG, watch.ticketMap);

    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 803 },
    });

    spy.crash();
    await tickets.put('gamma', new TextEncoder().encode('99'));

    // Sin ninguna llamada externa a `startTicketMapWatch()`: el reintento se da de alta solo.
    await waitFor("ticketMap.get('gamma') === 99", () => config.ruteo.ticketMap.get('gamma') === 99);

    // EL MAPA ENTERO, no solo las novedades: `include` quedo en su default (LastValue), asi que la
    // reanudacion trae el ultimo valor de CADA clave. Si solo trajera las novedades, `alfa` se
    // habria perdido — y un reintento que pierde la mitad del mapa es peor que no reintentar.
    expect(config.ruteo.ticketMap.get('alfa')).toBe(42);
    expect(config.ruteo.ticketMap.size).toBe(2);
    expect(spy.calls()).toBeGreaterThan(1);

    // Y el efecto observable: el mail al slug nuevo ahora crea el requisito en el proyecto nuevo.
    const { logger: l2, capture: c2 } = loggerWithCapture();
    await runTick(sourceWith(new Map([[1, mailAlSlug(1, 'gamma')]])), config, l2, bus.client, threads);

    expect(tickLine(c2)).toMatchObject({ creados: 1, descartados: 0 });
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(99);
  }, 90_000);

  // TS-46
  it('TS-46: un bucket VACIO no cuelga el arranque — es el estado del PRIMER ARRANQUE DE PRODUCCION', async () => {
    const { bucket, tickets } = await seedTickets();
    const threads = await seedThreads();
    const { logger, capture } = loggerWithCapture();

    // HALLAZGO 2: un bucket VACIO no emite NUNCA ningun entry, asi que una espera implementada como
    // "resolver con el primer entry con `isUpdate`" CUELGA PARA SIEMPRE — y el proceso queda vivo,
    // sin loguear nada, sin schedular el tick y sin morirse, que es el peor modo de falla posible.
    // La solucion es `status().values`, que trae la cuenta ANTES de arrancar el watch.
    //
    // Y UN BUCKET VACIO ES EL ESTADO DE TODO DESPLIEGUE NUEVO: si esto colgara, el conector no
    // arrancaria nunca la primera vez, en ningun despliegue.
    const watch = await startTicketMapWatch({
      tickets,
      config: { kv: { ...BASE_CONFIG.kv, ticketsBucket: bucket } },
      logger,
    });
    openWatches.push(watch);

    expect(watch.ticketMap.size).toBe(0);

    const config = withTicketMap(BASE_CONFIG, watch.ticketMap);
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 804 },
    });

    // Y el tick corre: cae en `slug_no_mapeado`, que es la falla segura y diagnosticable.
    await runTick(sourceWith(new Map([[1, mailAlSlug(1, 'alfa')]])), config, logger, bus.client, threads);

    expect(discardLine(capture)).toMatchObject({ motivo: 'slug_no_mapeado', slug: 'alfa' });
    expect(tickLine(capture)).toMatchObject({ descartados: 1, creados: 0 });
    expect(altas.count()).toBe(0);
  }, 60_000);
});
