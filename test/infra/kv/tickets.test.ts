import {
  Client,
  JikuError,
  JikuKVPermissionDenied,
  JikuNoBucket,
  JikuNotConnected,
  type KV,
} from '@gravadigital/jiku';
import { connect } from '@gravadigital/jiku/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { KvSpace } from '#infra/kv/space.js';
import { lookupTicket } from '#infra/kv/tickets.js';
import { createLogger } from '#shared/logger.js';

import { TEST_INSTANCE } from '../../bus/helpers.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';
import { spyOnSpace, withFailingGet } from './space-doubles.js';

/**
 * TS-27 a TS-34 del Story Plan de S-032: `lookupTicket()`, la consulta del slug por mail, contra el
 * `JIKU_KV` REAL (convencion `testing`: el bus no se mockea).
 *
 * Cada test usa un ESPACIO FRESCO (`nats.spaceFor('tk-<n>')`): el `KV` del SDK no lista ni vacia
 * claves, y lo que aisla un test de otro es el prefijo de la identidad, igual que en produccion.
 *
 * Lo unico que se dobla es el borde que no se puede provocar contra un bucket sano: un `get()` que
 * rechaza (`withFailingGet`). El resto es el espacio de verdad.
 */

const BASE_CONFIG = {
  logLevel: 'info',
  nodeEnv: 'production',
  instance: 'test',
} as unknown as AppConfig;

const MALFORMED_MESSAGE = 'una entrada del Mapa de Tickets tiene un projectId invalido y se ignora';
const UNQUERYABLE_MESSAGE =
  'no se pudo consultar el Mapa de Tickets; el mail se descarta como slug_no_consultable';

function loggerWithCapture(): { logger: ReturnType<typeof createLogger>; capture: LogCapture } {
  const capture = createLogCapture();
  return { logger: createLogger(BASE_CONFIG, capture.stream), capture };
}

let nats: JetStreamNats;
let spaceCounter = 0;

/** Un espacio VACIO propio por test: otra identidad sobre el mismo `JIKU_KV`. */
async function freshSpace(): Promise<KvSpace> {
  spaceCounter += 1;
  return nats.spaceFor(`tk-${String(spaceCounter)}`);
}

beforeAll(async () => {
  nats = await startJetStreamNats();
}, 120_000);

afterAll(async () => {
  await nats?.stop();
});

describe('lookupTicket — el slug esta o no esta', () => {
  // TS-27
  it('TS-27: un slug cargado resuelve su proyecto, con UN get y sin log', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();
    await space.put('tickets.alfa', '42');
    const spy = spyOnSpace(space);

    const result = await lookupTicket({ space: spy.space, slug: 'alfa', logger });

    expect(result).toEqual({ found: true, projectId: 42 });
    expect(spy.gets).toEqual(['tickets.alfa']);
    expect(capture.lines()).toEqual([]);
  });

  // TS-28
  it('TS-28: un slug nunca cargado es consultable y no esta, sin log', async () => {
    const space = await freshSpace();
    const { logger, capture } = loggerWithCapture();

    const result = await lookupTicket({ space, slug: 'beta', logger });

    expect(result).toEqual({ found: false, consultable: true });
    expect(capture.lines()).toEqual([]);
  });

  // TS-29
  it('TS-29: un slug borrado es consultable y no esta (vale desde el mail siguiente)', async () => {
    // El `KV` del SDK directamente, con su `delete()`: el conector NO borra (CA-17), y este test
    // representa al operador (U-02) dando de baja un slug.
    spaceCounter += 1;
    const sdkSpace: KV = await Client.fromConnection(nats.connection, {
      instance: TEST_INSTANCE,
      userId: `tk-${String(spaceCounter)}`,
    }).kv();
    const { logger } = loggerWithCapture();
    await sdkSpace.put('tickets.alfa', '42');
    await sdkSpace.delete('tickets.alfa');

    const result = await lookupTicket({ space: sdkSpace, slug: 'alfa', logger });

    expect(result).toEqual({ found: false, consultable: true });
  });

  // TS-30
  it.each(['cuarenta-y-dos', '0', '-3', '4.5', '42abc', ''])(
    'TS-30: un valor mal formado (%j) se ignora con un warn que nombra el slug y NO el valor',
    async (value) => {
      const space = await freshSpace();
      const { logger, capture } = loggerWithCapture();
      await space.put('tickets.alfa', value);

      const result = await lookupTicket({ space, slug: 'alfa', logger });

      expect(result).toEqual({ found: false, consultable: true });
      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', slug: 'alfa', msg: MALFORMED_MESSAGE });
      if (value === 'cuarenta-y-dos' || value === '42abc') {
        // El valor crudo no viaja: no aporta al arreglo y seria volcar contenido del KV al log.
        for (const raw of capture.raw()) expect(raw).not.toContain(value);
      }
    },
  );

  // TS-31
  it.each(['a+b', 'al..fa', 'álfa', 'al fa'])(
    'TS-31: un slug que no puede ser clave (%j) es "no esta" SIN round-trip y sin log',
    async (slug) => {
      const space = await freshSpace();
      const { logger, capture } = loggerWithCapture();
      const spy = spyOnSpace(space);

      const result = await lookupTicket({ space: spy.space, slug, logger });

      expect(result).toEqual({ found: false, consultable: true });
      expect(spy.gets).toEqual([]);
      expect(capture.lines()).toEqual([]);
    },
  );
});

describe('lookupTicket — la consulta no se pudo hacer', () => {
  // TS-32
  it.each([
    ['JikuError', new JikuError('jiku: kv: get "tickets.alfa": JetStream did not answer within 15000ms.')],
    [
      'JikuKVPermissionDenied',
      new JikuKVPermissionDenied(
        'jiku: kv: the bus refused get "tickets.alfa"',
        '$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.test.tk-1.tickets.alfa',
      ),
    ],
    ['JikuNoBucket', new JikuNoBucket('jiku: kv: nothing answered get "tickets.alfa"')],
    ['JikuNotConnected', new JikuNotConnected()],
  ])(
    'TS-32: un get() que rechaza con %s es no consultable, con slug y errorClass, en UN intento',
    async (errorClass, error) => {
      const space = await freshSpace();
      const { logger, capture } = loggerWithCapture();
      await space.put('tickets.alfa', '42');
      const spy = spyOnSpace(withFailingGet(space, error));

      const result = await lookupTicket({ space: spy.space, slug: 'alfa', logger });

      expect(result).toEqual({ found: false, consultable: false });
      const lines = capture.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'warn', slug: 'alfa', errorClass, msg: UNQUERYABLE_MESSAGE });
      // Un solo intento, sin reintento (ADR-001).
      expect(spy.gets).toEqual(['tickets.alfa']);
    },
  );

  // TS-33
  it('TS-33: con la conexion cerrada (el error REAL del SDK) es no consultable', async () => {
    const nc = await connect({ servers: nats.url });
    const space = await Client.fromConnection(nc, { instance: TEST_INSTANCE, userId: 'tk-closed' }).kv();
    const { logger, capture } = loggerWithCapture();
    await nc.close();

    const result = await lookupTicket({ space, slug: 'alfa', logger });

    expect(result).toEqual({ found: false, consultable: false });
    expect(capture.lines()[0]).toMatchObject({ level: 'warn', errorClass: 'JikuNotConnected' });
  });

  // TS-34
  it('TS-34: un get que lanza SINCRONICAMENTE tampoco escapa', async () => {
    const { logger, capture } = loggerWithCapture();
    const space: KvSpace = {
      get: () => {
        throw new Error('sync');
      },
      put: () => Promise.resolve(1),
    };

    await expect(lookupTicket({ space, slug: 'alfa', logger })).resolves.toEqual({
      found: false,
      consultable: false,
    });
    expect(capture.lines()[0]).toMatchObject({ level: 'warn', errorClass: 'Error' });
  });
});
