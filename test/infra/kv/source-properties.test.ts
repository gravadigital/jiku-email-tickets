import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * TS-34 a TS-36: las propiedades del KV de la forma "no existe ningun camino de codigo que X".
 *
 * Un test de comportamiento no puede afirmar eso —solo puede probar los caminos que ejercita— asi
 * que se escanea `src/` con los comentarios stripeados. Mismo patron, y misma sanidad del scanner,
 * que `test/bus/source-properties.test.ts`.
 *
 * Las tres propiedades de aca son las que sostienen decisiones que se pueden romper por accidente
 * en un refactor bienintencionado:
 *
 * - El KV va sobre la conexion UNICA (ADR-002), no sobre una nueva.
 * - El conector NUNCA crea un bucket. Crearlo ante un typo dejaria un bucket vacio y el sintoma
 *   seria un conector que descarta todo en silencio.
 * - El conector NUNCA fija el TTL. Lo compara y avisa; fijarlo exigiria permisos de escritura de
 *   streams que la decision de no crear buckets existe para evitar.
 */

const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url));
const KV_STORES = `infra${sep}kv${sep}stores.ts`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Quita comentarios antes de buscar.
 *
 * Imprescindible aca: los comentarios del modulo del KV mencionan `create()`, `ttl:` y
 * `jetstreamManager()` justamente para explicar por que NO se usan. Sin stripear, cada explicacion
 * haria fallar su propio test.
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

const KV_FILES = FILES.filter((file) => file.relativePath.startsWith(`infra${sep}kv${sep}`));

describe('src/ kv source properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Sin esta sanidad, un scanner roto pasaria todos los tests de abajo sin verificar nada.
    expect(FILES.length).toBeGreaterThan(3);
    expect(FILES.map((file) => file.relativePath)).toContain(KV_STORES);
    expect(KV_FILES.length).toBeGreaterThan(1);
  });

  // TS-34
  it('el modulo del KV no abre ninguna conexion propia', () => {
    for (const file of KV_FILES) {
      // Ni el `connect` del SDK...
      expect(
        /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*'@gravadigital\/jiku'/.test(file.code),
        `${file.relativePath} importa connect del SDK`,
      ).toBe(false);
      // ...ni nada de `nats` o `@nats-io/*` directo, que traeria una segunda copia de nats-core.
      expect(/from\s*'nats'/.test(file.code), `${file.relativePath} importa 'nats'`).toBe(false);
      expect(
        /from\s*'@nats-io\//.test(file.code),
        `${file.relativePath} importa @nats-io/* directo en vez del subpath del SDK`,
      ).toBe(false);
    }
  });

  it('el unico import del bus en el modulo del KV es el subpath del SDK', () => {
    const stores = KV_FILES.find((file) => file.relativePath === KV_STORES);
    expect(stores).toBeDefined();
    // `Kvm` entra por el subpath, que es lo que garantiza una sola copia de nats-core (S-023).
    expect(stores?.code).toMatch(/from\s*'@gravadigital\/jiku\/nats'/);
  });

  // TS-35
  it('no existe NINGUNA llamada a create() de KV en src/', () => {
    for (const file of FILES) {
      expect(
        /\bkvm\s*\.\s*create\s*\(/.test(file.code),
        `${file.relativePath} llama a kvm.create(): el conector no crea buckets`,
      ).toBe(false);
      expect(
        /\.\s*create\s*\(\s*config\.kv\./.test(file.code),
        `${file.relativePath} crea un bucket desde la configuracion`,
      ).toBe(false);
    }
  });

  // TS-36
  it('no existe ningun intento de fijar o actualizar el TTL', () => {
    for (const file of KV_FILES) {
      expect(
        /ttl\s*:/.test(file.code),
        `${file.relativePath} pasa un ttl en un objeto de opciones: el conector no fija el TTL`,
      ).toBe(false);
      expect(
        /streams\s*\.\s*(add|update)\s*\(/.test(file.code),
        `${file.relativePath} escribe la configuracion de un stream`,
      ).toBe(false);
      expect(
        /jetstreamManager\s*\(/.test(file.code),
        `${file.relativePath} usa el jetstreamManager, que permite modificar streams`,
      ).toBe(false);
    }
  });

  it('el status() de verificacion sigue estando', () => {
    // El contrapeso de los tests de arriba: prohibir cosas no alcanza si tambien desaparece la
    // verificacion. `open()` NO falla si el bucket no existe (Hallazgo 1), asi que sin el
    // `status()` el conector arrancaria contra un despliegue sin buckets y descartaria todo en
    // silencio. Si alguien lo borra por "redundante", este test lo detiene.
    const stores = KV_FILES.find((file) => file.relativePath === KV_STORES);
    expect(stores?.code).toMatch(/\.\s*status\s*\(\s*\)/);
  });
});
