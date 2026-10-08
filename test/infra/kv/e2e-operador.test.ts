import { createHash } from 'node:crypto';

import { Client, kvKey } from '@gravadigital/jiku';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { ticketKey } from '#infra/kv/keys.js';
import { openKvSpace, type KvSpace } from '#infra/kv/space.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { type CoreResponder, respondTo } from '../../bus/responder.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';
import { operatorDel, operatorPut, operatorTicketKey } from './operator.js';
import { spyOnSpace } from './space-doubles.js';

/**
 * S-033 Tarea 3 (CA-1, CA-2, CA-3): lo que escribe un OPERADOR con el CLI, leido por el tick
 * cableado, contra un NATS REAL con JetStream. TS-1 a TS-8 del Story Plan de S-033.
 *
 * # QUE AGREGA SOBRE LO QUE YA EXISTIA
 *
 * `space.test.ts` TS-22 ya prueba que una entrada escrita por el `KV` del SDK vive bajo el prefijo
 * `{instance}.{userId}.`. Eso dice que el SDK es coherente CONSIGO MISMO. Lo que no decia nada es si
 * la clave que escribe U-02 —que no tiene el SDK sino el CLI, y escribe la clave COMPLETA siguiendo
 * el README— es la que el conector lee. Aca:
 *
 * - la ESCRIBE el operador, por la conexion cruda, como `nats kv put JIKU_KV <clave completa>`
 *   (`operator.ts`), con la clave armada desde la PLANTILLA DEL README y el `kvPrefix` LEIDO de la
 *   linea `'espacio KV abierto'` del arranque — no calculado en el test;
 * - la LEE el tick cableado (`runTick()`), desde el mail SIGUIENTE, sobre el MISMO handle de una
 *   sola llamada a `openKvSpace()`: sin reabrir el espacio y sin reiniciar nada;
 * - y el AISLAMIENTO se mira desde el STREAM (`lastSequences()`, la API de JetStream sobre la
 *   conexion sin restricciones), no desde el SDK, que no puede listar claves.
 *
 * # SIN NINGUN DOBLE DEL KV
 *
 * El unico envoltorio es `spyOnSpace()`, que DELEGA en el handle real: registra que claves pidio el
 * codigo, sin cambiar lo que devuelve. El bucket es uno y compartido por todo el archivo; cada
 * escenario usa una identidad PROPIA (otro `userId` u otra instancia), que es lo que aisla.
 *
 * # LOS COMANDOS VAN POR EL BUS COMPARTIDO
 *
 * `runTick(…, bus.client, space)`: el espacio vive en el NATS con JetStream y los comandos a `core`
 * en el compartido, donde los dobla `respondTo()`. Es la composicion que ya usan `e2e-kv.test.ts` y
 * `tick-propiedades-kv.test.ts`.
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
    subaddressPrefix: 'tickets',
    placeholderTitle: 'Ticket recibido por mail',
    placeholderBody: '(mail sin contenido)',
  },
  adjuntos: {
    allowedExtensions: ['.png', '.pdf', '.txt'],
    allowedMimeTypes: ['image/png', 'application/pdf'],
    maxSizeBytes: 10_485_760,
    putTimeoutMs: 30_000,
  },
};

/** El `sub` de ejemplo del README; con la instancia `dev`, el prefijo es `PREFIX_DEV`. */
const SUB = '387842544790142978';
const OTRO_SUB = '500000000000000001';
const PREFIX_DEV = `dev.${SUB}.`;

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Un mail a `tickets+<slug>@grava.io`, nuevo o respuesta segun `inReplyTo`. */
function mail(opts: { slug: string; messageId: string; inReplyTo?: string }): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      `To: tickets+${opts.slug}@grava.io\r\n` +
      `Subject: ${opts.inReplyTo === undefined ? 'Consulta' : 'Re: Consulta'}\r\n` +
      (opts.inReplyTo === undefined ? '' : `In-Reply-To: ${opts.inReplyTo}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Texto del mensaje.\r\n',
  );
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

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

const tickLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

const discardLines = (capture: LogCapture): Record<string, unknown>[] =>
  capture.lines().filter((line) => line['msg'] === 'mail descartado');

const openLines = (capture: LogCapture): Record<string, unknown>[] =>
  capture.lines().filter((line) => line['msg'] === 'espacio KV abierto');

let bus: TestBusContext;
let nats: JetStreamNats;
const openResponders: CoreResponder[] = [];

async function responderFor(
  command: string,
  replies: Parameters<typeof respondTo>[2],
): Promise<CoreResponder> {
  const responder = await respondTo(bus.connection, command, replies);
  openResponders.push(responder);
  return responder;
}

/** Un conector abierto como en el arranque: UNA llamada a `openKvSpace()`, con su captura. */
interface Connector {
  readonly space: KvSpace;
  /** LEIDO de la linea `'espacio KV abierto'`, no calculado: es lo que copia el operador. */
  readonly kvPrefix: string;
  readonly startup: LogCapture;
}

async function openConnector(instance: string, userId: string): Promise<Connector> {
  const { logger, capture } = loggerWithCapture();
  const client = Client.fromConnection(nats.connection, { instance, userId });
  const space = await openKvSpace({ client, logger });

  const lines = openLines(capture);
  expect(lines, 'el arranque emite UNA linea "espacio KV abierto"').toHaveLength(1);
  const kvPrefix = lines[0]?.['kvPrefix'];
  expect(typeof kvPrefix).toBe('string');
  return { space, kvPrefix: kvPrefix as string, startup: capture };
}

/** Un tick con su propia captura. */
async function tick(
  space: KvSpace,
  mails: Map<number, Buffer>,
): Promise<{ capture: LogCapture; source: ReturnType<typeof sourceWith> }> {
  const { logger, capture } = loggerWithCapture();
  const source = sourceWith(mails);
  await runTick(source, BASE_CONFIG, logger, bus.client, space);
  // Ningun tick reabre el espacio: ninguna linea de arranque sale de un tick.
  expect(openLines(capture)).toHaveLength(0);
  return { capture, source };
}

/** Las claves cuya secuencia cambio (o aparecieron) entre dos snapshots de `lastSequences()`. */
function changedKeys(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()]
    .filter(([subject, seq]) => before.get(subject) !== seq)
    .map(([subject]) => subject)
    .sort();
}

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
});

afterAll(async () => {
  await nats?.stop();
  await bus.cleanup();
});

describe('E2E del operador: un slug cargado con la clave completa rutea sin reabrir el espacio (CA-1)', () => {
  // TS-1 y TS-2 en una sola cadena: TS-2 es TS-1 mirado desde el espia del tick 2.
  it('TS-1/TS-2: el slug que el operador carga con la plantilla del README rutea desde el mail siguiente', async () => {
    const conector = await openConnector('dev', SUB);

    // La linea de arranque, exactamente UNA, con el prefijo que el operador copia.
    expect(openLines(conector.startup)[0]).toMatchObject({
      bucket: 'JIKU_KV',
      kvPrefix: PREFIX_DEV,
      msg: 'espacio KV abierto',
    });

    // ---------- TICK 1: el slug todavia no esta cargado ----------
    const t1 = await tick(conector.space, new Map([[1, mail({ slug: 'beta', messageId: '<beta-1@cliente.com>' })]]));
    expect(discardLines(t1.capture)).toEqual([
      expect.objectContaining({ messageId: '<beta-1@cliente.com>', motivo: 'slug_no_mapeado', slug: 'beta' }),
    ]);
    expect(tickLine(t1.capture)).toMatchObject({ descartados: 1, creados: 0 });

    // ---------- EL OPERADOR carga el slug, con la plantilla del README ----------
    const fullKey = operatorTicketKey({ kvPrefix: conector.kvPrefix, slug: 'beta' });
    expect(fullKey).toBe('dev.387842544790142978.tickets.beta');
    const ack = await operatorPut(nats.connection, fullKey, '57');
    // TS-2: lo que respondio JetStream es el PubAck del stream del bucket.
    expect(ack.stream).toBe('KV_JIKU_KV');
    expect(typeof ack.seq).toBe('number');

    // ---------- TICK 2, con el MISMO handle ----------
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 5701 } });
    const spy = spyOnSpace(conector.space);
    const t2 = await tick(spy.space, new Map([[2, mail({ slug: 'beta', messageId: '<beta-2@cliente.com>' })]]));

    expect(altas.count()).toBe(1);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(57);
    expect(tickLine(t2.capture)).toMatchObject({ creados: 1, descartados: 0, fallidos: 0 });

    // TS-2: la clave que pidio el conector es la parte derecha de la que escribio el operador.
    expect(spy.gets).toContain('tickets.beta');
    expect(kvKey('dev', SUB, ticketKey('beta'))).toBe(fullKey);

    // Y el espacio se abrio UNA sola vez en todo el escenario.
    expect(openLines(conector.startup)).toHaveLength(1);
  });

  it('TS-4: cambiar un slug en caliente vale desde el mail siguiente', async () => {
    const conector = await openConnector('dev', 's033-op-cambio');
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 6100 } });

    await operatorPut(nats.connection, operatorTicketKey({ kvPrefix: conector.kvPrefix, slug: 'gamma' }), '61');
    await tick(conector.space, new Map([[1, mail({ slug: 'gamma', messageId: '<gamma-1@cliente.com>' })]]));

    await operatorPut(nats.connection, operatorTicketKey({ kvPrefix: conector.kvPrefix, slug: 'gamma' }), '62');
    await tick(conector.space, new Map([[2, mail({ slug: 'gamma', messageId: '<gamma-2@cliente.com>' })]]));

    expect(altas.count()).toBe(2);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(61);
    expect((altas.payloads()[1] as Record<string, unknown>)['projectId']).toBe(62);
    // Ningun reinicio: una sola linea de arranque.
    expect(openLines(conector.startup)).toHaveLength(1);
  });

  it('TS-5: una clave cargada en mayusculas no matchea el slug del mail, que va en minusculas', async () => {
    const conector = await openConnector('dev', 's033-op-mayus');
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 7000 } });

    await operatorPut(nats.connection, `${conector.kvPrefix}tickets.Delta`, '70');
    const spy = spyOnSpace(conector.space);
    const t = await tick(spy.space, new Map([[1, mail({ slug: 'delta', messageId: '<delta-1@cliente.com>' })]]));

    expect(discardLines(t.capture)).toEqual([
      expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'delta' }),
    ]);
    expect(altas.count()).toBe(0);
    expect(spy.gets).toEqual(['tickets.delta']);
  });

  it('TS-6: un valor mal formado cargado por el operador se ignora con un warn que nombra el slug y no el valor', async () => {
    const conector = await openConnector('dev', 's033-op-valor');
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 7100 } });

    await operatorPut(
      nats.connection,
      operatorTicketKey({ kvPrefix: conector.kvPrefix, slug: 'epsilon' }),
      'VALOR-CRUDO-MALO',
    );
    const t = await tick(conector.space, new Map([[1, mail({ slug: 'epsilon', messageId: '<eps-1@cliente.com>' })]]));

    expect(t.capture.lines()).toContainEqual(
      expect.objectContaining({
        slug: 'epsilon',
        msg: 'una entrada del Mapa de Tickets tiene un projectId invalido y se ignora',
      }),
    );
    expect(discardLines(t.capture)).toEqual([
      expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'epsilon' }),
    ]);
    expect(altas.count()).toBe(0);
    // El valor crudo no aparece en NINGUNA linea serializada, ni del arranque ni del tick.
    for (const line of [...conector.startup.raw(), ...t.capture.raw()]) {
      expect(line).not.toContain('VALOR-CRUDO-MALO');
    }
  });
});

describe('E2E del operador: un slug borrado deja de rutear desde el mail siguiente (CA-2)', () => {
  it('TS-3: nats kv del con la clave completa saca el slug del ruteo, sin reabrir el espacio', async () => {
    const conector = await openConnector('dev', 's033-op-baja');
    const altas = await responderFor('requirements.new', { status: 'success' as const, data: { id: 4200 } });
    const fullKey = operatorTicketKey({ kvPrefix: conector.kvPrefix, slug: 'alfa' });

    await operatorPut(nats.connection, fullKey, '42');
    const t1 = await tick(conector.space, new Map([[1, mail({ slug: 'alfa', messageId: '<alfa-1@cliente.com>' })]]));
    expect(altas.count()).toBe(1);
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);
    expect(tickLine(t1.capture)).toMatchObject({ creados: 1 });

    // El operador borra el slug: el marcador `KV-Operation: DEL` en el mismo subject.
    await operatorDel(nats.connection, fullKey);

    const t2 = await tick(conector.space, new Map([[2, mail({ slug: 'alfa', messageId: '<alfa-2@cliente.com>' })]]));
    expect(discardLines(t2.capture)).toEqual([
      expect.objectContaining({ messageId: '<alfa-2@cliente.com>', motivo: 'slug_no_mapeado', slug: 'alfa' }),
    ]);
    expect(altas.count()).toBe(1);
    expect(tickLine(t2.capture)).toMatchObject({ descartados: 1, creados: 0 });
    expect(await conector.space.get('tickets.alfa')).toBeUndefined();
    expect(openLines(conector.startup)).toHaveLength(1);
  });
});

describe('E2E del operador: cada instancia e identidad ve solo su espacio (CA-3)', () => {
  // TS-7 y TS-8 en una sola cadena: TS-8 continua sobre los dos conectores de TS-7.
  it('TS-7/TS-8: lo cargado en dev no rutea en prod, y cada conector escribe solo bajo su prefijo', async () => {
    const devKey = `$KV.JIKU_KV.${PREFIX_DEV}tickets.alfa`;
    await operatorPut(nats.connection, `${PREFIX_DEV}tickets.alfa`, '42');

    const prodMismo = await openConnector('prod', SUB);
    const prodOtro = await openConnector('prod', OTRO_SUB);
    expect(prodMismo.kvPrefix).toBe(`prod.${SUB}.`);
    expect(prodOtro.kvPrefix).toBe(`prod.${OTRO_SUB}.`);

    // ---------- TS-7: alfa esta cargado en dev, y en prod NO rutea ----------
    // Fuera de `responderFor()`: se da de baja ANTES del responder de TS-8, que contesta al mismo
    // comando (dos suscripciones vivas contestarian las dos).
    const altasVacias = await respondTo(bus.connection, 'requirements.new', {
      status: 'success' as const,
      data: { id: 1 },
    });
    for (const [i, conector] of [prodMismo, prodOtro].entries()) {
      const t = await tick(
        conector.space,
        new Map([[1, mail({ slug: 'alfa', messageId: `<alfa-prod-${String(i)}@cliente.com>` })]]),
      );
      expect(discardLines(t.capture)).toEqual([
        expect.objectContaining({ motivo: 'slug_no_mapeado', slug: 'alfa' }),
      ]);
    }
    expect(altasVacias.count()).toBe(0);
    await altasVacias.stop();

    // ---------- TS-8: alta y respuesta en cada conector, mirado desde el STREAM ----------
    const s0 = await nats.lastSequences();
    expect(s0.get(devKey), 'la clave de dev esta en el stream').toEqual(expect.any(Number));

    const gammaMismo = `${prodMismo.kvPrefix}tickets.gamma`;
    const gammaOtro = `${prodOtro.kvPrefix}tickets.gamma`;
    await operatorPut(nats.connection, gammaMismo, '57');
    await operatorPut(nats.connection, gammaOtro, '58');
    const s1 = await nats.lastSequences();
    expect(changedKeys(s0, s1)).toEqual([`$KV.JIKU_KV.${gammaMismo}`, `$KV.JIKU_KV.${gammaOtro}`].sort());

    const altas = await responderFor('requirements.new', [
      { status: 'success' as const, data: { id: 801 } },
      { status: 'success' as const, data: { id: 802 } },
    ]);
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 900 },
    });

    /** Alta y respuesta de un conector; devuelve las claves completas que su espia vio escribir. */
    async function altaYRespuesta(conector: Connector, tag: string): Promise<string[]> {
      const spy = spyOnSpace(conector.space);
      await tick(spy.space, new Map([[1, mail({ slug: 'gamma', messageId: `<${tag}-alta@cliente.com>` })]]));
      await tick(
        spy.space,
        new Map([
          [2, mail({ slug: 'gamma', messageId: `<${tag}-resp@cliente.com>`, inReplyTo: `<${tag}-alta@cliente.com>` })],
        ]),
      );
      return spy.puts.map((put) => `$KV.JIKU_KV.${conector.kvPrefix}${put.key}`).sort();
    }

    const writtenMismo = await altaYRespuesta(prodMismo, 'p1');
    const s2 = await nats.lastSequences();
    const writtenOtro = await altaYRespuesta(prodOtro, 'p2');
    const s3 = await nats.lastSequences();

    // Las entradas del Mapa de Hilos de cada conector, bajo SU prefijo.
    const hilosMismo = [
      `$KV.JIKU_KV.prod.${SUB}.hilos.${sha256('<p1-alta@cliente.com>')}`,
      `$KV.JIKU_KV.prod.${SUB}.hilos.${sha256('<p1-resp@cliente.com>')}`,
    ].sort();
    const hilosOtro = [
      `$KV.JIKU_KV.prod.${OTRO_SUB}.hilos.${sha256('<p2-alta@cliente.com>')}`,
      `$KV.JIKU_KV.prod.${OTRO_SUB}.hilos.${sha256('<p2-resp@cliente.com>')}`,
    ].sort();
    expect(writtenMismo).toEqual(hilosMismo);
    expect(writtenOtro).toEqual(hilosOtro);

    // Por intervalo: lo que cambio mientras corria cada conector es EXACTAMENTE lo que ese conector
    // escribio, todo bajo su prefijo; nada de la otra identidad cambio.
    expect(changedKeys(s1, s2)).toEqual(hilosMismo);
    expect(changedKeys(s2, s3)).toEqual(hilosOtro);
    for (const key of changedKeys(s1, s2)) expect(key.startsWith(`$KV.JIKU_KV.prod.${SUB}.`)).toBe(true);
    for (const key of changedKeys(s2, s3)) expect(key.startsWith(`$KV.JIKU_KV.prod.${OTRO_SUB}.`)).toBe(true);

    // La clave de dev no cambio en todo el escenario.
    expect(s3.get(devKey)).toBe(s0.get(devKey));

    // Y los comentarios fueron cada uno al requisito de su conector.
    expect(altas.count()).toBe(2);
    expect(comentarios.subjects()).toHaveLength(2);
    expect(comentarios.subjects()[0]).toContain('requirements.801.comment');
    expect(comentarios.subjects()[1]).toContain('requirements.802.comment');
  }, 90_000);
});
