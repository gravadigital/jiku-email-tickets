import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * S-016 Tarea 2 — TS-6 (CA-9): el pico de memoria del tick es de UN MAIL A LA VEZ, nunca del lote
 * entero. Un test de comportamiento no puede afirmar la ausencia de un array acumulador -- solo
 * puede probar los caminos que ejercita -- asi que esta propiedad se verifica por INSPECCION DE
 * CODIGO, en el mismo estilo que `test/publicacion/source-properties.test.ts`.
 *
 * ADR-001 exige procesamiento secuencial (un mail a la vez, sin Promise.all/allSettled sobre
 * mails). CA-9 de S-016 es la consecuencia directa de esa regla, y la propiedad que FG-4 tiene que
 * preservar deliberadamente cuando agregue los Buffer de los adjuntos.
 */

const TICK_SOURCE_PATH = fileURLToPath(new URL('../../src/domain/ingesta/tick.ts', import.meta.url));

/**
 * Quita comentarios de linea y de bloque antes de buscar, mismo criterio que
 * `source-properties.test.ts`: `tick.ts` comenta densamente sus decisiones, y varios comentarios
 * mencionan "array" o "acumula" precisamente para explicar que NO se hace -- escanear el codigo
 * comentado haria que esos mismos comentarios correctos rompieran el test que los cita.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('src/domain/ingesta/tick.ts memory properties (S-016 CA-9)', () => {
  const rawSource = readFileSync(TICK_SOURCE_PATH, 'utf8');
  const code = stripComments(rawSource);

  it('sanity: el archivo se pudo leer y tiene contenido real', () => {
    // Sin esto, un path roto haria pasar los tests de abajo con un string vacio, sin verificar nada.
    expect(rawSource.length).toBeGreaterThan(500);
    expect(code).toContain('export async function runTick');
    expect(code).toContain('routeMail(');
    expect(code).toContain('publishRequirementFromMail(');
  });

  it('no declara ningun array para acumular mails o resultados de ruteo', () => {
    // Los nombres que un array acumulador tomaria naturalmente en este archivo. Ninguno de estos
    // patrones de DECLARACION debe aparecer en el codigo (sin comentarios).
    const arrayDeclarationPatterns = [
      /const\s+\w*routed\w*\s*[:=]/i,
      /const\s+\w*results?\w*\s*:\s*\w+\[\]/i,
      /const\s+\w+\s*:\s*RouteResult\[\]/,
      /const\s+\w+\s*:\s*IncomingMail\[\]/,
      /let\s+\w*routed\w*\s*[:=]/i,
    ];

    for (const pattern of arrayDeclarationPatterns) {
      expect(code, `tick.ts must not declare an accumulator matching ${String(pattern)}`).not.toMatch(
        pattern,
      );
    }
  });

  it('no llama a .push() en ningun lado del archivo', () => {
    // `.push()` es la forma en la que un array acumulador crecería. Su ausencia total es la
    // afirmacion mas directa de que no existe un array que junte mails o resultados de ruteo antes
    // de publicar -- ninguna otra estructura de este archivo necesita `.push()` tampoco.
    expect(code).not.toMatch(/\.push\s*\(/);
  });

  it('routeMail() y publishRequirementFromMail() se invocan dentro del mismo bloque del for, sin ningun array declarado entre las dos llamadas', () => {
    const routeIndex = code.indexOf('routeMail(');
    const publishIndex = code.indexOf('publishRequirementFromMail(');

    expect(routeIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(routeIndex);

    const between = code.slice(routeIndex, publishIndex);

    // Ninguna declaracion de array literal (`[]`) ni `new Array(` entre las dos llamadas.
    expect(between).not.toMatch(/=\s*\[\s*\]/);
    expect(between).not.toMatch(/new\s+Array\s*\(/);
    expect(between).not.toMatch(/\.push\s*\(/);
  });

  it('no usa Promise.all ni Promise.allSettled sobre el batch (ADR-001: procesamiento secuencial)', () => {
    expect(code).not.toMatch(/Promise\.all\s*\(/);
    expect(code).not.toMatch(/Promise\.allSettled\s*\(/);
  });

  it('el for del batch usa un uid a la vez, con await dentro del cuerpo (secuencial, no map+Promise.all)', () => {
    // El patron secuencial correcto: un `for (const uid of batch)` con `await` adentro. Un
    // `batch.map(async (uid) => ...)` seguido de `Promise.all` dispararia todas las descargas y
    // publicaciones en paralelo, rompiendo la propiedad de un mail a la vez.
    expect(code).toMatch(/for\s*\(\s*const\s+uid\s+of\s+batch\s*\)/);
    expect(code).not.toMatch(/batch\s*\.\s*map\s*\(/);
  });
});
