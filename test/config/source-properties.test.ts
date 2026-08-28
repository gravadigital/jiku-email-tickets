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

  it('reads process.env in exactly one file, src/config/env.ts', () => {
    const readers = FILES.filter((file) => file.code.includes('process.env')).map((f) => f.relativePath);

    expect(readers).toEqual([`${CONFIG_DIR}env.ts`]);
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
