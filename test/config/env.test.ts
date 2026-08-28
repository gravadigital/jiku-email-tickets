import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { EXPECTATIONS, ConfigValidationError } from '#config/errors.js';
import { loadEnv } from '#config/env.js';

/**
 * Las rutas que `readFileSync` recibio, para el caso de la lectura unica (TS-32).
 *
 * El mock delega en la implementacion real: solo cuenta. En ESM no se puede `vi.spyOn` un modulo
 * nativo —el namespace no es configurable— asi que la unica forma de contar sin reemplazar el
 * comportamiento es esta.
 */
const readFileSyncCalls: unknown[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      readFileSyncCalls.push(path);
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

/**
 * Entorno minimo valido. Los tests pasan objetos literales: nunca mutan process.env.
 *
 * Eran cuatro variables hasta S-006. S-007 sumo las tres credenciales de la casilla, que pasaron a
 * ser requeridas con la ingesta en alcance. S-012 sumo el Mapa de Tickets, que con el ruteo en
 * alcance pasa a ser requerido: su obligatoriedad es cross-field (una de las dos fuentes) y por eso
 * solo se ve desde loadEnv(), nunca desde el schema desnudo.
 */
const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'tickets@ejemplo.com',
  IMAP_PASSWORD: 'app-password-de-prueba',
  TICKET_MAP: '{"alfa":42,"beta":7}',
};

/** Las ocho requeridas, en el orden alfabetico en que el formateador las lista. */
const ALL_REQUIRED = [
  'IMAP_HOST',
  'IMAP_PASSWORD',
  'IMAP_USER',
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
  'JIKU_VERIFY_PROJECT_ID',
  'TICKET_MAP',
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

  // INVERTIDO EN S-012, no borrado. Lo invirtio primero S-007 (antes afirmaba que loadEnv()
  // resolvia SIN ninguna variable de IMAP) y lo vuelve a invertir S-012 en su ultima asercion: hasta
  // S-011 afirmaba que ninguna clave del Mapa de Tickets se declaraba en este alcance, porque FG-3
  // no estaba en scope. Con el ruteo en alcance el mapa se declara y ademas es requerido, asi que la
  // misma asercion cambia de signo. Un test borrado no dejaria rastro de que la regla cambio a
  // proposito.
  // (TS-5, TS-43, TS-49)
  it('does not resolve when no IMAP variable is present', () => {
    const busOnly = {
      JIKU_CREDS: VALID_ENV.JIKU_CREDS,
      JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
      JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
      JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
      TICKET_MAP: VALID_ENV.TICKET_MAP,
    };

    expect(() => loadEnv(busOnly)).toThrow(ConfigValidationError);

    try {
      loadEnv(busOnly);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD', 'IMAP_USER']);
    }

    // Lo que cambio de signo: las claves del Mapa de Tickets SI se declaran en este alcance.
    expect(Object.keys(loadEnv(VALID_ENV)).some((key) => key.includes('TICKET'))).toBe(true);
  });

  // TS-21. `pollEnabled` es un interruptor operativo, no un modo de despliegue distinto.
  it('still requires the IMAP credentials with the poll explicitly disabled', () => {
    try {
      loadEnv({
        JIKU_CREDS: VALID_ENV.JIKU_CREDS,
        JIKU_KEY_FILE: VALID_ENV.JIKU_KEY_FILE,
        JIKU_PROJECT_ID: VALID_ENV.JIKU_PROJECT_ID,
        JIKU_VERIFY_PROJECT_ID: VALID_ENV.JIKU_VERIFY_PROJECT_ID,
        TICKET_MAP: VALID_ENV.TICKET_MAP,
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
 * La regla de las dos fuentes excluyentes y la carga del archivo (S-012).
 *
 * Estos tests escriben archivos temporales REALES y no un doble: `readFileSync` es la operacion
 * bajo prueba, y un mock del filesystem afirmaria sobre el mock.
 */
describe('loadEnv and the Ticket Map', () => {
  const dirs: string[] = [];

  /** Escribe un archivo temporal con el contenido dado y devuelve su ruta. */
  function tempFile(content: string, name = 'mapa.json'): string {
    const dir = mkdtempSync(join(tmpdir(), 'jiku-ticket-map-'));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  /** Un directorio temporal vacio, para el caso del `readFileSync` sobre un directorio. */
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jiku-ticket-map-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function caught(source: Record<string, string | undefined>): ConfigValidationError {
    try {
      loadEnv(source);
    } catch (error) {
      return error as ConfigValidationError;
    }
    expect.unreachable('should have thrown');
    throw new Error('unreachable');
  }

  // TS-1. CA-1: el mapa pasa a ser requerido, y esto SUPERSEDE el criterio 40 de REQ-002. No arranca
  // por ausencia, y lo informa en la lista unica como una variable mas.
  it('does not start when the map is absent from both sources', () => {
    const err = caught({ ...VALID_ENV, TICKET_MAP: undefined });

    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.variables).toContain('TICKET_MAP');
    expect(err.message).toContain(EXPECTATIONS.TICKET_MAP);
  });

  // TS-2. CA-2: elegir una en silencio dejaria a U-02 editando la que no tiene efecto.
  it('does not start when both sources are declared at once', () => {
    const err = caught({
      ...VALID_ENV,
      TICKET_MAP: '{}',
      TICKET_MAP_FILE: tempFile('{"alfa":42}'),
    });

    expect(err.variables).toContain('TICKET_MAP');
    // El issue de las dos fuentes va al path de TICKET_MAP a proposito: variableNameOf() toma
    // path[0] y lo busca en EXPECTATIONS, y es la entrada de TICKET_MAP la que explica la regla.
    expect(err.message).toContain('TICKET_MAP_FILE');
  });

  // TS-3. EL TEST MAS IMPORTANTE DE LA STORY (CA-3). Es el que distingue la implementacion correcta
  // de la que PARECE correcta: con un `z.object(shape).superRefine(reglaDeDosFuentes)` este caso
  // falla en silencio, porque Zod no corre el refinement si alguna clave del objeto ya fallo — y el
  // issue del mapa no aparece nunca. Por eso la regla vive en un Standard Schema propio que
  // CONCATENA las dos listas de issues sin cortar.
  it('reports the bus, the mailbox and the map together in one single list', () => {
    const err = caught({
      JIKU_CREDS: undefined,
      JIKU_KEY_FILE: undefined,
      JIKU_PROJECT_ID: undefined,
      JIKU_VERIFY_PROJECT_ID: '42',
      IMAP_HOST: undefined,
      IMAP_USER: 'u',
      IMAP_PASSWORD: 'p',
      TICKET_MAP: 'no-es-json',
    });

    expect(err.variables).toEqual([
      'IMAP_HOST',
      'JIKU_CREDS',
      'JIKU_KEY_FILE',
      'JIKU_PROJECT_ID',
      'TICKET_MAP',
    ]);
    // Un solo string multilinea con las cinco: encabezado + cinco lineas + cierre.
    expect(err.message.split('\n')).toHaveLength(7);
  });

  // TS-3, la mitad que de verdad distingue las dos implementaciones. El caso de arriba usa un mapa
  // MAL FORMADO, que es un issue de clave y sale por el `.transform()`: ese camino sobrevive incluso
  // a un superRefine ingenuo. El que NO sobrevive es este: el mapa AUSENTE, que es cross-field. Con
  // `z.object(shape).superRefine(...)` el refinement no corre porque JIKU_CREDS ya fallo, y el issue
  // del mapa DESAPARECE de la lista, en silencio y sin que nada falle. Si este caso se pone en
  // verde con una implementacion que corta, la regla se rompio: el test es CA-3, no al reves.
  it('reports the absent map together with a missing bus variable, in one single list', () => {
    const err = caught({ ...VALID_ENV, JIKU_CREDS: undefined, TICKET_MAP: undefined });

    expect(err.variables).toEqual(['JIKU_CREDS', 'TICKET_MAP']);
    expect(err.message).toContain(EXPECTATIONS.TICKET_MAP);
    expect(err.message).toContain('JIKU_CREDS');
  });

  // La misma prueba para la OTRA regla cross-field: las dos fuentes a la vez tampoco pueden
  // perderse porque otra clave haya fallado antes.
  it('reports the two declared sources together with a missing bus variable', () => {
    const err = caught({
      ...VALID_ENV,
      JIKU_CREDS: undefined,
      TICKET_MAP: '{}',
      TICKET_MAP_FILE: tempFile('{"alfa":42}'),
    });

    expect(err.variables).toEqual(['JIKU_CREDS', 'TICKET_MAP']);
  });

  // TS-4. El archivo roto entra en la MISMA lista que una variable ausente, en UNA invocacion. Es
  // el criterio que decide donde vive la carga del archivo: leerlo despues de loadEnvFromProcess()
  // daria dos mensajes en dos formatos.
  it('lists a broken map file together with a missing variable, in one invocation', () => {
    const err = caught({
      ...VALID_ENV,
      IMAP_HOST: undefined,
      TICKET_MAP: undefined,
      TICKET_MAP_FILE: tempFile('no-es-json'),
    });

    expect(err.variables).toEqual(['IMAP_HOST', 'TICKET_MAP_FILE']);
  });

  // TS-14. El mensaje no incluye la ruta ni el contenido: el formateador lee solo issue.path.
  it('does not start when the file path does not exist, without naming the path', () => {
    const err = caught({
      ...VALID_ENV,
      TICKET_MAP: undefined,
      TICKET_MAP_FILE: '/no/existe/mapa.json',
    });

    expect(err.variables).toEqual(['TICKET_MAP_FILE']);
    expect(err.message).not.toContain('/no/existe/mapa.json');
  });

  // TS-15. Un directorio y no un chmod 000: si la suite corre como root, chmod 000 no bloquea nada y
  // el test pasaria en verde sin probar el caso. El catch cubre los tres —inexistente, ilegible y
  // directorio— porque el operador arregla lo mismo en los tres.
  it('does not start when the path is a directory instead of a readable file', () => {
    const err = caught({
      ...VALID_ENV,
      TICKET_MAP: undefined,
      TICKET_MAP_FILE: tempDir(),
    });

    expect(err.variables).toEqual(['TICKET_MAP_FILE']);
  });

  // TS-17. Las dos fuentes producen EXACTAMENTE lo mismo: es la razon de que compartan una sola
  // funcion de parseo y de que las dos acepten el mismo JSON.
  it('produces the same map from the file source as from the inline one', () => {
    const inline = loadEnv({ ...VALID_ENV, TICKET_MAP: '{"Alfa":42,"BETA":7}' }).TICKET_MAP;
    const fromFile = loadEnv({
      ...VALID_ENV,
      TICKET_MAP: undefined,
      TICKET_MAP_FILE: tempFile('{"Alfa":42,"BETA":7}'),
    }).TICKET_MAP_FILE;

    expect([...(inline as ReadonlyMap<string, number>).entries()]).toEqual([
      ['alfa', 42],
      ['beta', 7],
    ]);
    expect([...(fromFile as ReadonlyMap<string, number>).entries()]).toEqual([
      ['alfa', 42],
      ['beta', 7],
    ]);
  });

  // TS-19. La AUSENCIA no arranca (TS-1); el vacio si, tambien desde el archivo.
  it('accepts an empty map from the file source too', () => {
    const env = loadEnv({
      ...VALID_ENV,
      TICKET_MAP: undefined,
      TICKET_MAP_FILE: tempFile('{}'),
    });

    expect((env.TICKET_MAP_FILE as ReadonlyMap<string, number>).size).toBe(0);
  });

  // TS-22. `ReadonlyMap` en el contrato es lo que impide que un consumidor haga `.set()` sin darse
  // cuenta. El Map real es mutable; el tipo es lo que lo sella.
  //
  // La asercion es sobre el tipo de `AppConfig['ruteo']['ticketMap']` y NO sobre un cast local: un
  // `as ReadonlyMap<...>` en el test probaria el cast y no el contrato, y seguiria compilando si
  // alguien aflojara la interfaz a `Map`. Asi, aflojarla rompe `tsc`, que es el unico lugar donde
  // esta garantia puede vivir: es de COMPILACION, no de runtime (el Map real es mutable, y
  // `Object.freeze` no lo congelaria de todas formas).
  it('types the resolved map as read-only in the AppConfig contract', () => {
    expectTypeOf<AppConfig['ruteo']['ticketMap']>().toEqualTypeOf<ReadonlyMap<string, number>>();

    const map: ReadonlyMap<string, number> = loadEnv(VALID_ENV).TICKET_MAP as AppConfig['ruteo']['ticketMap'];

    // @ts-expect-error un ReadonlyMap no expone set()
    void map.set;
    expect(map.get('alfa')).toBe(42);
  });

  // TS-32. El archivo se lee EXACTAMENTE una vez por arranque: ni el schema lo relee por cada
  // consumidor, ni queda ninguna recarga en caliente escondida (CA-11).
  //
  // Se cuenta con `vi.mock` de `node:fs` y no con `vi.spyOn`: en ESM el namespace del modulo no es
  // configurable y `spyOn` lanza `Cannot redefine property`. El mock delega en la implementacion
  // REAL (`importActual`), asi que lo que se afirma sigue siendo la cantidad de lecturas de verdad
  // sobre ESE path, no el comportamiento de un doble.
  it('reads the map file exactly once per load', async () => {
    const path = tempFile('{"alfa":42}');
    readFileSyncCalls.length = 0;

    // La importacion dinamica es la que engancha el modulo mockeado: el `loadEnv` del import
    // estatico de arriba ya cerro sobre el `node:fs` real.
    const { loadEnv: loadEnvMocked } = await import('#config/env.js');
    loadEnvMocked({ ...VALID_ENV, TICKET_MAP: undefined, TICKET_MAP_FILE: path });

    expect(readFileSyncCalls.filter((target) => target === path)).toHaveLength(1);
  });
});
