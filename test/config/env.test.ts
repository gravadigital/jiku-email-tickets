import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { EXPECTATIONS, ConfigValidationError } from '#config/errors.js';
import { loadEnv } from '#config/env.js';

/**
 * NO HAY MOCK DE `node:fs` EN ESTE ARCHIVO, y su ausencia es una propiedad de S-025.
 *
 * Hasta S-024 este archivo mockeaba `node:fs` para contar las lecturas del archivo del Mapa de
 * Tickets: el `.transform()` de `TICKET_MAP_FILE` leia el filesystem DENTRO de la validacion del
 * schema, que era la unica excepcion declarada a que la validacion fuera pura. Con la variable se
 * fue la lectura, y con la lectura se fue la excepcion: **la validacion del schema ya no toca el
 * filesystem en ningun camino**. La unica excepcion que queda es la llamada a `validate()` de
 * node-cron en `POLL_CRON`, que no lo toca.
 *
 * Ver TS-30 en `test/config/source-properties.test.ts`, que lo afirma escaneando el archivo.
 */

/**
 * Entorno minimo valido. Los tests pasan objetos literales: nunca mutan process.env.
 *
 * Eran cuatro variables hasta S-006. S-007 sumo las tres credenciales de la casilla, que pasaron a
 * ser requeridas con la ingesta en alcance. S-012 sumo el Mapa de Tickets y **S-025 lo saco**: su
 * fuente es el bucket KV de slugs, asi que ninguna de sus dos claves se declara mas, y con ellas se
 * fue la UNICA regla cross-field que el schema tenia.
 */
const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'tickets@ejemplo.com',
  IMAP_PASSWORD: 'app-password-de-prueba',
};

/**
 * Las SEIS requeridas, en el orden alfabetico en que el formateador las lista.
 *
 * Eran ocho hasta que `JIKU_VERIFY_PROJECT_ID` se volvio OPCIONAL: la lee un solo consumidor
 * (`src/verify.ts`) y el worker no la toca, asi que su fail-fast se mudo a ese script
 * (`requireVerifyProjectId()`) en vez de exigirsela a todo despliegue. Y eran siete hasta S-025,
 * que saco el Mapa de Tickets: su fuente es el KV, no la configuracion.
 */
const ALL_REQUIRED = [
  'IMAP_HOST',
  'IMAP_PASSWORD',
  'IMAP_USER',
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
];

describe('loadEnv', () => {
  // TS-1. Las tres de IMAP salen en la MISMA lista que las del bus: una sola pasada para el
  // operador, no un fail-fast que descubre una variable por vez.
  it('reports every missing required variable together in a single list', () => {
    let caught: unknown;
    try {
      loadEnv({ JIKU_INSTANCE: 'dev' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigValidationError);
    const err = caught as ConfigValidationError;
    expect(err.variables).toEqual(ALL_REQUIRED);
    for (const name of ALL_REQUIRED) {
      expect(err.message).toContain(name);
    }
  });

  // El contracaso de TS-1 para la unica variable que SALIO de esa lista. Afirma la propiedad
  // completa desde el borde publico —no solo que el schema resuelve, sino que `loadEnv()` NO LANZA—
  // que es lo que hace que un despliegue que solo corre el worker no tenga que declarar un proyecto
  // de prueba que nunca usa. El fail-fast vive ahora en `requireVerifyProjectId()` (src/verify.ts).
  it('resolves without JIKU_VERIFY_PROJECT_ID: only verify needs it', () => {
    const { JIKU_VERIFY_PROJECT_ID: _omitted, ...withoutVerify } = VALID_ENV;

    const env = loadEnv(withoutVerify);

    expect(env.JIKU_VERIFY_PROJECT_ID).toBeUndefined();
    // Lo demas resuelve intacto: la variable salio de las requeridas sin arrastrar nada consigo.
    expect(env.JIKU_PROJECT_ID).toBe(VALID_ENV.JIKU_PROJECT_ID);
  });

  it('aborts when a single required variable is missing', () => {
    expect(() => loadEnv({ ...VALID_ENV, JIKU_PROJECT_ID: undefined })).toThrow(ConfigValidationError);

    try {
      loadEnv({ ...VALID_ENV, JIKU_PROJECT_ID: undefined });
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual(['JIKU_PROJECT_ID']);
    }
  });

  it('applies the declared defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.JIKU_INSTANCE).toBe('dev');
    expect(env.JIKU_SERVERS).toBe('nats://localhost:4222');
    expect(env.JIKU_ISSUER).toBe('https://id.grava.io');
    expect(env.JIKU_TIMEOUT).toBe(15_000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('raises a timeout below the floor to it', () => {
    expect(loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: '5000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('keeps a timeout above the floor', () => {
    expect(loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: '30000' }).JIKU_TIMEOUT).toBe(30_000);
  });

  it('lists a malformed timeout together with a missing required variable', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_TIMEOUT: 'abc', JIKU_CREDS: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toHaveLength(2);
      expect(err.variables).toContain('JIKU_TIMEOUT');
      expect(err.variables).toContain('JIKU_CREDS');
    }
  });

  it('treats an empty string as absent, not as a value', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_CREDS: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual(['JIKU_CREDS']);
    }
  });

  // INVERTIDO TRES VECES, nunca borrado, y el historial es el punto. Lo invirtio primero S-007
  // (antes afirmaba que loadEnv() resolvia SIN ninguna variable de IMAP); S-012 invirtio su ultima
  // asercion (hasta S-011 afirmaba que ninguna clave del Mapa de Tickets se declaraba); y **S-025 la
  // vuelve a invertir**: el mapa se muda al KV y sus claves desaparecen del schema. Un test borrado
  // no dejaria rastro de que la regla cambio a proposito.
  // (TS-5, TS-43, TS-49; TS-27/TS-31 de S-025)
  it('does not resolve when no IMAP variable is present', () => {
    const busOnly = {
      JIKU_CREDS: VALID_ENV.JIKU_CREDS,
      JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
      JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
      JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
    };

    expect(() => loadEnv(busOnly)).toThrow(ConfigValidationError);

    try {
      loadEnv(busOnly);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD', 'IMAP_USER']);
    }

    // Lo que volvio a cambiar de signo (TS-27 de S-025): NINGUNA clave del Mapa de Tickets se
    // declara mas. El entorno valido de arriba no las lleva, y el resultado tampoco las expone.
    expect(Object.keys(loadEnv(VALID_ENV)).some((key) => key.includes('TICKET_MAP'))).toBe(false);
  });

  // TS-21. `pollEnabled` es un interruptor operativo, no un modo de despliegue distinto.
  it('still requires the IMAP credentials with the poll explicitly disabled', () => {
    try {
      loadEnv({
        JIKU_CREDS: VALID_ENV.JIKU_CREDS,
        JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
        JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
        JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
        POLL_ENABLED: 'false',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigValidationError).variables).toEqual([
        'IMAP_HOST',
        'IMAP_PASSWORD',
        'IMAP_USER',
      ]);
    }
  });

  // TS-2. El mensaje describe la variable desde EXPECTATIONS, no desde el message de Zod.
  it('describes a missing IMAP host from the expectations table, not from zod', () => {
    try {
      loadEnv({ ...VALID_ENV, IMAP_HOST: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST']);
      // El texto sale de la tabla, no de Zod. Se afirma en las DOS direcciones: que ESTE el de
      // EXPECTATIONS y que NO este el de Zod. Sin la mitad positiva, una regresion que dejara el
      // nombre de la variable y perdiera la descripcion pasaria en verde.
      expect(err.message).toContain(EXPECTATIONS.IMAP_HOST);
      for (const zodPhrase of ['Invalid input', 'Required', 'expected string']) {
        expect(err.message, zodPhrase).not.toContain(zodPhrase);
      }
    }
  });

  // TS-4. El valor de un secreto no llega al reporte por ningun camino.
  it('never dumps an IMAP value, the password least of all', () => {
    try {
      loadEnv({ ...VALID_ENV, IMAP_PASSWORD: '', IMAP_HOST: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD']);
      for (const value of ['app-password-de-prueba', 'imap.gmail.com', 'tickets@ejemplo.com']) {
        expect(err.message, value).not.toContain(value);
        expect(JSON.stringify(err.details), value).not.toContain(value);
      }
    }
  });

  // TS-14. El cron mal formado entra en la LISTA, junto a lo demas: no corta el reporte.
  it('lists a malformed cron together with a missing required variable', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_CRON: 'no es un cron', JIKU_CREDS: undefined });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toHaveLength(2);
      expect(err.variables).toContain('POLL_CRON');
      expect(err.variables).toContain('JIKU_CREDS');
    }
  });

  // TS-20
  it('names the two accepted values when POLL_ENABLED is not one of them', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_ENABLED: 'si' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('POLL_ENABLED');
      expect(err.message).toContain('true');
      expect(err.message).toContain('false');
    }
  });

  // TS-10
  it('names 1 as the minimum when POLL_MAX_PER_TICK is below it', () => {
    try {
      loadEnv({ ...VALID_ENV, POLL_MAX_PER_TICK: '0' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('POLL_MAX_PER_TICK');
      expect(err.message).toContain('1');
    }
  });

  // TS-6 desde loadEnv: los cuatro defaults llegan al env resuelto.
  it('applies the four IMAP and poll defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.IMAP_PORT).toBe(993);
    expect(env.POLL_CRON).toBe('*/5 * * * *');
    expect(env.POLL_ENABLED).toBe(true);
    expect(env.POLL_MAX_PER_TICK).toBe(50);
  });

  it('lists the accepted levels when LOG_LEVEL is invalid', () => {
    try {
      loadEnv({ ...VALID_ENV, LOG_LEVEL: 'verbose' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toContain('LOG_LEVEL');
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
        expect(err.message).toContain(level);
      }
    }
  });

  it('never dumps a value in the failure message', () => {
    try {
      loadEnv({ ...VALID_ENV, JIKU_CREDS: '', JIKU_KEY_FILE: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['JIKU_CREDS', 'JIKU_KEY_FILE']);
    }

    try {
      loadEnv({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: 'SENTINEL-abc123' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.message).toContain('JIKU_VERIFY_PROJECT_ID');
      expect(err.message).not.toContain('SENTINEL-abc123');
      expect(JSON.stringify(err.details)).not.toContain('SENTINEL-abc123');
    }
  });

  it('exposes the verify project id as a number', () => {
    const env = loadEnv({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '42' });

    expect(env.JIKU_VERIFY_PROJECT_ID).toBe(42);
    expect(typeof env.JIKU_VERIFY_PROJECT_ID).toBe('number');
  });
});

describe('#config/env.js module', () => {
  it('has no import-time effect, so importing it never validates the host environment', async () => {
    // Si env.ts construyera `env` como constante de modulo, este import lanzaria con el entorno
    // del host incompleto. La validacion la dispara el arranque (T4/T5), no el import.
    await expect(import('#config/env.js')).resolves.toBeDefined();
  });

  it('exports loadEnvFromProcess as a function, not an evaluated constant', async () => {
    const mod = await import('#config/env.js');

    expect(typeof mod.loadEnvFromProcess).toBe('function');
    expect('env' in mod).toBe(false);
  });
});

/**
 * La lista UNICA de issues, y el Mapa de Tickets que ya no la usa (S-002 / S-025).
 *
 * Hasta S-024 este bloque se llamaba "loadEnv and the Ticket Map" y tenia doce casos: la regla de
 * las dos fuentes excluyentes, la carga del archivo con archivos temporales reales, el archivo
 * inexistente, el directorio, la equivalencia entre las dos fuentes, y la lectura unica. **Se
 * eliminaron**: probaban un MECANISMO que dejo de existir (las dos claves, su regla cross-field y la
 * lectura de filesystem dentro del schema).
 *
 * Lo que NO se elimino, y es la distincion que importa: los casos que probaban la **acumulacion de
 * issues de TODAS las claves en una sola invocacion de `onValidationError`**. Esa propiedad es de
 * S-002, nadie la toco, y sigue viva — solo que la probaban USANDO el Mapa de Tickets como una de
 * las claves que fallaban. Estan **reescritos con otras claves**, no borrados: borrarlos seria
 * perder cobertura de una propiedad intacta.
 *
 * Y ganan un rol nuevo con S-025: son los que **verifican la decision de quitar `createFinalSchema`**
 * de `src/config/env.ts`. Aquel envoltorio existia para que la regla cross-field no se perdiera
 * cuando otra clave ya habia fallado; sin regla, se elimino y la librería volvió a su
 * `parseWithDictionary()`. Que la acumulacion y la forma del `path` sobrevivan a eso es exactamente
 * lo que estos casos afirman. (TS-31, TS-33 de S-025.)
 */
describe('loadEnv: the single issue list survives the removal of the cross-field rule', () => {
  function caught(source: Record<string, string | undefined>): ConfigValidationError {
    try {
      loadEnv(source);
    } catch (error) {
      return error as ConfigValidationError;
    }
    expect.unreachable('should have thrown');
    throw new Error('unreachable');
  }

  // TS-31 de S-025. El arranque NO exige ninguna variable del mapa: el entorno valido minimo ya no
  // las lleva, y nada del reporte de error las menciona.
  it('resolves without any Ticket Map variable, and never names one', () => {
    expect(() => loadEnv(VALID_ENV)).not.toThrow();

    // Y con una clave faltante, el reporte tampoco las nombra: no quedo ninguna regla que las cite.
    const err = caught({ ...VALID_ENV, IMAP_HOST: undefined });
    expect(err.message).not.toContain('TICKET_MAP');
    expect(err.variables).not.toContain('TICKET_MAP');
    expect(err.variables).not.toContain('TICKET_MAP_FILE');
  });

  // TS-33 de S-025 — REESCRITO, no borrado. Hasta S-024 este caso probaba la acumulacion usando
  // `TICKET_MAP: undefined` como una de las dos claves que fallaban, porque era el caso CROSS-FIELD
  // que distinguia la implementacion correcta de la que solo lo parecia.
  //
  // La propiedad que probaba —**la lista acumula TODAS las claves en una sola pasada**— es de S-002
  // y sigue viva, asi que el caso se conserva con OTRAS DOS claves. Es ademas la verificacion de que
  // quitar `createFinalSchema` no rompio nada: si `parseWithDictionary()` no acumulara, o si el
  // `path` no llevara la clave como primer segmento, este caso se pone rojo.
  it('reports two distinct missing variables together in one single list', () => {
    const err = caught({ ...VALID_ENV, JIKU_CREDS: undefined, IMAP_HOST: undefined });

    expect(err.variables).toEqual(['IMAP_HOST', 'JIKU_CREDS']);
    expect(err.message).toContain(EXPECTATIONS.JIKU_CREDS);
    expect(err.message).toContain(EXPECTATIONS.IMAP_HOST);
  });

  // La otra mitad de la acumulacion, tambien reescrita con otras claves: mezcla una AUSENTE con una
  // presente pero INVALIDA. Los dos caminos de issue —clave faltante y `.refine()`/coercion que
  // rechaza— tienen que caer en la MISMA lista, que es lo que hace que un despliegue mal
  // configurado se arregle en una pasada y no en tres.
  it('reports an absent variable together with a present-but-invalid one', () => {
    const err = caught({
      ...VALID_ENV,
      JIKU_CREDS: undefined,
      POLL_CRON: 'no-es-un-cron',
      POLL_MAX_PER_TICK: '0',
    });

    expect(err.variables).toEqual(['JIKU_CREDS', 'POLL_CRON', 'POLL_MAX_PER_TICK']);
    // Un solo string multilinea con las tres: encabezado + tres lineas + cierre.
    expect(err.message.split('\n')).toHaveLength(5);
  });

  // TS-22 de S-012, INVERTIDO por S-032 (TS-47). Hasta REQ-008 este caso afirmaba que
  // `AppConfig['ruteo']['ticketMap']` era un `ReadonlyMap`: la copia en memoria que mantenia el
  // `watch()` del KV, y el contrato de solo-lectura impedia que un consumidor la mutara. Desde S-032
  // NO HAY MAPA EN LA CONFIGURACION: el Mapa de Tickets vive en el Espacio KV y `lookupTicket()` lo
  // consulta una vez por mail, sin copia. Lo que se afirma ahora es la AUSENCIA: un `ticketMap` que
  // volviera a `RuteoConfig` seria la copia en memoria —y su "slug borrado que sigue resolviendo"—
  // de vuelta.
  //
  // Es una garantia de COMPILACION (`expectTypeOf`), igual que la de antes.
  it('has no routed map in the AppConfig contract: the ticket map lives in the KV space', () => {
    expectTypeOf<AppConfig['ruteo']>().not.toHaveProperty('ticketMap');
    expectTypeOf<AppConfig>().not.toHaveProperty('kv');
  });
});

/**
 * S-032 (REQ-008): las cuatro variables `KV_*` de S-024 desaparecieron.
 *
 * Hasta S-032 aca vivia el `describe('loadEnv KV block')` con los defaults, los valores declarados,
 * los rechazos (nombre de bucket en blanco, TTL y retry invalidos) y la lista agregada. **Se
 * eliminaron enteros, y no es perdida de cobertura**: afirmaban un MECANISMO que dejo de existir
 * (dos buckets con nombre configurable, un TTL esperado que se comparaba, el reintento del
 * `watch()`). El bucket ahora es `JIKU_KV`, fijo en el SDK; no hay TTL; no hay `watch()`.
 *
 * Lo que SI se afirma es lo que garantiza que el cambio sea inofensivo para un despliegue viejo: una
 * variable vieja que quede en el entorno NO hace fallar el arranque (TS-51).
 */
describe('loadEnv: the four removed KV variables are ignored (S-032)', () => {
  // TS-51. `@t3-oss/env-core` no falla por variables desconocidas: un despliegue que todavia declara
  // las cuatro —incluso con valores que antes eran invalidos— arranca igual, y ninguna llega al env.
  it('does not fail with old KV_* values in the environment, and none reaches the result', () => {
    const run = (): ReturnType<typeof loadEnv> =>
      loadEnv({
        ...VALID_ENV,
        KV_TICKETS_BUCKET: '   ',
        KV_THREADS_BUCKET: '',
        KV_THREADS_TTL_DAYS: 'no-es-num',
        KV_WATCH_RETRY_MS: '0',
      });

    expect(run).not.toThrow();
    const env = run() as Record<string, unknown>;
    for (const name of ['KV_TICKETS_BUCKET', 'KV_THREADS_BUCKET', 'KV_THREADS_TTL_DAYS', 'KV_WATCH_RETRY_MS']) {
      expect(env, name).not.toHaveProperty(name);
    }
  });
});
