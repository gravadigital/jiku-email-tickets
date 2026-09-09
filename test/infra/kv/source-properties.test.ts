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
 *
 * S-026 agrega TS-33 a TS-35 y TS-37, todas sobre el Mapa de Hilos y todas de la misma forma:
 *
 * - No hay `watch()` sobre el bucket de hilos. La "optimizacion" obvia seria cachearlo como el de
 *   tickets, y seria un mapa de alto cardinal creciendo sin techo y desactualizado.
 * - No hay copia en memoria del Mapa de Hilos: el corolario del anterior.
 * - El modulo de hilos no importa `nats` ni `@nats-io/*`, igual que el resto del modulo del KV.
 * - El KV de hilos NO se usa para deduplicar mails: el `\Seen` sigue siendo la unica marca de
 *   idempotencia (ADR-001, CA-14), y usar el bucket para eso seria tomar una decision que REQ-005
 *   explicitamente no tomo.
 */

const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url));
const KV_STORES = `infra${sep}kv${sep}stores.ts`;
const KV_THREADS = `infra${sep}kv${sep}threads.ts`;
const TICK = `domain${sep}ingesta${sep}tick.ts`;

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
    const paths = FILES.map((file) => file.relativePath);
    expect(paths).toContain(KV_STORES);
    // S-026: el archivo nuevo cae dentro del alcance del escaner, y de TS-36 en particular.
    expect(paths).toContain(KV_THREADS);
    expect(paths).toContain(TICK);
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

  // TS-33 (S-026)
  it('TS-33: no existe ningun watch() sobre el bucket de hilos', () => {
    const threads = KV_FILES.find((file) => file.relativePath === KV_THREADS);
    expect(threads).toBeDefined();
    // El modulo de hilos no menciona `watch(` en NINGUNA forma: es `get()` puntual, a proposito.
    expect(
      /watch\s*\(/.test(threads?.code ?? ''),
      'threads.ts usa watch(): el Mapa de Hilos se lee con get() puntual (CA-12)',
    ).toBe(false);

    // Y nadie en `src/` le hace `watch()` al handle de hilos por otro camino.
    for (const file of FILES) {
      expect(
        /\bthreads\s*\.\s*watch\s*\(/.test(file.code),
        `${file.relativePath} hace watch() sobre el bucket de hilos`,
      ).toBe(false);
      expect(
        /kv\s*\.\s*threads\s*\.\s*watch\s*\(/.test(file.code),
        `${file.relativePath} hace watch() sobre kv.threads`,
      ).toBe(false);
    }
  });

  // TS-34 (S-026)
  it('TS-34: no existe ninguna copia en memoria del Mapa de Hilos', () => {
    const threads = KV_FILES.find((file) => file.relativePath === KV_THREADS);
    const code = threads?.code ?? '';

    // El `[^(]*` cubre el parametro de tipo: `new Map<string, number>()` no matchearia un
    // `new\s+Map\s*\(` a secas, y el escaner pasaria en verde con la copia en memoria puesta.
    // Verificado rompiendolo a proposito.
    expect(
      /new\s+Map[^(]*\(/.test(code),
      'threads.ts declara un Map: seria la copia en memoria',
    ).toBe(false);
    expect(/new\s+Set[^(]*\(/.test(code), 'threads.ts declara un Set').toBe(false);
    expect(
      /^\s*(?:const|let|var)\s+\w+\s*:\s*Record</m.test(code),
      'threads.ts declara un Record de modulo que acumularia entradas',
    ).toBe(false);
    // El unico estado del modulo es el handle que llega por parametro: no hay ningun `let` de
    // modulo. (Los `let` de dentro de una funcion van indentados; uno de modulo arranca en columna 0.)
    expect(/^let\s/m.test(code), 'threads.ts declara un let de modulo').toBe(false);
  });

  // TS-35 (S-026)
  it('TS-35: el modulo de hilos no importa nats directo; su unico import del bus es el subpath', () => {
    const threads = KV_FILES.find((file) => file.relativePath === KV_THREADS);
    const code = threads?.code ?? '';

    expect(/from\s*'nats'/.test(code)).toBe(false);
    expect(/from\s*'@nats-io\//.test(code)).toBe(false);
    expect(code).toMatch(/from\s*'@gravadigital\/jiku\/nats'/);
    // Y no construye ningun `Kvm`: el handle llega abierto.
    expect(/new\s+Kvm\s*\(/.test(code), 'threads.ts construye un Kvm propio').toBe(false);
  });

  // TS-37 (S-026)
  it('TS-37: el KV de hilos no se usa para deduplicar mails — el \\Seen sigue siendo la unica marca', () => {
    const tick = FILES.find((file) => file.relativePath === TICK);
    const code = tick?.code ?? '';

    // El `markSeen(uid)` sigue INMEDIATAMENTE despues del `fetch`, antes del `normalize`: ninguna
    // de las dos operaciones del hilo lo mueve ni lo condiciona.
    const fetchIdx = code.indexOf('mailSource.fetch(uid)');
    const markSeenIdx = code.indexOf('mailSource.markSeen(uid)');
    const normalizeIdx = code.indexOf('await normalize(');
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(markSeenIdx).toBeGreaterThan(fetchIdx);
    expect(normalizeIdx).toBeGreaterThan(markSeenIdx);

    // Y las dos operaciones del hilo ocurren DESPUES del markSeen: ninguna puede saltear un mail.
    const lookupIdx = code.indexOf('lookupThread(');
    const recordIdx = code.indexOf('recordThreadEntry(');
    expect(lookupIdx).toBeGreaterThan(markSeenIdx);
    expect(recordIdx).toBeGreaterThan(markSeenIdx);

    // No hay ninguna rama que saltee (`continue`/`return`) un mail en funcion de una consulta al
    // bucket de hilos: el resultado del lookup solo alimenta la variable del motivo.
    expect(
      /lookupThread\([\s\S]{0,400}?\bcontinue\b/.test(code),
      'el tick saltea un mail en funcion del Mapa de Hilos: eso seria usarlo para idempotencia',
    ).toBe(false);
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
