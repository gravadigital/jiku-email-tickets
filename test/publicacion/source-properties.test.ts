import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * TS-30, TS-31 y TS-32: las propiedades de la forma "no existe NINGUN camino de codigo que X".
 *
 * Un test de comportamiento no puede afirmar eso —solo puede probar los caminos que ejercita— asi
 * que se escanea `src/`. El patron es el de `test/bus/source-properties.test.ts` de S-004, incluido
 * su test de sanidad del scanner: sin el, un scanner que devuelve vacio hace pasar todos los tests
 * de abajo sin verificar nada.
 *
 * SE ESCANEA `src/` Y NO `test/`, y es deliberado: este mismo archivo contiene los strings
 * prohibidos (tiene que nombrarlos para buscarlos), asi que escanear `test/` seria un falso
 * positivo garantizado. Los tests de S-004 ya resolvieron esto igual.
 */

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
const PUBLICACION = `domain${sep}publicacion${sep}`;
const PUBLISH_REQUIREMENT = `${PUBLICACION}publish-requirement.ts`;
const UPLOAD_FILE = `${PUBLICACION}upload-file.ts`;
const UPLOAD_BYTE = `${PUBLICACION}upload-byte.ts`;

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
 * El criterio esta comentado a proposito, porque es la clase de detalle que el proximo lector
 * "arregla" en la direccion equivocada: el codigo de este servicio comenta densamente los "por que"
 * verificados, y varios de esos comentarios mencionan `jiku-queries`, `inboxPrefix` o
 * `client.command()` PARA EXPLICAR POR QUE NO SE USAN. Un comentario correcto no debe hacer fallar
 * su propio test. Se escanea CODIGO, no prosa.
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

const PUBLICACION_FILES = FILES.filter((file) => file.relativePath.startsWith(PUBLICACION));

describe('src/ publication source properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Sanidad del scanner: sin esto, un scanner roto pasaria todos los tests de abajo en verde.
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES.map((f) => f.relativePath)).toContain(PUBLISH_REQUIREMENT);
    expect(PUBLICACION_FILES.length).toBeGreaterThanOrEqual(4);
  });

  // TS-30
  it('never publishes on the query plane', () => {
    // ADR-003: el conector MUST NOT publicar en `jiku-queries.*` ni suscribirse a subjects de otros
    // servicios. El plano de lectura no se usa NUNCA — ni siquiera para verificar la fila en
    // `users`, que es lo que hace que CA-16 sea un paso manual del operador y no codigo (G-03).
    for (const file of FILES) {
      for (const forbidden of ['client.query(', 'client.list(', 'client.get(', 'client.iterate(', 'jiku-queries']) {
        expect(
          file.code,
          `${file.relativePath} must not touch the query plane (${forbidden})`,
        ).not.toContain(forbidden);
      }
    }
  });

  it('publishes only the two commands ADR-003 allows', () => {
    // El nombre del comando vive en la constante `COMMAND` del publicador, no inline en la llamada:
    // por eso se buscan los NOMBRES DE COMANDO declarados en todo `src/` en vez del argumento
    // literal de `.command(`. Buscar solo el argumento daria vacio y el test pasaria sin verificar
    // nada — que es el falso negativo, no el falso positivo, y por eso importa mas.
    const declared = FILES.flatMap((file) =>
      [...file.code.matchAll(/['"`]([a-z-]+\.[a-z-]+)['"`]/g)]
        .map((match) => match[1] as string)
        // Solo los que parecen nombres de comando del bus: `{recurso}.{accion}`. Se excluyen los
        // especificadores de import y de archivo, que tienen la misma forma.
        .filter((candidate) => /^(requirements|files|users|projects|tasks|comments)\./.test(candidate)),
    );

    // Los DOS comandos que ADR-003 permite, y ninguno mas: `requirements.new` (S-005) y
    // `files.request-upload` (esta story). Orden no relevante.
    expect([...new Set(declared)].sort()).toEqual(['files.request-upload', 'requirements.new']);

    for (const command of declared) {
      expect(['requirements.new', 'files.request-upload']).toContain(command);
    }
  });

  // TS-31
  it('never builds a subject by hand', () => {
    // ADR-002: el subject se arma con `client.command()`, NUNCA con concatenacion de strings. Si el
    // conector lo reconstruyera y se equivocara, el mensaje iria a un subject que nadie escucha y la
    // request expiraria sin error visible.
    for (const file of FILES) {
      expect(file.code, `${file.relativePath} must not spell out a command subject`).not.toContain(
        'jiku-commands.v1',
      );
      expect(file.code, `${file.relativePath} must not name the inbox plane`).not.toContain(
        '_INBOX',
      );
    }
  });

  it('never sets the inbox prefix, which the SDK always fixes', () => {
    // El SDK lo fija siempre como `_INBOX.<hash(sub)>`. Cualquier otro prefijo —incluido el
    // aleatorio que genera todo cliente NATS por default— hace que la reply se publique donde nadie
    // escucha y la request expire SIN NINGUN ERROR VISIBLE.
    //
    // Lo prohibido es FIJARLO, no LEERLO: la linea de arranque de S-004 loguea
    // `inboxPrefix: client.inboxPrefix` a proposito, porque es el dato que diagnostica esa misma
    // trampa sin adivinar, y el SDK lo expone explicitamente *"for diagnostics"*. Prohibir el
    // nombre a secas haria fallar el uso correcto junto con el incorrecto — el mismo criterio que
    // ya usa `test/bus/source-properties.test.ts` para `userId`.
    for (const file of FILES) {
      const assignments = [...file.code.matchAll(/\binboxPrefix\s*:\s*([^,\n}]+)/g)].map(
        (match) => (match[1] as string).trim(),
      );

      for (const assigned of assignments) {
        expect(
          assigned,
          `${file.relativePath} may only read inboxPrefix off the client, never set one`,
        ).toBe('client.inboxPrefix');
      }
    }
  });

  it('invokes client.command in exactly two files', () => {
    const publishers = FILES.filter((file) => /\.command\s*\(/.test(file.code)).map(
      (f) => f.relativePath,
    );

    // DOS puntos de publicacion desde esta story: `publish-requirement.ts` (`requirements.new`) y
    // `upload-file.ts` (`files.request-upload`). Un tercero esta prohibido — es lo que hace que la
    // traduccion de errores y la linea de log no se puedan saltear: un archivo nuevo que publicara
    // sin pasar por ninguno de los dos lo haria sin el `try/catch` que esta suite ya protege.
    expect([...publishers].sort()).toEqual([PUBLISH_REQUIREMENT, UPLOAD_FILE].sort());
  });

  it('invokes client.command exactly once per function, with two arguments', () => {
    const publisher = FILES.find((file) => file.relativePath === PUBLISH_REQUIREMENT);
    expect(publisher).toBeDefined();

    const invocations = publisher?.code.match(/\.command\s*\(/g) ?? [];
    // DOS invocaciones en el archivo desde S-015: una por funcion hermana
    // (`publishVerificationRequirement` y `publishRequirementFromMail`), ninguna con `for`, `while`,
    // backoff ni retry. Cada llamada a CUALQUIERA de las dos funciones sigue publicando una sola vez.
    expect(invocations).toHaveLength(2);

    // DOS argumentos, no tres: el tercero (`options`) es donde se bajaria el timeout por accidente,
    // y ADR-006 lo prohibe explicitamente ("MUST NOT bajarse"). El `options` se usa SOLO desde los
    // tests. Un tercer argumento aca convertiria los errores explicados de PostgreSQL —que corta a
    // los 8 s— en timeouts mudos.
    expect(publisher?.code).toMatch(/\.command\(COMMAND,\s*payload\)/);
    expect(publisher?.code).not.toMatch(/\.command\([^)]*timeoutMs/);
  });

  it('invokes client.command exactly once in upload-file.ts, with two arguments', () => {
    // TS-3 de esta story: la misma propiedad que arriba, ahora sobre `upload-file.ts`.
    const publisher = FILES.find((file) => file.relativePath === UPLOAD_FILE);
    expect(publisher).toBeDefined();

    const invocations = publisher?.code.match(/\.command\s*\(/g) ?? [];
    expect(invocations).toHaveLength(1);

    expect(publisher?.code).toMatch(/\.command\(COMMAND,\s*payload\)/);
    expect(publisher?.code).not.toMatch(/\.command\([^)]*timeoutMs/);
  });

  it('never retries a failed publication', () => {
    // ADR-001, CA-14, NFR-R03: sin idempotencia y sin compensacion, un reintento crea dos requisitos
    // donde tenia que haber uno — y ninguno de los dos se puede borrar.
    //
    // La asercion es sobre el FLUJO DE CONTROL, con los string literals quitados ademas de los
    // comentarios. La razon es concreta: el remedio de `nada_respondio` dice en prosa "No se
    // reintenta", que es el texto correcto y es justamente lo que el operador necesita leer.
    // Prohibir la palabra haria fallar la explicacion junto con la conducta.
    const withoutStrings = (code: string): string =>
      code.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

    // `procesar-adjuntos-mail.ts` (S-021) SI itera -- es el orquestador que procesa, EN SERIE, los
    // adjuntos de un mail (CA-2: par por archivo, nunca Promise.all). Ese `for` no es un reintento
    // de UNA publicacion: es una sola invocacion de requestFileUpload()/uploadFileContent() POR
    // ADJUNTO, cada uno un archivo distinto -- muy distinto de reintentar la MISMA publicacion. Se
    // excluye de esta aserción, que sigue valiendo para el resto de `publicacion/` (ningun otro
    // archivo orquesta un bucle sobre publicaciones).
    const PROCESAR_ADJUNTOS_MAIL = `${PUBLICACION}procesar-adjuntos-mail.ts`;

    for (const file of PUBLICACION_FILES) {
      const flow = withoutStrings(file.code);

      expect(flow, `${file.relativePath} must not loop over a publication`).not.toMatch(
        /\b(retry|backoff|reintent)/i,
      );

      if (file.relativePath === PROCESAR_ADJUNTOS_MAIL) continue;

      expect(flow, `${file.relativePath} must not loop at all`).not.toMatch(
        /\b(for|while)\s*\(/,
      );
    }
  });

  // TS-32
  it('never discriminates an SDK error by the text of its message', () => {
    // ADR-002: "Los errores del bus MUST manejarse por las clases del SDK, no inspeccionando strings
    // de mensaje". El propio SDK lo refuerza para los codigos: su catalogo NO ES CERRADO, asi que
    // la discriminacion es por `instanceof` y por `isCode`, nunca por prosa.
    for (const file of PUBLICACION_FILES) {
      expect(
        file.code,
        `${file.relativePath} must not match against an error message`,
      ).not.toMatch(/\berror\.message\b|\bcause\.message\b/);
      expect(file.code, `${file.relativePath} must not regex a message`).not.toMatch(
        /message\s*\.\s*(includes|match|startsWith|indexOf)\s*\(/,
      );
    }
  });

  it('discriminates by instanceof and isCode instead', () => {
    // La contracara positiva del test anterior: sin esta asercion, borrar toda la discriminacion
    // haria pasar al de arriba.
    const translator = FILES.find(
      (file) => file.relativePath === `${PUBLICACION}publish-errors.ts`,
    );

    expect(translator).toBeDefined();
    expect(translator?.code).toMatch(/instanceof\s+Jiku/);
    expect(translator?.code).toMatch(/isCode\s*\(/);
    // Y los codigos salen de la constante del SDK, no de literales escritos a mano: un typo en un
    // literal produce un diagnostico silenciosamente equivocado.
    expect(translator?.code).toMatch(/ErrorCode\.\w+/);
    expect(translator?.code).not.toMatch(/['"`]caller_not_authorized['"`]/);
    expect(translator?.code).not.toMatch(/['"`]invalid_fields['"`]/);
  });

  it('upload-file.ts also discriminates by instanceof and isCode, never by message', () => {
    // `upload-file.ts` (esta story) agrega la UNICA rama nueva de esta suite: distingue el
    // `failure` de negocio (`file_type_not_allowed`/`file_too_large`) ANTES de
    // `diagnosePublishFailure()`, y tiene que hacerlo con el mismo criterio de ADR-002.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_FILE);

    expect(uploader).toBeDefined();
    expect(uploader?.code).toMatch(/instanceof\s+JikuFailure/);
    expect(uploader?.code).toMatch(/isCode\s*\(/);
    expect(uploader?.code).toMatch(/ErrorCode\.(FileTypeNotAllowed|FileTooLarge)/);
    expect(uploader?.code).not.toMatch(/['"`]file_type_not_allowed['"`]/);
    expect(uploader?.code).not.toMatch(/['"`]file_too_large['"`]/);
  });

  it('never switches exhaustively on an error code', () => {
    // El catalogo es de la instancia de Jiku y crece. El propio SDK lo dice: "Use isCode, never a
    // switch with a default that assumes it has seen everything".
    for (const file of PUBLICACION_FILES) {
      expect(file.code, `${file.relativePath} must not switch on a code`).not.toMatch(
        /switch\s*\([^)]*\bcode\b/,
      );
    }
  });

  it('calls hint() from exactly one place, guarded by the class that declares it', () => {
    // H1: `hint()` esta declarado SOLO en `JikuFailure`. Las otras cuatro clases extienden
    // `JikuError`, que no lo declara — llamarlo sobre ellas es un `TypeError`, y ocurriria en el
    // peor momento: cuando el conector ya esta fallando.
    //
    // Un solo punto de llamada es la propiedad que importa: un
    // `error instanceof JikuFailure ? error.hint() : undefined` repetido en dos lugares es la forma
    // de que el tercero se escriba SIN la guarda.
    const callers = FILES.filter((file) => /\.hint\s*\(\)/.test(file.code));

    expect(callers.map((f) => f.relativePath)).toEqual([`${PUBLICACION}publish-errors.ts`]);
    expect((callers[0]?.code.match(/\.hint\s*\(\)/g) ?? [])).toHaveLength(1);
    expect(callers[0]?.code).toMatch(/instanceof\s+JikuFailure\s*\?\s*\w+\.hint\(\)/);
  });

  it('never logs the payload, the title or the description', () => {
    // `REDACT_PATHS` cubre `text`, `content` y `body`, pero NO `title` ni `description`
    // (verificado). En esta story son literales del codigo y no habria filtracion; en FG-3 el
    // payload deriva del mail y si la habria. La regla se establece aca, cuando es gratis, para que
    // FG-3 la herede.
    for (const file of PUBLICACION_FILES) {
      expect(file.code, `${file.relativePath} must not log a payload key`).not.toMatch(
        /logger\.\w+\s*\(\s*\{[^}]*\bpayload\b/,
      );
      expect(file.code, `${file.relativePath} must not log the title`).not.toMatch(
        /logger\.\w+\s*\(\s*\{[^}]*\btitle\b/,
      );
      expect(file.code, `${file.relativePath} must not log the description`).not.toMatch(
        /logger\.\w+\s*\(\s*\{[^}]*\bdescription\b/,
      );
    }
  });

  it('reads no environment variable and uses no logger singleton in the publication domain', () => {
    // `src/config/env.ts` sigue siendo el UNICO lector del entorno del servicio, y el dominio
    // recibe todo por parametro: es lo que lo hace testeable sin tocar el singleton del proceso.
    for (const file of PUBLICACION_FILES) {
      expect(file.code, `${file.relativePath} must not read process.env`).not.toContain(
        'process.env',
      );
      expect(file.code, `${file.relativePath} must not use the logger singleton`).not.toMatch(
        /\bgetLogger\s*\(/,
      );
    }
  });

  it('sends none of the four excluded payload keys', () => {
    // Las cuatro exclusiones de CA-3, afirmadas sobre el CODIGO y no solo sobre el objeto que
    // devuelve la funcion: es lo que impide que alguien agregue una de ellas en otro camino.
    const payload = FILES.find(
      (file) => file.relativePath === `${PUBLICACION}verification-payload.ts`,
    );

    expect(payload).toBeDefined();
    for (const excluded of ['state', 'actor', 'fileIds', 'creator']) {
      expect(
        payload?.code,
        `the fixed payload must not carry ${excluded}`,
      ).not.toMatch(new RegExp(`\\b${excluded}\\s*:`));
    }
  });

  it('never logs the uploadUrl in upload-file.ts', () => {
    // TS-15 de esta story: la `uploadUrl` es una credencial de escritura de corta duracion
    // (RF-23, RF-39 de REQ-004) y NUNCA se loguea, en ningun resultado ni rama.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_FILE);

    expect(uploader).toBeDefined();
    expect(uploader?.code, `${UPLOAD_FILE} must not log uploadUrl`).not.toMatch(
      /logger\.\w+\s*\(\s*\{[^}]*\buploadUrl\b/,
    );
  });

  it('never logs the uploadUrl in upload-byte.ts (TS-19)', () => {
    // TS-19 de S-019: complementa el test en runtime de upload-byte.test.ts (TS-11). Mismo patron
    // dual que ya usa la suite para upload-file.ts: runtime + escaneo estatico.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_BYTE);

    expect(uploader).toBeDefined();
    expect(uploader?.code, `${UPLOAD_BYTE} must not log uploadUrl`).not.toMatch(
      /logger\.\w+\s*\(\s*\{[^}]*\buploadUrl\b/,
    );
  });

  it('never hardcodes the PUT timeout literal in upload-byte.ts (TS-18)', () => {
    // TS-18 de S-019: el timeout SIEMPRE llega por el parametro timeoutMs, nunca un literal
    // 30000/30_000 escrito en el archivo (fuera de comentario, que ya se elimino con
    // stripComments()). Mismo criterio verificado que prohibe el literal de MIN_TIMEOUT_MS fuera de
    // src/config/.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_BYTE);

    expect(uploader).toBeDefined();
    expect(uploader?.code, `${UPLOAD_BYTE} must not hardcode the timeout literal`).not.toMatch(
      /\b30[,_]?000\b/,
    );
  });

  it('upload-byte.ts never touches the bus (TS-13)', () => {
    // TS-13 de S-019: es la unica pieza de publicacion/ sin dependencia del bus -- no importa
    // Client del SDK, no llama client.command, no importa nada de #infra/bus/.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_BYTE);

    expect(uploader).toBeDefined();
    expect(uploader?.code, `${UPLOAD_BYTE} must not import Client from the SDK`).not.toMatch(
      /import\s*\{[^}]*\bClient\b[^}]*\}\s*from\s*['"]@gravadigital\/jiku['"]/,
    );
    expect(uploader?.code, `${UPLOAD_BYTE} must not call client.command`).not.toContain(
      'client.command',
    );
    expect(uploader?.code, `${UPLOAD_BYTE} must not import from #infra/bus/`).not.toMatch(
      /from\s*['"]#infra\/bus\//,
    );
  });

  it('never sends uploader or actor in the files.request-upload payload', () => {
    // ADR-005: el payload de `files.request-upload` no lleva NINGUN campo de identidad, ni
    // siquiera informativo — a diferencia de `requirements.new`, que si lleva `creator` opcional.
    const uploader = FILES.find((file) => file.relativePath === UPLOAD_FILE);

    expect(uploader).toBeDefined();
    for (const excluded of ['uploader', 'actor']) {
      expect(
        uploader?.code,
        `the files.request-upload payload must not carry ${excluded}`,
      ).not.toMatch(new RegExp(`\\b${excluded}\\s*:`));
    }
  });

  it('sends none of the two always-excluded payload keys from mail-payload.ts either (S-015/S-021)', () => {
    // `mail-payload.ts` SI lleva `creator` (es el punto de S-015) y, desde S-021, `fileIds`
    // condicional (es el punto DE ESTA story) — por eso ninguno de los dos esta en esta lista, a
    // diferencia del payload fijo de arriba. Las que siguen prohibidas de plano en CUALQUIER
    // payload son `state` y `actor`.
    const payload = FILES.find((file) => file.relativePath === `${PUBLICACION}mail-payload.ts`);

    expect(payload).toBeDefined();
    for (const excluded of ['state', 'actor']) {
      expect(
        payload?.code,
        `the mail-derived payload must not carry ${excluded}`,
      ).not.toMatch(new RegExp(`\\b${excluded}\\s*:`));
    }
    // Y la contracara positiva: `creator` y `fileIds` SI estan, para que este test no pase
    // vacuamente si alguien borrara alguna de las dos claves del archivo.
    expect(payload?.code).toMatch(/\bcreator\s*:/);
    expect(payload?.code).toMatch(/\bfileIds\s*:/);
  });

  it('declares no database client and writes no SQL, as ADR-001 forbids', () => {
    // El conector no alcanza PostgreSQL: esta tres saltos mas alla — publica un comando, `core` lo
    // ejecuta, `core` escribe.
    for (const file of FILES) {
      expect(file.code).not.toMatch(
        /from\s*'(pg|sequelize|sequelize-typescript|typeorm|prisma|knex)'/,
      );
      expect(file.code, `${file.relativePath} must not write SQL`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
      );
    }
  });
});
