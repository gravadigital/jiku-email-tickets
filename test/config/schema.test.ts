import { validate as isValidCron } from 'node-cron';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { readSource } from '../shared/source-scan.js';

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_IMAP_PORT,
  DEFAULT_ISSUER,
  DEFAULT_MAX_ATTACHMENT_SIZE_BYTES,
  DEFAULT_PLACEHOLDER_BODY,
  DEFAULT_PLACEHOLDER_TITLE,
  DEFAULT_POLL_CRON,
  DEFAULT_POLL_MAX_PER_TICK,
  DEFAULT_PUT_TIMEOUT_MS,
  DEFAULT_SERVERS_URL,
  DEFAULT_SUBADDRESS_PREFIX,
  MAX_ATTACHMENTS_PER_REQUIREMENT,
  MIN_TIMEOUT_MS,
  envSchema,
} from '#config/schema.js';

const schema = z.object(envSchema);

/**
 * Entorno minimo valido: las ocho requeridas.
 *
 * Eran cuatro hasta S-006. S-007 sumo las tres credenciales de la casilla IMAP, que pasaron a ser
 * requeridas con la ingesta en alcance. S-012 sumo el Mapa de Tickets: con el ruteo en alcance
 * pasa a ser requerido (supersede el criterio 40 de REQ-002).
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

  // INVERTIDO EN S-012, no borrado. La primera mitad la INVIRTIO S-007 (hasta S-006 afirmaba que
  // NINGUNA clave empezaba con 'IMAP_'); la segunda la invierte S-012. Hasta S-011 este caso
  // afirmaba que las del Mapa de Tickets seguian ausentes porque FG-3 no estaba en alcance: con el
  // ruteo en alcance el mapa pasa a ser requerido, y un test borrado no dejaria rastro de que la
  // regla cambio a proposito.
  // (TS-25, TS-36, TS-42)
  it('declares the four IMAP and three POLL variables, the five routing ones, and the four attachment policy ones', () => {
    const declared = Object.keys(envSchema);

    // Veintiseis desde S-017: las veintidos de S-012 mas las cuatro de la politica de archivos.
    expect(declared).toHaveLength(26);
    for (const name of ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD']) {
      expect(declared, name).toContain(name);
    }
    for (const name of ['POLL_CRON', 'POLL_ENABLED', 'POLL_MAX_PER_TICK']) {
      expect(declared, name).toContain(name);
    }
    for (const name of [
      'TICKET_MAP',
      'TICKET_MAP_FILE',
      'SUBADDRESS_PREFIX',
      'PLACEHOLDER_TITLE',
      'PLACEHOLDER_BODY',
    ]) {
      expect(declared, name).toContain(name);
    }
    for (const name of [
      'ATTACHMENT_ALLOWED_EXTENSIONS',
      'ATTACHMENT_ALLOWED_MIME_TYPES',
      'ATTACHMENT_MAX_SIZE_BYTES',
      'PUT_TIMEOUT_MS',
    ]) {
      expect(declared, name).toContain(name);
    }
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

  // TS-22, TS-41. ACOTADO EN S-012, no borrado. La prohibicion nacio en S-007 sobre el interruptor
  // `POLL_ENABLED` —"un schema condicional convertiria un interruptor en dos configuraciones
  // validas distintas, y la segunda no la ejercita nadie"— pero se escribio como una prohibicion
  // global de `superRefine` sobre el archivo entero. S-012 la acota a su intencion: la validacion
  // cruzada de las dos fuentes del Mapa de Tickets es de otra naturaleza (no ramifica el schema:
  // lo valida), asi que la prohibicion de `superRefine` se levanta SOLO para `config/schema.ts`.
  // En `config/index.ts` se conserva tal cual, porque el compositor efectivamente no valida nada.
  it('implements that requirement with no conditional logic at all', () => {
    for (const relative of ['config/schema.ts', 'config/index.ts']) {
      const code = readSource(relative);

      expect(code, relative).not.toMatch(/discriminatedUnion/);
      // Ninguna rama condicional sobre el interruptor del poll.
      expect(code, relative).not.toMatch(/if\s*\([^)]*POLL_ENABLED/);
      expect(code, relative).not.toMatch(/if\s*\([^)]*poll\.enabled/);
      expect(code, relative).not.toMatch(/POLL_ENABLED[^\n]*\?[^\n]*:/);
      expect(code, relative).not.toMatch(/poll\.enabled[^\n]*\?[^\n]*:/);
    }

    // El compositor sigue sin validar nada: toda la logica quedo en el schema.
    expect(readSource('config/index.ts')).not.toMatch(/superRefine/);

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

/**
 * El Mapa de Tickets (S-012).
 *
 * La carga vive en el `.transform()` de cada clave y no en un refinement sobre el objeto: es lo que
 * hace que sus fallos entren como un issue mas en la lista unica que arma `parseWithDictionary()`
 * de `@t3-oss/env-core`. Estos casos ejercitan el schema desnudo; la regla cross-field de las dos
 * fuentes se prueba desde `loadEnv()` en `env.test.ts`, que es donde vive.
 */
describe('envSchema TICKET_MAP', () => {
  /** El Map resuelto de un entorno valido, ya normalizado. */
  function mapOf(raw: string): ReadonlyMap<string, number> {
    return schema.parse({ ...VALID_ENV, TICKET_MAP: raw }).TICKET_MAP as ReadonlyMap<string, number>;
  }

  function failsOn(raw: string): void {
    const result = schema.safeParse({ ...VALID_ENV, TICKET_MAP: raw });

    expect(result.success, raw).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]), raw).toContain('TICKET_MAP');
  }

  // TS-16
  it('normalizes the slugs to lowercase while loading', () => {
    const map = mapOf('{"Alfa":42,"BETA":7}');

    expect([...map.entries()]).toEqual([
      ['alfa', 42],
      ['beta', 7],
    ]);
    expect(map.get('alfa')).toBe(42);
  });

  // TS-18. La AUSENCIA no arranca (se prueba en env.test.ts, es cross-field); el mapa VACIO si.
  // Es la diferencia entre una decision del operador y un olvido de configuracion.
  it('accepts an empty map as a valid state', () => {
    const map = mapOf('{}');

    expect(map.size).toBe(0);
  });

  // TS-5
  it('rejects content that is not parseable JSON', () => {
    failsOn('{alfa: 42');
  });

  // TS-6, TS-7
  it('rejects JSON that is not an object of pairs', () => {
    failsOn('[1,2,3]');
    failsOn('"alfa"');
    failsOn('42');
  });

  // TS-8, TS-9
  it('rejects a projectId that is not a positive integer', () => {
    failsOn('{"alfa":2.5}');
    failsOn('{"alfa":0}');
    failsOn('{"alfa":-3}');
  });

  // TS-10. No se coerce: un projectId como string es un mapa mal escrito, no un valor a rescatar.
  it('does not coerce a projectId given as a string', () => {
    failsOn('{"alfa":"42"}');
  });

  // TS-11. La clave se recorta antes de evaluarla, asi que un slug de solo espacios es vacio.
  it('rejects an empty slug', () => {
    failsOn('{"":42}');
    failsOn('{"   ":42}');
  });

  // TS-12
  it('rejects slugs that collapse into the same key once trimmed', () => {
    failsOn('{"alfa":42,"alfa ":7}');
  });

  // TS-13. El caso que JSON.parse NO resuelve solo: son dos claves distintas hasta que se
  // normalizan, y es el error que un operador comete de verdad.
  it('rejects slugs that only differ in casing', () => {
    failsOn('{"Alfa":42,"alfa":7}');
  });

  // TS-20. DOCUMENTA la limitacion, no la finge cumplida: con la clave EXACTAMENTE repetida el
  // parser ya resolvio el duplicado antes de que el conector vea nada, y gana la ultima. Lo que si
  // se garantiza es que el resultado nunca es un ruteo arbitrario silencioso: aca el valor es
  // deterministico, y el caso real (claves que difieren en casing) no arranca (TS-13).
  it('cannot detect an exactly repeated key, because JSON.parse already deduplicated it', () => {
    const map = mapOf('{"alfa":42,"alfa":7}');

    expect(map.get('alfa')).toBe(7);
    expect(map.size).toBe(1);
  });

  // TS-21. ADR-004: el conector no verifica contra Jiku que el proyecto exista. El sintoma aparece
  // por mail, como `project_not_found`.
  it('accepts a projectId that does not exist in Jiku, without consulting anything', () => {
    expect(mapOf('{"alfa":999999999}').get('alfa')).toBe(999_999_999);
  });
});

describe('envSchema routing defaults', () => {
  // TS-24
  it('exposes the three routing defaults as named constants', () => {
    expect(DEFAULT_SUBADDRESS_PREFIX).toBe('tickets');
    expect(DEFAULT_PLACEHOLDER_TITLE).toBe('Ticket recibido por mail');
    expect(DEFAULT_PLACEHOLDER_BODY).toBe('(mail sin contenido)');
  });

  // TS-23
  it('applies the three defaults when nothing is configured', () => {
    const parsed = schema.parse(VALID_ENV);

    expect(parsed.SUBADDRESS_PREFIX).toBe('tickets');
    expect(parsed.PLACEHOLDER_TITLE).toBe('Ticket recibido por mail');
    expect(parsed.PLACEHOLDER_BODY).toBe('(mail sin contenido)');
  });

  // TS-25
  it('prefers a configured value over the default', () => {
    const parsed = schema.parse({
      ...VALID_ENV,
      SUBADDRESS_PREFIX: 'soporte',
      PLACEHOLDER_TITLE: 'Sin asunto',
      PLACEHOLDER_BODY: 'Sin cuerpo',
    });

    expect(parsed.SUBADDRESS_PREFIX).toBe('soporte');
    expect(parsed.PLACEHOLDER_TITLE).toBe('Sin asunto');
    expect(parsed.PLACEHOLDER_BODY).toBe('Sin cuerpo');
  });

  // TS-26. El string vacio lo convierte `emptyStringAsUndefined` en ausente (y cae al default), asi
  // que el caso que hay que probar de verdad es un valor SOLO de espacios, que si llega como valor.
  it('rejects a value made only of whitespace', () => {
    for (const name of ['SUBADDRESS_PREFIX', 'PLACEHOLDER_TITLE', 'PLACEHOLDER_BODY'] as const) {
      const result = schema.safeParse({ ...VALID_ENV, [name]: '   ' });

      expect(result.success, name).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), name).toContain(name);
    }
  });
});

/**
 * La politica local de archivos de adjuntos (S-017, Task 1). Las cuatro claves son independientes
 * entre si -- ninguna es cross-field -- asi que se prueban directo contra `schema`, igual que
 * IMAP_PORT o POLL_MAX_PER_TICK.
 */
describe('envSchema attachment policy defaults', () => {
  it('exposes the four defaults and the fixed cap as named constants', () => {
    expect(DEFAULT_ALLOWED_EXTENSIONS).toBe(
      '.png,.jpg,.jpeg,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.log,.zip',
    );
    expect(DEFAULT_ALLOWED_MIME_TYPES).toContain('image/png');
    expect(DEFAULT_MAX_ATTACHMENT_SIZE_BYTES).toBe(10_485_760);
    expect(DEFAULT_PUT_TIMEOUT_MS).toBe(30_000);
    expect(MAX_ATTACHMENTS_PER_REQUIREMENT).toBe(10);
  });

  // TS-21. Las cuatro claves nuevas arrancan con sus defaults si no se declaran.
  it('applies the four defaults when only the required variables are present', () => {
    const parsed = schema.parse(VALID_ENV);

    expect(parsed.ATTACHMENT_ALLOWED_EXTENSIONS).toEqual(
      DEFAULT_ALLOWED_EXTENSIONS.split(','),
    );
    expect(parsed.ATTACHMENT_ALLOWED_MIME_TYPES).toEqual(DEFAULT_ALLOWED_MIME_TYPES.split(','));
    expect(parsed.ATTACHMENT_MAX_SIZE_BYTES).toBe(10_485_760);
    expect(typeof parsed.ATTACHMENT_MAX_SIZE_BYTES).toBe('number');
    expect(parsed.PUT_TIMEOUT_MS).toBe(30_000);
  });

  // TS-19. Una lista blanca vacia tras el parseo no es un modo valido.
  it('rejects an empty allow-list after parsing', () => {
    for (const name of ['ATTACHMENT_ALLOWED_EXTENSIONS', 'ATTACHMENT_ALLOWED_MIME_TYPES'] as const) {
      const result = schema.safeParse({ ...VALID_ENV, [name]: ',, ,' });

      expect(result.success, name).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), name).toContain(name);
    }
  });

  // TS-20. No numerico o <= 0 no arranca.
  it('rejects a non-numeric or non-positive max size', () => {
    for (const raw of ['0', '-1', 'abc']) {
      const result = schema.safeParse({ ...VALID_ENV, ATTACHMENT_MAX_SIZE_BYTES: raw });

      expect(result.success, raw).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), raw).toContain('ATTACHMENT_MAX_SIZE_BYTES');
    }
  });

  it('rejects a non-numeric or non-positive PUT timeout', () => {
    for (const raw of ['0', '-1', 'abc']) {
      const result = schema.safeParse({ ...VALID_ENV, PUT_TIMEOUT_MS: raw });

      expect(result.success, raw).toBe(false);
      expect(result.error?.issues.map((i) => i.path[0]), raw).toContain('PUT_TIMEOUT_MS');
    }
  });

  // Cada elemento se recorta, incluso con espacios extra alrededor de las comas.
  it('trims each element of a comma-separated list with extra whitespace', () => {
    const parsed = schema.parse({
      ...VALID_ENV,
      ATTACHMENT_ALLOWED_EXTENSIONS: ' .png , .pdf ',
    });

    expect(parsed.ATTACHMENT_ALLOWED_EXTENSIONS).toEqual(['.png', '.pdf']);
  });

  // Las extensiones se normalizan a minusculas al parsear; los MIME no.
  it('lowercases extensions but not MIME types while parsing', () => {
    const parsed = schema.parse({
      ...VALID_ENV,
      ATTACHMENT_ALLOWED_EXTENSIONS: '.PNG,.PDF',
      ATTACHMENT_ALLOWED_MIME_TYPES: 'image/png,application/pdf',
    });

    expect(parsed.ATTACHMENT_ALLOWED_EXTENSIONS).toEqual(['.png', '.pdf']);
    expect(parsed.ATTACHMENT_ALLOWED_MIME_TYPES).toEqual(['image/png', 'application/pdf']);
  });

  // Cada clave es independiente: declarar solo una de las dos listas arranca igual.
  it('starts with only one of the two allow-lists declared', () => {
    const parsed = schema.parse({ ...VALID_ENV, ATTACHMENT_ALLOWED_EXTENSIONS: '.png' });

    expect(parsed.ATTACHMENT_ALLOWED_EXTENSIONS).toEqual(['.png']);
    expect(parsed.ATTACHMENT_ALLOWED_MIME_TYPES).toEqual(DEFAULT_ALLOWED_MIME_TYPES.split(','));
  });
});
