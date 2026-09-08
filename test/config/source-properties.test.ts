import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type SourceFile, sourceFiles } from '../shared/source-scan.js';

const CONFIG_DIR = `config${sep}`;

// El walker y el limpiador de comentarios viven en el helper compartido: S-007 los extrajo al
// agregar el escaner de puntos de log de abajo, para no tener dos copias del mismo recorrido de
// `src/` en el mismo archivo.
const FILES: SourceFile[] = sourceFiles();

const outsideConfig = (file: SourceFile): boolean => !file.relativePath.startsWith(CONFIG_DIR);

describe('src/ source properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Si el scanner devolviera vacio, todos los tests de abajo pasarian sin verificar nada.
    expect(FILES.length).toBeGreaterThan(3);
    expect(FILES.map((f) => f.relativePath)).toContain(`${CONFIG_DIR}env.ts`);
  });

  // CA-1, con UNA excepcion nombrada y acotada. La propiedad sigue siendo la misma: la
  // CONFIGURACION DEL SERVICIO se lee en un solo lugar validado, `src/config/env.ts`.
  //
  // `src/config/dotenv.ts` aparece en la lista porque mira `process.env.NODE_ENV`, y lo que hace
  // con eso NO ES LEER CONFIGURACION: decide si el archivo `.env` se carga, antes de que exista
  // configuracion alguna. Ninguna variable del servicio sale de ahi — no devuelve valores, devuelve
  // void.
  //
  // La lista es EXACTA a proposito, y por eso la excepcion se declara por nombre en vez de con un
  // `startsWith(CONFIG_DIR)` que dejaria entrar cualquier archivo futuro de `src/config/`: un
  // tercer lector tiene que romper este caso y obligar a justificarse, que es todo el valor del
  // test. Si agregas uno, la pregunta no es como hacer pasar el caso: es por que ese archivo lee el
  // entorno en vez de recibirlo por parametro.
  it('reads process.env in exactly two files: config/env.ts and the dotenv guard', () => {
    const readers = FILES.filter((file) => file.code.includes('process.env')).map((f) => f.relativePath);

    expect(readers.sort()).toEqual([`${CONFIG_DIR}dotenv.ts`, `${CONFIG_DIR}env.ts`]);
  });

  // TS-10 (S-024). Las cuatro claves del KV son INDEPENDIENTES entre si: ninguna es cross-field, a
  // diferencia de TICKET_MAP/TICKET_MAP_FILE, asi que ninguna toca `src/config/env.ts` ni la regla
  // de `createFinalSchema`.
  //
  // Esto NO es un detalle de implementacion, y por eso hay un test: cuando S-025 elimine las dos
  // fuentes del Mapa de Tickets y su regla cross-field, va a ser tentador "unificar" estas cuatro
  // con lo que quede ahi. No hay nada que unificar — son cuatro valores sueltos sin ninguna
  // relacion entre si, y meterlos en la regla cross-field crearia un acoplamiento inventado.
  it('keeps the four KV keys out of the cross-field rule in config/env.ts', () => {
    const env = FILES.find((file) => file.relativePath === `${CONFIG_DIR}env.ts`);
    expect(env).toBeDefined();

    for (const key of [
      'KV_TICKETS_BUCKET',
      'KV_THREADS_BUCKET',
      'KV_THREADS_TTL_DAYS',
      'KV_WATCH_RETRY_MS',
    ]) {
      expect(env?.code, `${key} no debe aparecer en env.ts`).not.toContain(key);
    }

    // Y la sanidad del caso: la UNICA regla cross-field sigue siendo la del Mapa de Tickets. Sin
    // esta linea, el test pasaria igual si alguien vaciara `createFinalSchema` por completo.
    expect(env?.code).toContain('ticketMapSourceIssues');
  });

  // El complemento del caso de arriba, y lo que le da su sentido: el guard mira DOS variables, y
  // las dos son interruptores de si el archivo `.env` se carga — ninguna es configuracion del
  // servicio. Sin esta asercion, el caso anterior autorizaria a `dotenv.ts` a leer cualquier cosa
  // del entorno con solo estar en la lista, que es exactamente la puerta que CA-1 cierra.
  //
  // La lista es exacta: agregar un tercer interruptor rompe este caso a proposito. Y la pregunta
  // que hay que responder antes de actualizarlo es por que hacen falta tres condiciones para
  // decidir si se lee un archivo.
  it('lets the dotenv guard read only the two load switches', () => {
    const guard = FILES.find((file) => file.relativePath === `${CONFIG_DIR}dotenv.ts`);

    expect(guard).toBeDefined();

    const reads = [...(guard?.code.matchAll(/process\.env(?:\.(\w+)|\['(\w+)'\]|\["(\w+)"\])/g) ?? [])]
      .map((match) => match[1] ?? match[2] ?? match[3]);

    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)].sort()).toEqual(['DOTENV_DISABLED', 'NODE_ENV']);
  });

  it('mentions the SDK loadConfig only under src/config/', () => {
    const callers = FILES.filter((file) => file.code.includes('loadConfig')).map((f) => f.relativePath);

    expect(callers.length).toBeGreaterThan(0);
    for (const path of callers) {
      expect(path.startsWith(CONFIG_DIR)).toBe(true);
    }
  });

  it('imports @t3-oss/env-core only under src/config/', () => {
    const importers = FILES.filter((file) => file.code.includes('@t3-oss/env-core')).map(
      (f) => f.relativePath,
    );

    for (const path of importers) {
      expect(path.startsWith(CONFIG_DIR)).toBe(true);
    }
  });

  it('hardcodes no SDK default outside src/config/', () => {
    // Los tres valores que el SDK ya conoce o que el schema resuelve. Copiarlos a otro modulo es
    // exactamente lo que CA-7 prohibe: dos fuentes de verdad que se desincronizan en silencio.
    for (const literal of ['15000', '15_000', "'dev'", "'nats://localhost:4222'"]) {
      const offenders = FILES.filter(outsideConfig)
        .filter((file) => file.code.includes(literal))
        .map((f) => f.relativePath);

      expect(offenders, `literal ${literal} leaked outside src/config/`).toEqual([]);
    }
  });
});

describe('src/config/schema.ts', () => {
  const schema = FILES.find((file) => file.relativePath === `${CONFIG_DIR}schema.ts`);

  it('infers its type from the schema instead of declaring it by hand', () => {
    expect(schema).toBeDefined();
    // `envSchema` es un objeto plano de shapes (lo que createEnv espera), no un ZodObject, asi que
    // la inferencia lo envuelve: z.infer<z.ZodObject<typeof envSchema>>. Lo que CA-9 exige es que el
    // tipo salga del schema, no una grafia exacta.
    expect(schema?.code).toMatch(/z\.infer<.*typeof envSchema.*>/);
  });

  it('declares no interface or type alias that redeclares the schema fields', () => {
    // Un `interface Env { JIKU_CREDS: string; ... }` en paralelo al schema es la duplicacion que
    // CA-9 prohibe: el tipo y la validacion se desincronizan sin que nada falle.
    expect(schema?.code).not.toMatch(/interface\s+Env\b/);
    expect(schema?.code).not.toMatch(/type\s+Env\s*=\s*\{/);
  });
});

/**
 * CA-12 (S-007). El bloque `imap` de `AppConfig` dejo a `config.imap.password` a TRES niveles si
 * alguien loguea el AppConfig entero dentro de un contexto, y `redact.paths` de Pino no tiene
 * comodin profundo (ver src/shared/log-redaction.ts): a esa profundidad el secreto saldria EN
 * CLARO, sin fallar y sin avisar.
 *
 * La defensa NO es ampliar REDACT_PATHS —seria interminable y quedaria siempre un nivel atras— sino
 * la regla estructural que este escaner afirma: ningun punto de log emite el AppConfig completo.
 * Cada contexto enumera campos a mano.
 */
describe('log call sites', () => {
  const LOG_CALL = /(?:logger|getLogger\(\))\s*\.\s*(?:trace|debug|info|warn|error|fatal|child)\s*\(/g;

  interface LogCall {
    readonly relativePath: string;
    /** El primer argumento de la llamada: el objeto de contexto. */
    readonly context: string;
  }

  /** Extrae el primer argumento de cada llamada de log, balanceando parentesis. */
  function logCalls(file: SourceFile): LogCall[] {
    const found: LogCall[] = [];

    for (const match of file.code.matchAll(LOG_CALL)) {
      let depth = 1;
      let index = match.index + match[0].length;
      const start = index;

      while (index < file.code.length && depth > 0) {
        const char = file.code[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        // La coma de tope nivel separa el contexto del mensaje.
        else if (char === ',' && depth === 1) break;
        index += 1;
      }

      found.push({ relativePath: file.relativePath, context: file.code.slice(start, index) });
    }

    return found;
  }

  const CALLS: LogCall[] = FILES.flatMap(logCalls);

  it('finds the log calls it is meant to scan', () => {
    // Si el escaner devolviera vacio, el test de abajo pasaria sin verificar nada.
    expect(CALLS.length).toBeGreaterThan(3);
    expect(CALLS.map((call) => call.relativePath)).toContain('startup.ts');
  });

  // TS-32
  it('never passes the whole AppConfig as a log context', () => {
    for (const call of CALLS) {
      const where = `${call.relativePath}: ${call.context.trim().slice(0, 60)}`;

      expect(call.context, where).not.toMatch(/\bconfig\b(?!\.)/);
      expect(call.context, where).not.toMatch(/\bappConfig\b(?!\.)/);
      expect(call.context, where).not.toMatch(/\bAppConfig\b/);
      expect(call.context, where).not.toMatch(/\.{3}\s*(?:config|appConfig)\b/);
    }
  });

  // La linea de arranque enumera campos a mano y sigue sin llevar ninguno de los siete valores
  // nuevos: ni el host, ni el usuario, y menos el password.
  it('keeps the startup line enumerating fields by hand, with no IMAP or poll value', () => {
    const startupCalls = CALLS.filter((call) => call.relativePath === 'startup.ts');

    expect(startupCalls.length).toBeGreaterThan(0);
    for (const call of startupCalls) {
      expect(call.context).not.toMatch(/imap|poll|password/i);
    }
  });
});

/**
 * CA-14 (S-012). El bloque `ruteo` entra bajo la misma regla estructural que el resto de
 * `AppConfig` —ningun punto de log lo emite completo— y agrega una razon propia: el `ticketMap` es
 * la topologia comercial del despliegue, los `projectId` de todos los clientes habilitados.
 *
 * El escaner de arriba ya cubre el caso principal SIN CAMBIOS, porque afirma sobre `\bconfig\b` y
 * `\bAppConfig\b`: cualquier log del objeto entero lo rompe, lleve el bloque `ruteo` o no. Lo que
 * agrega este describe es defensa en profundidad para el caso que aquel no atraparia — que alguien
 * loguee el bloque SOLO, o el mapa solo.
 */
describe('routing block log safety', () => {
  const LOG_CALL = /(?:logger|getLogger\(\))\s*\.\s*(?:trace|debug|info|warn|error|fatal|child)\s*\(/g;

  function logContexts(file: SourceFile): string[] {
    const found: string[] = [];

    for (const match of file.code.matchAll(LOG_CALL)) {
      let depth = 1;
      let index = match.index + match[0].length;
      const start = index;

      while (index < file.code.length && depth > 0) {
        const char = file.code[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (char === ',' && depth === 1) break;
        index += 1;
      }

      found.push(file.code.slice(start, index));
    }

    return found;
  }

  // TS-40
  it('never passes the routing block or the ticket map as a log context', () => {
    for (const file of FILES) {
      for (const context of logContexts(file)) {
        const where = `${file.relativePath}: ${context.trim().slice(0, 60)}`;

        expect(context, where).not.toMatch(/\bruteo\b/);
        expect(context, where).not.toMatch(/\bticketMap\b/);
        expect(context, where).not.toMatch(/\bTICKET_MAP\b/);
      }
    }
  });

  // TS-38. Ni siquiera con las cinco variables nuevas: si la implementacion necesitara leer el
  // entorno en otro lado, la implementacion esta mal, no el test (CA-12 lo dice explicitamente).
  it('keeps the schema module free of process.env, with the five new variables in it', () => {
    const schema = FILES.find((file) => file.relativePath === `${CONFIG_DIR}schema.ts`);

    expect(schema).toBeDefined();
    expect(schema?.code).not.toMatch(/process\.env/);
    // Y las cinco estan efectivamente ahi: sin esto el caso pasaria en verde sobre un schema que no
    // declara nada.
    for (const name of [
      'TICKET_MAP',
      'TICKET_MAP_FILE',
      'SUBADDRESS_PREFIX',
      'PLACEHOLDER_TITLE',
      'PLACEHOLDER_BODY',
    ]) {
      expect(schema?.code, name).toContain(name);
    }
  });

  // TS-43. La story no agrega ninguna dependencia: JSON.parse, el Zod ya instalado y node:fs. Un
  // parser propio o una libreria de YAML seria exactamente lo que el diseno descarto.
  it('adds no dependency to the project', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@gravadigital/jiku',
      '@t3-oss/env-core',
      'dotenv',
      'html-to-text',
      'imapflow',
      'mailparser',
      'node-cron',
      'pino',
      'zod',
    ]);
    for (const forbidden of ['yaml', 'js-yaml', 'json5', 'lodash']) {
      expect(Object.keys(pkg.dependencies), forbidden).not.toContain(forbidden);
      expect(Object.keys(pkg.devDependencies), forbidden).not.toContain(forbidden);
    }
  });
});
