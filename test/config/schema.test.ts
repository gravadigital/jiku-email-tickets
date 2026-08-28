import { validate as isValidCron } from 'node-cron';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { readSource } from '../shared/source-scan.js';

import {
  DEFAULT_IMAP_PORT,
  DEFAULT_ISSUER,
  DEFAULT_POLL_CRON,
  DEFAULT_POLL_MAX_PER_TICK,
  DEFAULT_SERVERS_URL,
  MIN_TIMEOUT_MS,
  envSchema,
} from '#config/schema.js';

const schema = z.object(envSchema);

/**
 * Entorno minimo valido: las siete requeridas.
 *
 * Eran cuatro hasta S-006. S-007 sumo las tres credenciales de la casilla IMAP, que pasaron a ser
 * requeridas con la ingesta en alcance.
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

describe('envSchema constants', () => {
  it('sets the timeout floor at 15000 ms', () => {
    expect(MIN_TIMEOUT_MS).toBe(15_000);
  });

  it('declares the connector own issuer and bus defaults', () => {
    expect(DEFAULT_ISSUER).toBe('https://id.grava.io');
    expect(DEFAULT_SERVERS_URL).toBe('nats://localhost:4222');
  });
});

describe('envSchema', () => {
  it('applies the declared defaults when only the required variables are present', () => {
    const parsed = schema.parse(VALID_ENV);

    expect(parsed.JIKU_INSTANCE).toBe('dev');
    expect(parsed.JIKU_SERVERS).toBe('nats://localhost:4222');
    expect(parsed.JIKU_ISSUER).toBe('https://id.grava.io');
    expect(parsed.JIKU_TIMEOUT).toBe(15_000);
    expect(parsed.LOG_LEVEL).toBe('info');
  });

  it('raises a timeout below the floor up to it', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '5000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('keeps a timeout above the floor', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '30000' }).JIKU_TIMEOUT).toBe(30_000);
  });

  it('keeps a timeout exactly at the floor', () => {
    expect(schema.parse({ ...VALID_ENV, JIKU_TIMEOUT: '15000' }).JIKU_TIMEOUT).toBe(15_000);
  });

  it('rejects a malformed timeout', () => {
    const result = schema.safeParse({ ...VALID_ENV, JIKU_TIMEOUT: 'abc' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('JIKU_TIMEOUT');
  });

  it('exposes the verify project id as a number', () => {
    const parsed = schema.parse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '42' });

    expect(parsed.JIKU_VERIFY_PROJECT_ID).toBe(42);
    expect(typeof parsed.JIKU_VERIFY_PROJECT_ID).toBe('number');
  });

  it('rejects a non-numeric verify project id', () => {
    const result = schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: 'no-es-int' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('JIKU_VERIFY_PROJECT_ID');
  });

  it('rejects a non-positive verify project id', () => {
    expect(schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '0' }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_ENV, JIKU_VERIFY_PROJECT_ID: '-3' }).success).toBe(false);
  });

  it('accepts every documented log level and rejects the rest', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      expect(schema.parse({ ...VALID_ENV, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
    }
    expect(schema.safeParse({ ...VALID_ENV, LOG_LEVEL: 'verbose' }).success).toBe(false);
  });

  it('reports every missing required variable at once', () => {
    const result = schema.safeParse({ JIKU_INSTANCE: 'dev' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      'IMAP_HOST',
      'IMAP_PASSWORD',
      'IMAP_USER',
      'JIKU_CREDS',
      'JIKU_KEY_FILE',
      'JIKU_PROJECT_ID',
      'JIKU_VERIFY_PROJECT_ID',
    ]);
  });

  // INVERTIDO EN S-007, no borrado. Hasta S-006 este caso afirmaba que NINGUNA clave empezaba con
  // 'IMAP_': la ingesta no estaba en alcance y las variables de la casilla eran opcionales por
  // ausencia. Con FG-2 en alcance dejan de serlo, y un test borrado no dejaria rastro de que la
  // regla cambio a proposito. Lo que NO cambio: las del Mapa de Tickets siguen ausentes (FG-3).
  // (TS-25, TS-42)
  it('declares the four IMAP and three POLL variables, and still no ticket-map one', () => {
    const declared = Object.keys(envSchema);

    // Diecisiete desde S-007: las diez de S-003 mas las siete de la casilla y del poll.
    expect(declared).toHaveLength(17);
    for (const name of ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD']) {
      expect(declared, name).toContain(name);
    }
    for (const name of ['POLL_CRON', 'POLL_ENABLED', 'POLL_MAX_PER_TICK']) {
      expect(declared, name).toContain(name);
    }
    expect(declared.some((key) => key.includes('TICKET'))).toBe(false);
    expect(declared.some((key) => key.startsWith('MAP'))).toBe(false);
  });

  // TS-24. INBOX es fija y no configurable en v1: vive como constante del modulo de ingesta, no
  // como env var. La ausencia se afirma para que se lea como decision y no como olvido.
  it('declares no IMAP folder variable at all', () => {
    const declared = Object.keys(envSchema);

    for (const name of ['IMAP_FOLDER', 'IMAP_MAILBOX', 'IMAP_INBOX']) {
      expect(declared, name).not.toContain(name);
    }
    expect(declared.some((key) => key.includes('FOLDER') || key.includes('MAILBOX'))).toBe(false);
  });

  it('defaults NODE_ENV to production, not to development', () => {
    // El default es deliberado y contraintuitivo: el modo caro y bonito (pino-pretty) se pide
    // EXPLICITAMENTE, no se obtiene por olvido. Un despliegue que se olvido de declarar NODE_ENV
    // emite JSON, que es lo correcto; el error inverso —produccion intentando cargar un pino-pretty
    // que --omit=dev dejo afuera de la imagen— es peor.
    expect(schema.parse(VALID_ENV).NODE_ENV).toBe('production');
  });

  it('accepts the three declared environments and rejects anything else', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(schema.safeParse({ ...VALID_ENV, NODE_ENV: nodeEnv }).success, nodeEnv).toBe(true);
    }

    expect(schema.safeParse({ ...VALID_ENV, NODE_ENV: 'staging' }).success).toBe(false);
  });

  it('rejects an issuer that is not a url', () => {
    expect(schema.safeParse({ ...VALID_ENV, JIKU_ISSUER: 'no-es-url' }).success).toBe(false);
  });
});

describe('envSchema IMAP and poll defaults', () => {
  it('exposes the new defaults as named constants', () => {
    expect(DEFAULT_IMAP_PORT).toBe(993);
    expect(DEFAULT_POLL_CRON).toBe('*/5 * * * *');
    expect(DEFAULT_POLL_MAX_PER_TICK).toBe(50);
  });

  // TS-6
  it('applies the four optional defaults when only the required variables are present', () => {
    const parsed = schema.parse(VALID_ENV);

    expect(parsed.IMAP_PORT).toBe(993);
    expect(typeof parsed.IMAP_PORT).toBe('number');
    expect(parsed.POLL_CRON).toBe('*/5 * * * *');
    expect(parsed.POLL_ENABLED).toBe(true);
    expect(typeof parsed.POLL_ENABLED).toBe('boolean');
    expect(parsed.POLL_MAX_PER_TICK).toBe(50);
    expect(typeof parsed.POLL_MAX_PER_TICK).toBe('number');
  });

  // TS-28
  it('validates the IMAP port range', () => {
    expect(schema.safeParse({ ...VALID_ENV, IMAP_PORT: '0' }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_ENV, IMAP_PORT: '65536' }).success).toBe(false);

    for (const [raw, expected] of [
      ['1', 1],
      ['993', 993],
      ['65535', 65_535],
    ] as const) {
      expect(schema.parse({ ...VALID_ENV, IMAP_PORT: raw }).IMAP_PORT, raw).toBe(expected);
    }
  });

  it('keeps the three IMAP credentials required and non-empty', () => {
    for (const name of ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD'] as const) {
      const result = schema.safeParse({ ...VALID_ENV, [name]: '' });

      expect(result.success, name).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), name).toContain(name);
    }
  });
});

describe('envSchema POLL_MAX_PER_TICK', () => {
  // TS-7
  it('rejects zero: the minimum is 1', () => {
    const result = schema.safeParse({ ...VALID_ENV, POLL_MAX_PER_TICK: '0' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('POLL_MAX_PER_TICK');
  });

  // TS-8
  it('accepts one, the lower boundary', () => {
    expect(schema.parse({ ...VALID_ENV, POLL_MAX_PER_TICK: '1' }).POLL_MAX_PER_TICK).toBe(1);
  });

  // TS-9
  it('rejects a non-integer and a non-numeric value', () => {
    expect(schema.safeParse({ ...VALID_ENV, POLL_MAX_PER_TICK: '2.5' }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_ENV, POLL_MAX_PER_TICK: 'abc' }).success).toBe(false);
  });

  it('rejects a negative value', () => {
    expect(schema.safeParse({ ...VALID_ENV, POLL_MAX_PER_TICK: '-1' }).success).toBe(false);
  });
});

describe('envSchema POLL_CRON', () => {
  // TS-11
  it('rejects a malformed cron expression', () => {
    const result = schema.safeParse({ ...VALID_ENV, POLL_CRON: 'no es un cron' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain('POLL_CRON');
  });

  // TS-12. El veredicto se cruza contra validate() de node-cron para que el test afirme la
  // EQUIVALENCIA con la libreria que despues schedula, y no una lista propia que pueda divergir.
  it('agrees with node-cron on every expression, valid or not', () => {
    for (const expr of ['*/5 * * * *', '0 * * * *', '0 0 * * 1', '*/30 * * * * *']) {
      expect(isValidCron(expr), expr).toBe(true);
      expect(schema.parse({ ...VALID_ENV, POLL_CRON: expr }).POLL_CRON, expr).toBe(expr);
    }

    for (const expr of ['no es un cron', '* * * *', '99 * * * *', 'a b c d e']) {
      expect(isValidCron(expr), expr).toBe(false);
      expect(schema.safeParse({ ...VALID_ENV, POLL_CRON: expr }).success, expr).toBe(false);
    }
  });

  // TS-13. La validacion tiene que salir de la libreria, no de un regex propio: un regex que acepte
  // lo que node-cron rechaza reintroduce el fallo diferido en el peor lugar posible — ya con el
  // logger construido y la conexion abierta.
  it('validates with the node-cron function, not with a regex of its own', () => {
    const code = readSource('config/schema.ts');

    expect(code).toMatch(/from 'node-cron'/);
    expect(code).toMatch(/POLL_CRON:[\s\S]*?\.refine\(/);
    expect(code).not.toMatch(/new RegExp/);
    // Ninguna literal de regex en el archivo entero: el unico candidato seria el cron.
    expect(code).not.toMatch(/=\s*\/[^/\n]+\//);
  });
});

describe('envSchema POLL_ENABLED', () => {
  // TS-15
  it('disables the poll for real with the literal string false', () => {
    const parsed = schema.parse({ ...VALID_ENV, POLL_ENABLED: 'false' });

    expect(parsed.POLL_ENABLED).toBe(false);
    expect(typeof parsed.POLL_ENABLED).toBe('boolean');
  });

  // TS-16
  it('enables the poll with the literal string true', () => {
    expect(schema.parse({ ...VALID_ENV, POLL_ENABLED: 'true' }).POLL_ENABLED).toBe(true);
  });

  // TS-17. La trampa concreta de esta variable: z.coerce.boolean() aplica Boolean(value), y
  // Boolean('false') es TRUE — o sea que POLL_ENABLED=false habilitaria el poll, en silencio.
  it('does not coerce the string false into true', () => {
    expect(schema.parse({ ...VALID_ENV, POLL_ENABLED: 'false' }).POLL_ENABLED).not.toBe(true);
    expect(Boolean('false')).toBe(true);
  });

  // TS-18, TS-19
  it('refuses to interpret anything that is not the two literals', () => {
    for (const value of ['si', 'True', 'FALSE', '1', '0', 'yes']) {
      const result = schema.safeParse({ ...VALID_ENV, POLL_ENABLED: value });

      expect(result.success, value).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), value).toContain('POLL_ENABLED');
    }
  });
});

describe('envSchema IMAP requirement independence', () => {
  // TS-21. `pollEnabled` es un interruptor operativo, no un modo de despliegue distinto.
  it('keeps the IMAP credentials required with the poll disabled', () => {
    const result = schema.safeParse({
      JIKU_CREDS: '/run/secrets/sentinel.creds',
      JIKU_KEY_FILE: '/run/secrets/machine-user.json',
      JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
      JIKU_VERIFY_PROJECT_ID: '42',
      POLL_ENABLED: 'false',
    });

    expect(result.success).toBe(false);
    expect(
      [...new Set(result.error?.issues.map((i) => i.path[0]))].sort(),
    ).toEqual(['IMAP_HOST', 'IMAP_PASSWORD', 'IMAP_USER']);
  });

  // TS-22. Sin logica condicional: el schema las declara requeridas y punto. Un schema condicional
  // convertiria un interruptor en dos configuraciones validas distintas, y la segunda no la
  // ejercita nadie.
  it('implements that requirement with no conditional logic at all', () => {
    for (const relative of ['config/schema.ts', 'config/index.ts']) {
      const code = readSource(relative);

      expect(code, relative).not.toMatch(/superRefine/);
      expect(code, relative).not.toMatch(/discriminatedUnion/);
      // Ninguna rama condicional sobre el interruptor del poll.
      expect(code, relative).not.toMatch(/if\s*\([^)]*POLL_ENABLED/);
      expect(code, relative).not.toMatch(/if\s*\([^)]*poll\.enabled/);
      expect(code, relative).not.toMatch(/POLL_ENABLED[^\n]*\?[^\n]*:/);
      expect(code, relative).not.toMatch(/poll\.enabled[^\n]*\?[^\n]*:/);
    }

    const schemaSource = readSource('config/schema.ts');
    for (const name of ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD']) {
      expect(schemaSource, name).toMatch(
        new RegExp(`${name}: z\\.string\\(\\)\\.min\\(1\\),`),
      );
    }
  });

  // TS-12 (parte de codigo): el schema no lee el entorno por su cuenta.
  it('never mentions process.env in the schema module', () => {
    expect(readSource('config/schema.ts')).not.toMatch(/process\.env/);
  });
});
