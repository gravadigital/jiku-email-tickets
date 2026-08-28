import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * El walker de `src/` y el limpiador de comentarios, compartidos.
 *
 * Varios `*.test.ts` afirman propiedades del codigo fuente por escaneo de texto (que `process.env`
 * se lea en un solo archivo, que ningun log emita el AppConfig entero). Cada uno traia su propia
 * copia del walker; S-007 extrajo esta version al agregar el escaner de puntos de log de CA-12 y
 * migro a `test/config/source-properties.test.ts`, que es donde vive ese escaner. Las otras copias
 * (bus/, publicacion/) se dejan donde estan: reescribirlas no es parte de esta story, y el helper
 * queda disponible para cuando se toquen.
 */

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

export interface SourceFile {
  readonly relativePath: string;
  /** El contenido del archivo YA sin comentarios. */
  readonly code: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Quita comentarios de linea y de bloque antes de buscar.
 *
 * Sin esto, un `// nunca leer process.env` o un `// el AppConfig entero no se loguea` haria fallar
 * al escaner — y el modulo de configuracion de este servicio comenta deliberadamente cada decision
 * contraintuitiva, justamente para que no se revierta.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Lee un archivo de `src/` por su ruta relativa y devuelve su codigo sin comentarios. */
export function readSource(relativePath: string): string {
  return stripComments(readFileSync(join(SRC_ROOT, relativePath), 'utf8'));
}

/** Todos los `.ts` de `src/`, con su codigo ya sin comentarios. */
export function sourceFiles(): SourceFile[] {
  return walk(SRC_ROOT).map((full) => ({
    relativePath: relative(SRC_ROOT, full),
    code: stripComments(readFileSync(full, 'utf8')),
  }));
}
