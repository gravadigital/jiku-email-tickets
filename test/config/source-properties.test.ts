import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
const CONFIG_DIR = `config${sep}`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Quita comentarios de linea y de bloque antes de buscar.
 *
 * Sin esto, un `// nunca leer process.env` en un comentario haria fallar el test — y el codigo de
 * esta story comenta deliberadamente por que existe el punto de lectura unico.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface SourceFile {
  readonly relativePath: string;
  readonly code: string;
}

const FILES: SourceFile[] = sourceFiles(SRC_ROOT).map((full) => ({
  relativePath: relative(SRC_ROOT, full),
  code: stripComments(readFileSync(full, 'utf8')),
}));

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
