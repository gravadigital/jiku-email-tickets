import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import type { MailSource, RawMessage } from '#domain/ingesta/ports.js';
import { runTick } from '#domain/ingesta/tick.js';
import { KvSpaceUnavailableError } from '#infra/kv/errors.js';
import { threadKey } from '#infra/kv/keys.js';
import { openKvSpace, type KvSpace } from '#infra/kv/space.js';
import { createLogger } from '#shared/logger.js';

import { setupTestBus, type TestBusContext } from '../../bus/helpers.js';
import { type CoreResponder, respondTo } from '../../bus/responder.js';
import { createLogCapture, type LogCapture } from '../../shared/log-capture.js';
import { startJetStreamNats, type JetStreamNats } from './helpers.js';

/**
 * S-028 Tarea 4 (CA-7, CA-8): la verificacion E2E contra un NATS REAL con JetStream. TS-31 a TS-38,
 * adaptados en S-032 al Espacio KV (TS-87 y TS-88 de su Story Plan).
 *
 * # QUE VERIFICA ESTE ARCHIVO Y QUE NO
 *
 * **CA-7 — el ciclo ENCADENADO.** `tick-hilos.test.ts` TS-40 ya cubre un tick MIXTO contra KV real.
 * Lo que no existia es la SECUENCIA de ticks separados sobre el mismo espacio:
 * alta → write → (tick nuevo) respuesta → comentario → write → (tick nuevo) respuesta a la
 * respuesta → comentario. Esa cadena es la que prueba que el write del tick 1 es LEGIBLE por el
 * lookup del tick 2 —lo que en un tick mixto podria pasar por casualidad si el orden del lote
 * ayudara— y es lo que hace concreta la razon de que el SEGUNDO write exista.
 *
 * **CA-8 — el ENCADENADO del fail-fast.** `space.test.ts` ya cubre `openKvSpace()` fallando sin
 * `JIKU_KV`, sin `allow_direct` y contra un NATS sin JetStream; y `startup-wiring.test.ts` ya cubre
 * el `logger.fatal` de `reportStartupFailure()` sobre un `KvSpaceUnavailableError` construido a mano.
 * Lo que falta, y es lo que se agrega aca, es LA UNION: el error que el SERVIDOR produjo de verdad
 * pasando por `reportStartupFailure()` en la MISMA corrida, con la afirmacion de que el bucket sigue
 * sin existir despues.
 *
 * Hasta S-032 este bloque tenia ademas dos escenarios por bucket faltante (el de hilos solo, y los
 * dos a la vez). Desde REQ-008 hay UN solo bucket, `JIKU_KV`, y se borraron con los dos buckets.
 *
 * S-033 (CA-6 caso 2) suma TS-11: `JIKU_KV` SIN `allow_direct`, encadenado igual. El caso 3 (un rol
 * sin los grants del espacio) necesita un servidor con permisos y vive en `e2e-permisos.test.ts`.
 *
 * # POR QUE NO SE INVOCA `runStartup()`
 *
 * `runStartup()` llama a `connectToBus()`, que pide el token a Zitadel ANTES de abrir el socket. No
 * hay Zitadel en test y no puede haberlo: `Client.fromConnection()` existe precisamente para
 * saltear ese handshake. Asi que el encadenado se arma con las DOS piezas reales que el arranque
 * ejecuta en secuencia —`openKvSpace()` y `reportStartupFailure()`— sobre el `client` de
 * `fromConnection()`. Es el mismo encadenado que produce el arranque real y es el precedente que
 * `startup-wiring.test.ts` ya usa.
 *
 * NO LO "MEJORES" a un `runStartup()`: no puede correr, y el intento termina en un mock del modulo
 * del bus que ya no prueba nada del KV.
 *
 * # UN SOLO CONTENEDOR POR ARCHIVO
 *
 * Los escenarios de CA-8 necesitan el bucket AUSENTE: lo borran con `deleteBucket()` y el
 * `afterEach` lo recrea. Un contenedor por caso multiplicaria el tiempo de la suite por nada.
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

const FATAL_MESSAGE = 'el arranque fallo: el espacio KV no esta usable';

/**
 * El capture del caso en curso, leido por el `getLogger()` mockeado.
 *
 * `reportStartupFailure()` usa el logger SINGLETON (`getLogger()`), que `initLogger()` construye
 * sin aceptar un destino. La unica forma de leer lo que emite es interceptar `getLogger()`. No se
 * cambia el codigo de produccion para hacerlo testeable: el modulo del logger ya expone
 * `createLogger(config, destination)` para exactamente esto. Es el patron de
 * `startup-wiring.test.ts`.
 */
let startupCapture: LogCapture;

vi.mock('#shared/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/logger.js')>();
  return {
    ...actual,
    getLogger: (): ReturnType<typeof actual.createLogger> =>
      actual.createLogger(BASE_CONFIG, startupCapture.stream),
  };
});

// Se importa DESPUES del `vi.mock` para que `startup.ts` resuelva el `getLogger()` mockeado.
const { reportStartupFailure } = await import('../../../src/startup.js');

/** El hash calculado INDEPENDIENTEMENTE en el test, nunca importado de `src/`. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** El valor de una entrada del espacio como texto, o `undefined` si no esta. */
async function valueOf(space: KvSpace, key: string): Promise<string | undefined> {
  const entry = await space.get(key);
  return entry === undefined ? undefined : new TextDecoder().decode(entry.value);
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

/** Un mail al slug mapeado `alfa`, con el `Message-Id` y los headers de hilo indicados. */
function mail(opts: { messageId: string; inReplyTo?: string; subject?: string }): Buffer {
  return Buffer.from(
    `Message-Id: ${opts.messageId}\r\n` +
      'From: "Juan Perez" <juan@cliente.com>\r\n' +
      'To: tickets+alfa@grava.io\r\n' +
      `Subject: ${opts.subject ?? 'Consulta'}\r\n` +
      (opts.inReplyTo === undefined ? '' : `In-Reply-To: ${opts.inReplyTo}\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'MIME-Version: 1.0\r\n\r\n' +
      'Texto del mensaje.\r\n',
  );
}

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

const tickLine = (capture: LogCapture): Record<string, unknown> | undefined =>
  capture.lines().find((line) => line['msg'] === 'tick completado');

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
  nats = await startJetStreamNats();
}, 120_000);

afterEach(async () => {
  while (openResponders.length > 0) {
    await openResponders.pop()?.stop();
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await nats?.stop();
  await bus.cleanup();
});

/* ==========================================================================================
 * CA-7 — EL CAMINO COMPLETO DE UNA RESPUESTA, CONTRA EL KV REAL
 * ========================================================================================== */
describe('E2E contra NATS real: el ciclo alta -> respuesta -> respuesta a la respuesta (CA-7)', () => {
  // TS-31, TS-32, TS-33 (TS-87 de S-032) en una sola cadena: los tres ticks comparten el MISMO
  // espacio, y eso NO es un detalle de comodidad — es lo que hace que el write del tick 1 sea legible
  // por el lookup del tick 2. Por eso este escenario NO refresca el espacio entre ticks, a diferencia
  // del resto de las suites del KV, que si aislan.
  it('TS-31/TS-32/TS-33: los tres ticks encadenados contra el KV real, sin ningun doble del KV', async () => {
    // El espacio de una identidad propia, con el slug cargado como lo cargaria U-02.
    const space = await nats.spaceFor('e2e-ciclo');
    await space.put('tickets.alfa', '42');

    // ---------- TICK 1: el mail nuevo crea el Requisito y ESCRIBE su entrada ----------
    const { logger: l1, capture: c1 } = loggerWithCapture();
    const altas = await responderFor('requirements.new', {
      status: 'success' as const,
      data: { id: 700 },
    });

    await runTick(
      sourceWith(new Map([[1, mail({ messageId: '<orig-1@cliente.com>' })]])),
      BASE_CONFIG,
      l1,
      bus.client,
      space,
    );

    expect(tickLine(c1)).toMatchObject({ creados: 1, comentados: 0, descartados: 0, fallidos: 0 });
    expect(altas.count()).toBe(1);
    // El alta fue al proyecto que el Mapa de Tickets del espacio resolvio.
    expect((altas.payloads()[0] as Record<string, unknown>)['projectId']).toBe(42);

    // El valor se lee DEL KV REAL, no de un doble, bajo la clave `hilos.<sha256>`.
    expect(threadKey('<orig-1@cliente.com>')).toBe(`hilos.${sha256('<orig-1@cliente.com>')}`);
    expect(await valueOf(space, `hilos.${sha256('<orig-1@cliente.com>')}`)).toBe('700');

    // ---------- TICK 2: la respuesta COMENTA y escribe la entrada de SU PROPIO Message-Id ----------
    const { logger: l2, capture: c2 } = loggerWithCapture();
    const comentarios = await responderFor('requirements.*.comment', {
      status: 'success' as const,
      data: { id: 900 },
    });

    await runTick(
      sourceWith(
        new Map([
          [2, mail({ messageId: '<reply-1@cliente.com>', inReplyTo: '<orig-1@cliente.com>', subject: 'Re: Consulta' })],
        ]),
      ),
      BASE_CONFIG,
      l2,
      bus.client,
      space,
    );

    expect(tickLine(c2)).toMatchObject({
      comentados: 1,
      // NO crea ningun Requisito: el Requisito ya existe.
      creados: 0,
      descartados: 0,
      fallidos: 0,
    });
    expect(comentarios.count()).toBe(1);
    // El comentario viajo al subject del REQUISITO que el lookup resolvio.
    expect(comentarios.subjects()[0]).toContain('requirements.700.comment');
    // Y el responder del alta NO recibio nada mas en este tick.
    expect(altas.count()).toBe(1);

    // TS-32: el payload que llego al BUS REAL.
    const payload = comentarios.payloads()[0] as Record<string, unknown>;
    // `visibilityLevel: 'public'` EXPLICITO y PRESENTE. El default del contrato es `'internal'`, y
    // un comentario interno NO LO VERIA EL CLIENTE EN OPUS — `core` responderia `success` igual, y
    // la falla seria invisible del lado del conector.
    expect(payload['visibilityLevel']).toBe('public');
    expect('visibilityLevel' in payload).toBe(true);
    // Ni `author` ni `actor`: `core` resuelve el actor del `sub` del subject (ADR-005), y el
    // `.strict()` del schema hace que colar cualquiera de las dos FALLE en vez de removerse.
    expect('author' in payload).toBe(false);
    expect('actor' in payload).toBe(false);
    // Y `fileIds` AUSENTE (nunca `fileIds: []`): la clave ausente ES la representacion de "cero
    // adjuntos".
    expect('fileIds' in payload).toBe(false);
    expect(Object.keys(payload).sort()).toEqual(['comment', 'visibilityLevel']);

    // El SEGUNDO write: la entrada del Message-Id de LA RESPUESTA, apuntando al MISMO requisito.
    expect(await valueOf(space, threadKey('<reply-1@cliente.com>'))).toBe('700');

    // ---------- TICK 3: una respuesta A LA RESPUESTA rutea igual ----------
    //
    // ES LA RAZON CONCRETA DE QUE EL SEGUNDO WRITE EXISTA. Este mail lleva como UNICA referencia el
    // `Message-Id` de la respuesta (el cliente recorto `References`, que es lo que varios clientes
    // hacen): sin la entrada que el tick 2 escribio, este mail seria `hilo_desconocido`.
    const { logger: l3, capture: c3 } = loggerWithCapture();

    await runTick(
      sourceWith(
        new Map([
          [3, mail({ messageId: '<reply-2@cliente.com>', inReplyTo: '<reply-1@cliente.com>', subject: 'Re: Re: Consulta' })],
        ]),
      ),
      BASE_CONFIG,
      l3,
      bus.client,
      space,
    );

    expect(tickLine(c3)).toMatchObject({ comentados: 1, creados: 0, descartados: 0, fallidos: 0 });
    expect(comentarios.count()).toBe(2);
    // Comenta en el MISMO requisito 700, no en otro.
    expect(comentarios.subjects()[1]).toContain('requirements.700.comment');
    // Y escribe su propia entrada, para que la cadena siga.
    expect(await valueOf(space, threadKey('<reply-2@cliente.com>'))).toBe('700');
  }, 90_000);
});

/* ==========================================================================================
 * CA-8 — EL FAIL-FAST DEL ESPACIO NO USABLE, ENCADENADO CON EL REPORTE DEL ARRANQUE
 * ========================================================================================== */
describe('E2E contra NATS real: el arranque falla cuando JIKU_KV no esta usable (CA-8)', () => {
  // Los escenarios que borran `JIKU_KV` —o lo dejan sin `allow_direct` (S-033, TS-11)— lo dejan
  // como estaba para el resto del archivo: borrado y creado otra vez con la configuracion del SDK.
  afterEach(async () => {
    if (!(await nats.bucketExists())) {
      await nats.createBucket();
    } else if ((await nats.bucketConfig())['allow_direct'] !== true) {
      await nats.deleteBucket();
      await nats.createBucket();
    }
  });

  /**
   * El encadenado real: `openKvSpace()` contra el servidor de verdad, el error capturado, y
   * `reportStartupFailure()` sobre ESE error. Es lo que el arranque hace en secuencia.
   */
  async function arrancarYFallar(
    client = nats.client,
  ): Promise<{ error: KvSpaceUnavailableError; fatals: Record<string, unknown>[] }> {
    startupCapture = createLogCapture();
    const { logger, capture } = loggerWithCapture();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const caught = await openKvSpace({ client, logger }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(KvSpaceUnavailableError);
    // Y no se logueo la linea de exito: el espacio no se abrio.
    expect(capture.lines().some((line) => line['msg'] === 'espacio KV abierto')).toBe(false);

    // Y aca esta la union que faltaba: el error del SERVIDOR pasando por el reporte del arranque.
    reportStartupFailure(caught);

    // Nada por stderr: este fallo ocurre con el logger ya construido (paso 5.5 del arranque, que
    // va DESPUES de `initLogger()`).
    expect(stderr).not.toHaveBeenCalled();

    return {
      error: caught as KvSpaceUnavailableError,
      fatals: startupCapture.lines().filter((line) => line['level'] === 'fatal'),
    };
  }

  // TS-34 (TS-88 de S-032)
  it('TS-34: sin JIKU_KV -> falla como bucket_no_usable, el fatal sale por la rama del KV, y no lo crea', async () => {
    await nats.deleteBucket();

    const { error, fatals } = await arrancarYFallar();

    expect(error.bucket).toBe('JIKU_KV');
    expect(error.diagnosis).toBe('bucket_no_usable');
    expect(error.errorClass).toBe('JikuNoBucket');

    // UNA sola linea fatal, con el contexto PLANO que la convencion `logging` exige (`redact.paths`
    // de Pino no tiene comodin profundo: un contexto anidado dejaria un valor sin redactar sin
    // fallar y sin avisar).
    expect(fatals).toHaveLength(1);
    const fatal = fatals[0];
    expect(fatal).toMatchObject({
      code: 'KV_SPACE_UNAVAILABLE_ERROR',
      diagnosis: 'bucket_no_usable',
      bucket: 'JIKU_KV',
      errorClass: 'JikuNoBucket',
      msg: FATAL_MESSAGE,
    });
    expect(Array.isArray(fatal?.['causes'])).toBe(true);
    for (const [key, value] of Object.entries(fatal ?? {})) {
      if (key === 'causes') continue;
      expect(typeof value, `${key} debe ser plano`).not.toBe('object');
    }

    // Y NO lo creo.
    expect(await nats.bucketExists()).toBe(false);
  });

  // TS-37 (TS-88 de S-032)
  it('TS-37: el fallo del espacio es una rama PROPIA, no la del bus', async () => {
    await nats.deleteBucket();

    const { fatals } = await arrancarYFallar();

    const msg = String(fatals[0]?.['msg']);
    // La conexion al bus FUNCIONO: el `client` de este escenario esta conectado y usable.
    // Reportarlo como "el conector no pudo conectarse al bus" mandaria al operador a revisar
    // Zitadel, la red y los montajes de credenciales cuando el arreglo es el bucket. Ese es el
    // diagnostico equivocado que ADR-006 existe para evitar.
    expect(msg).toBe(FATAL_MESSAGE);
    expect(msg).not.toContain('el conector no pudo conectarse al bus');
    expect(msg).not.toMatch(/conectar|conexion/i);
    expect(fatals[0]?.['diagnosis']).not.toBe('bus_inalcanzable');
  });

  // TS-38 (TS-88 de S-032) — contra el contenedor COMPARTIDO, que por NO tener JetStream es el doble
  // perfecto y gratis del escenario "JetStream deshabilitado". No hay que simular nada.
  it('TS-38: contra un NATS sin JetStream el diagnostico es bucket_no_usable y no sugiere grants', async () => {
    const { error, fatals } = await arrancarYFallar(bus.client);

    // Desde S-032 el SDK DISTINGUE JetStream apagado de los permisos: nadie contesta el
    // `STREAM.INFO`, y eso es un `JikuNoBucket`. El texto del CONECTOR no sugiere grants —con el KV
    // apagado serian el arreglo equivocado— y la causa exacta viaja en `causes`.
    expect(error.diagnosis).toBe('bucket_no_usable');
    expect(error.errorClass).toBe('JikuNoBucket');
    expect(error.causes[0]).toMatch(/JetStream/);
    expect(error.message).not.toMatch(/grant|permis/i);
    expect(error.message).not.toMatch(/inalcanzable|no se pudo conectar/i);

    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toMatchObject({
      code: 'KV_SPACE_UNAVAILABLE_ERROR',
      diagnosis: 'bucket_no_usable',
      bucket: 'JIKU_KV',
      msg: FATAL_MESSAGE,
    });
  });

  // TS-11 (S-033, CA-6 caso 2). El bucket EXISTE pero sin `allow_direct`: el SDK lo rechaza al abrir
  // (sin direct get no puede leer confinado al prefijo) y el conector no lo arregla. El mensaje del
  // SDK dice "Do not grant it" —contiene la palabra "grant"—, asi que "ninguna mencion de grants" se
  // afirma sobre el texto del CONECTOR (`error.message`, el `msg` del fatal), sobre la AUSENCIA del
  // campo `subject` y sobre el diagnosis, nunca sobre la linea serializada entera (Hallazgo 3).
  it('TS-11: JIKU_KV sin allow_direct -> bucket_no_usable, sin subject ni grants, y el conector no lo arregla', async () => {
    await nats.deleteBucket();
    await nats.createBucket({ allow_direct: false });

    const { error, fatals } = await arrancarYFallar();

    expect(error.diagnosis).toBe('bucket_no_usable');
    expect(error.diagnosis).not.toBe('kv_sin_permisos');
    expect(error.errorClass).toBe('JikuNoBucket');
    expect(error.causes[0]).toContain('allow_direct');
    expect(error.message).not.toMatch(/grant|permis/i);

    expect(fatals).toHaveLength(1);
    const fatal = fatals[0] ?? {};
    expect(fatal).toMatchObject({
      code: 'KV_SPACE_UNAVAILABLE_ERROR',
      diagnosis: 'bucket_no_usable',
      bucket: 'JIKU_KV',
      errorClass: 'JikuNoBucket',
      msg: FATAL_MESSAGE,
    });
    expect('subject' in fatal).toBe(false);
    expect(String(fatal['msg'])).not.toMatch(/grant|permis/i);

    // El conector no lo arreglo: el bucket sigue sin `allow_direct`.
    expect((await nats.bucketConfig())['allow_direct']).toBe(false);
  });
});
