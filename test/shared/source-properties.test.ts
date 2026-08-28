import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

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

/**
 * TS-17: la unica forma de mecanizar CA-6.
 *
 * `redact` opera sobre el objeto de contexto DURANTE la serializacion y por lo tanto NO PUEDE
 * alcanzar un secreto interpolado dentro del string del mensaje. REQ-001 registra ese hueco en
 * §Riesgos y ADR-006 lo repite: la mitigacion declarada es la regla mas code review, sin guard
 * tecnico. Este test es lo mas cerca de un guard que se puede llegar.
 *
 * LIMITACION, explicita para quien lo lea despues: es un regex sobre el texto, NO un parser. Alcanza
 * para el tamano actual del servicio y detecta las dos formas que importan (template literal y
 * concatenacion con `+`). Un caso suficientemente retorcido se le escapa. Vale mas un test
 * imperfecto que se ejecuta que una regla que solo vive en un ADR.
 */
describe('logger call sites in src/', () => {
  const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

  /** Las llamadas al logger encontradas, con el texto de sus argumentos. */
  function loggerCalls(code: string): string[] {
    const calls: string[] = [];
    for (const level of LEVELS) {
      // Captura desde `<receptor>.<nivel>(` hasta el cierre del parentesis de la llamada. El
      // `[^;]*?` se detiene en el `;` para no cruzar el limite de la sentencia.
      //
      // El receptor es CUALQUIER identificador, no solo uno que se llame `logger`: el logger
      // degradado de `createLogger` se llama `degraded`, y una version anterior de este regex —que
      // exigia `logger` en el nombre— no lo veia. Ese falso negativo es justamente lo que el test
      // de auto-verificacion de abajo detecto. Un guard que solo mira las llamadas con el nombre
      // esperado no es un guard.
      const pattern = new RegExp(String.raw`\b[\w.]+\.${level}\(([^;]*?)\)\s*;`, 'gs');
      for (const match of code.matchAll(pattern)) {
        const args = match[1];
        if (args !== undefined) calls.push(args);
      }
    }
    return calls;
  }

  it('finds the logger calls it is meant to scan', () => {
    // Si el scanner devolviera vacio, el test de abajo pasaria sin verificar nada. El arranque tiene
    // al menos una llamada (la linea de configuracion valida) y el logger tiene la de degradacion.
    const total = FILES.flatMap((file) => loggerCalls(file.code));

    expect(total.length).toBeGreaterThanOrEqual(2);
  });

  it('never interpolates data into the message text', () => {
    // La forma obligatoria es `logger.info({ context }, 'mensaje estatico')`: objeto de contexto
    // primero, cadena FIJA segundo. Asi las lineas son agrupables por mensaje y consultables por
    // campo — un mensaje variable rompe las dos cosas a la vez.
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const args of loggerCalls(file.code)) {
        // El mensaje es el ultimo argumento de la llamada. Se busca un template literal con
        // interpolacion (`${...}`) o una concatenacion, en la posicion del mensaje.
        const hasInterpolation = /`[^`]*\$\{/.test(args);
        // Una concatenacion en el mensaje: una comilla seguida de un `+`, o un `+` seguido de una
        // comilla. El `+` dentro del objeto de contexto no cuenta como mensaje interpolado, pero
        // como el regex no parsea, se acepta el falso positivo: la forma correcta nunca lo produce.
        const hasConcatenation = /['"`]\s*\+|\+\s*['"`]/.test(args);

        if (hasInterpolation || hasConcatenation) {
          offenders.push(`${file.relativePath}: ${args.trim().slice(0, 120)}`);
        }
      }
    }

    expect(offenders, `logger calls interpolating data into the message:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('passes a context object as the first argument of every logger call', () => {
    // La otra mitad de CA-6: sin objeto de contexto no hay campos consultables, y el dato termina
    // — si termina en algun lado — dentro del texto.
    //
    // El contexto puede llegar de dos formas y las dos cumplen la convencion: un literal inline
    // (`{ projectId }`) o una llamada que DEVUELVE el objeto (`error.logContext(projectId)`, que
    // S-005 usa para que la forma del contexto de un fallo de publicacion viva junto al error y no
    // se copie en cada punto de log). Lo que la convencion prohibe es pasar un STRING primero, que
    // es lo que deja el dato dentro del texto en vez de en un campo.
    //
    // De ahi que se rechace por lo que NO puede ser, en vez de exigir que empiece con `{`: exigir
    // el literal haria fallar la forma correcta junto con la incorrecta, y el "arreglo" seria
    // inlinear un objeto que a proposito esta centralizado.
    const offenders: string[] = [];
    const looksLikeAString = /^['"`]/;

    for (const file of FILES) {
      for (const args of loggerCalls(file.code)) {
        const trimmed = args.trim();
        if (looksLikeAString.test(trimmed)) {
          offenders.push(`${file.relativePath}: ${trimmed.slice(0, 120)}`);
        }
      }
    }

    expect(offenders, `logger calls without a context object:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('never interpolates a variable into the log message itself', () => {
    // La regla que el test de arriba dejaria de cubrir al aceptar una llamada como contexto: el
    // MENSAJE tiene que ser estatico. Un mensaje interpolado hace que las lineas no se puedan
    // agrupar y mete el dato en el texto en vez de en un campo consultable.
    for (const file of FILES) {
      for (const args of loggerCalls(file.code)) {
        // El mensaje es el ultimo argumento. Se busca un template literal con `${` en la lista.
        expect(
          args,
          `${file.relativePath} must keep the log message static`,
        ).not.toMatch(/`[^`]*\$\{[^`]*`\s*\)?\s*$/);
      }
    }
  });
});
