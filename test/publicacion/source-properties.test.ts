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
// S-027: el tercer punto de publicacion, el del Comentario.
const PUBLISH_COMMENT = `${PUBLICACION}publish-comment.ts`;
const UPLOAD_BYTE = `${PUBLICACION}upload-byte.ts`;
// S-029: el UNICO archivo de `src/` autorizado a tocar el plano de LECTURA.
const LOOKUP_ATTACHMENT = `${PUBLICACION}lookup-attachment.ts`;
const PROCESAR_ADJUNTOS = `${PUBLICACION}procesar-adjuntos-mail.ts`;
const PUBLISH_ERRORS = `${PUBLICACION}publish-errors.ts`;
const ADJUNTOS = `domain${sep}adjuntos${sep}`;

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

  // TS-30 (ACOTADO POR S-029), TS-31, TS-32, TS-33
  it('touches the query plane only through attachments.list, only in the lookup module', () => {
    // ==== QUE CAMBIO, EXACTAMENTE ====
    //
    // ADR-003 decia: "El conector MUST NOT publicar en el plano de consultas (`jiku-queries.*`) ni
    // suscribirse a subjects de otros servicios". S-029 DEROGA LA PRIMERA MITAD, y hay que ser
    // preciso sobre el alcance porque este test es el UNICO lugar del repo donde esa frontera queda
    // EJECUTABLE:
    //
    //   - DEROGADO: publicar en `jiku-queries.*`, para UN recurso (`attachments.list`), desde UN
    //     archivo (`lookup-attachment.ts`). Y por una razon concreta: `core` expuso `checksum` como
    //     FILTRABLE e INCLUIBLE precisamente para que un consumidor pueda deduplicar contra los
    //     vinculos existentes en UNA consulta. La nota del contrato de `core` lo dice literalmente.
    //   - INTACTO: suscribirse a subjects de otros servicios. Esta story NO agrega ninguna
    //     suscripcion — `client.list()` es un request/reply sobre el inbox propio.
    //
    // LA REESCRITURA DEL TEXTO DE ADR-003 ES DE S-030, no de esta story. Hasta entonces, este test
    // es la version ejecutable de la regla y el codigo tiene razon sobre el documento.
    //
    // POR QUE ESTE CASO NO SE BORRO: borrarlo dejaria el plano de lectura abierto de par en par.
    // `client.all()` pagina el universo entero de un filtro y lo sostiene en memoria;
    // `client.query()` saltea el chequeo de forma que hace `list()`. Ninguno de los dos tiene lugar
    // en un worker cuyo pico de memoria es un mail a la vez (ADR-001). La derogacion es de UNA
    // regla, no de la ADR.
    for (const file of FILES) {
      // Lo prohibido en TODOS los archivos, incluido el nuevo. `all` y `count` NO ESTABAN en la
      // lista original —no existia el plano de lectura, asi que nadie los penso— y son justo los
      // dos que paginarian el universo.
      for (const forbidden of [
        'client.query(',
        'client.get(',
        'client.iterate(',
        'client.iteratePages(',
        'client.all(',
        'client.count(',
      ]) {
        expect(
          file.code,
          `${file.relativePath} must not touch the query plane (${forbidden})`,
        ).not.toContain(forbidden);
      }

      // ADR-002: el subject lo arma el SDK. `jiku-queries` no aparece en `src/`, igual que hoy no
      // aparece `jiku-commands.v1` (CA-15).
      expect(
        file.code,
        `${file.relativePath} must not spell out a query subject`,
      ).not.toContain('jiku-queries');

      // `client.list(` SOLO en el modulo del lookup.
      if (file.relativePath !== LOOKUP_ATTACHMENT) {
        expect(
          file.code,
          `${file.relativePath} must not call client.list() — only ${LOOKUP_ATTACHMENT} may`,
        ).not.toContain('client.list(');
      }
    }

    // Y LA ASERCION POSITIVA, que es la que evita el falso negativo: si alguien borrara el modulo o
    // le cambiara el nombre al archivo, el bucle de arriba pasaria en verde SIN VER NADA. Es el
    // mismo criterio que el caso de los tres comandos usa para `publish-comment.ts`.
    const lookup = FILES.find((file) => file.relativePath === LOOKUP_ATTACHMENT);
    expect(lookup, `${LOOKUP_ATTACHMENT} must exist: it is the only authorised query`).toBeDefined();
    expect(lookup?.code).toContain('client.list(');
  });

  // TS-34
  it('never recomputes the checksum in the lookup module', () => {
    // CA-17: `deduplicar()` es el UNICO lugar donde se hashea. El modulo recibe el
    // `AdjuntoAceptado` que ya lo trae, y NO recibe `content` — asi que ni tiene el byte para
    // hashear. Recibirlo invitaria a recalcularlo y crearia una segunda fuente de verdad del hash.
    const lookup = FILES.find((file) => file.relativePath === LOOKUP_ATTACHMENT);
    expect(lookup, `${LOOKUP_ATTACHMENT} must exist`).toBeDefined();

    for (const forbidden of ['createHash', 'node:crypto', '.digest(']) {
      expect(
        lookup?.code,
        `${LOOKUP_ATTACHMENT} must not hash anything (${forbidden})`,
      ).not.toContain(forbidden);
    }

    // Y la contracara: su firma NO menciona `content`. El `Pick<>` declara exactamente lo que
    // consume, y el byte no esta ahi.
    expect(lookup?.code, `${LOOKUP_ATTACHMENT} must not receive the byte`).not.toMatch(
      /\bcontent\b/,
    );
  });

  // TS-35
  it('never parallelises the attachment loop', () => {
    // CA-18 y ADR-001: la consulta va DENTRO del `for` que ya es serie. Paralelizar romperia el
    // "par por archivo" del orden de `fileIds` que S-022 afirma con su propio test de propiedad.
    for (const relativePath of [LOOKUP_ATTACHMENT, PROCESAR_ADJUNTOS]) {
      const file = FILES.find((f) => f.relativePath === relativePath);
      expect(file, `${relativePath} must exist`).toBeDefined();

      for (const forbidden of ['Promise.all', 'Promise.allSettled', 'Promise.race']) {
        expect(
          file?.code,
          `${relativePath} must process attachments serially (${forbidden})`,
        ).not.toContain(forbidden);
      }
    }
  });

  // TS-36
  it('gives the lookup result no error variant', () => {
    // CA-11: el `for` de `procesarAdjuntosDelMail()` no puede interrumpirse, asi que la funcion
    // agota sus fallos INTERNAMENTE. Una variante de error en el tipo de retorno seria la puerta
    // por la que alguien "no se traga el error" y rompe la degradacion — produciendo un aviso
    // mentiroso: un adjunto que se subio bien, contado como fallido.
    const lookup = FILES.find((file) => file.relativePath === LOOKUP_ATTACHMENT);
    expect(lookup, `${LOOKUP_ATTACHMENT} must exist`).toBeDefined();

    const variantes = [...(lookup?.code.matchAll(/tipo:\s*'([a-z_]+)'/g) ?? [])].map(
      (match) => match[1] as string,
    );

    expect([...new Set(variantes)].sort()).toEqual(['reusado', 'sin_match']);
  });

  // TS-37
  it('adds no branch to diagnosePublishFailure', () => {
    // CA-6: la traduccion de errores se REUSA SIN MODIFICAR. `query_timeout` es un codigo nuevo
    // para este conector y cae, correctamente, en `core_rechazo_desconocido` — que es el
    // comportamiento por diseno para un catalogo que `core` posee y hace crecer.
    const errores = FILES.find((file) => file.relativePath === PUBLISH_ERRORS);
    expect(errores, `${PUBLISH_ERRORS} must exist`).toBeDefined();

    const diagnosticos = [...(errores?.code.matchAll(/\|\s*'([a-z_]+)'/g) ?? [])].map(
      (match) => match[1] as string,
    );

    expect(new Set(diagnosticos).size).toBe(9);

    for (const forbidden of ['query_timeout', 'invalid_cursor', 'attachments', 'reuso']) {
      expect(
        errores?.code,
        `diagnosePublishFailure must not learn about ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  // TS-38
  it('leaves the local attachment policy untouched', () => {
    // CA-4: `dedup.ts`, `particionar.ts` y `tope.ts` se conservan tal cual. El `checksum` que la
    // consulta necesita ya lo produce `deduplicar()`, y las tres siguen siendo funciones PURAS: si
    // alguna aprendiera del `requirementId` o del `client`, dejaria de serlo y el pipeline local
    // pasaria a depender del bus.
    for (const nombre of ['dedup.ts', 'particionar.ts', 'tope.ts']) {
      const file = FILES.find((f) => f.relativePath === `${ADJUNTOS}${nombre}`);
      expect(file, `${ADJUNTOS}${nombre} must exist`).toBeDefined();

      for (const forbidden of ['lookup-attachment', 'requirementId', 'entityId', 'client.']) {
        expect(
          file?.code,
          `${ADJUNTOS}${nombre} must stay pure (${forbidden})`,
        ).not.toContain(forbidden);
      }
    }
  });

  // TS-40
  it('invokes client.list with two arguments, never lowering the timeout', () => {
    // ADR-006 prohibe bajar el timeout por el tercer argumento de una llamada del SDK. El
    // `RequestOptions` es exactamente donde se haria por accidente, asi que la consulta usa el
    // `timeoutMs` del cliente — el mismo de los tres comandos.
    const lookup = FILES.find((file) => file.relativePath === LOOKUP_ATTACHMENT);
    expect(lookup, `${LOOKUP_ATTACHMENT} must exist`).toBeDefined();

    expect(lookup?.code, `${LOOKUP_ATTACHMENT} must not lower the timeout`).not.toMatch(
      /timeoutMs/,
    );
    expect(lookup?.code, `${LOOKUP_ATTACHMENT} must not pass RequestOptions`).not.toMatch(
      /RequestOptions/,
    );
  });

  it('publishes only the three commands ADR-003 allows', () => {
    // El nombre del comando vive en la constante `COMMAND` del publicador, no inline en la llamada:
    // por eso se buscan los NOMBRES DE COMANDO declarados en todo `src/` en vez del argumento
    // literal de `.command(`. Buscar solo el argumento daria vacio y el test pasaria sin verificar
    // nada — que es el falso negativo, no el falso positivo, y por eso importa mas.
    //
    // ACTUALIZADO EN S-027, y el motivo es exactamente ese falso negativo. El tercer comando,
    // `requirements.{id}.comment`, tiene el id EMBEBIDO, asi que su nombre no puede ser un literal
    // entero: se declara partido en `COMMAND_PREFIX = 'requirements.'` + `COMMAND_SUFFIX =
    // '.comment'`. NINGUNA de las dos mitades matchea el regex de nombres completos, asi que este
    // caso pasaba en verde SIN VER el comando nuevo — verificado. Por eso ahora se buscan las dos
    // formas: los nombres estaticos, y el par prefijo/sufijo del dinamico.
    const declared = FILES.flatMap((file) =>
      [...file.code.matchAll(/['"`]([a-z-]+\.[a-z-]+)['"`]/g)]
        .map((match) => match[1] as string)
        // Solo los que parecen nombres de comando del bus: `{recurso}.{accion}`. Se excluyen los
        // especificadores de import y de archivo, que tienen la misma forma.
        .filter((candidate) => /^(requirements|files|users|projects|tasks|comments)\./.test(candidate)),
    );

    // Los DOS comandos de nombre ESTATICO: `requirements.new` (S-005) y `files.request-upload`
    // (S-018). Orden no relevante.
    expect([...new Set(declared)].sort()).toEqual(['files.request-upload', 'requirements.new']);

    for (const command of declared) {
      expect(['requirements.new', 'files.request-upload']).toContain(command);
    }

    // Y el TERCERO, el dinamico, con su nombre partido. Se afirma que existe —si alguien borrara la
    // publicacion del comentario este caso tiene que fallar— y que las dos mitades son las
    // esperadas, para que un `requirements.` combinado con otro sufijo no pase inadvertido.
    const publisher = FILES.find((file) => file.relativePath.endsWith('publish-comment.ts'));
    expect(publisher, 'publish-comment.ts must exist: it is the third allowed command').toBeDefined();
    expect(publisher?.code).toMatch(/COMMAND_PREFIX\s*=\s*['"`]requirements\.['"`]/);
    expect(publisher?.code).toMatch(/COMMAND_SUFFIX\s*=\s*['"`]\.comment['"`]/);

    // Ningun OTRO sufijo de comando dinamico sobre `requirements.`: los subjects de edicion
    // (`.update`, `.delete`, `.close`) estan prohibidos por ADR-003 y por CA-17 de esta story.
    for (const file of FILES) {
      for (const forbidden of ['.update', '.delete', '.close', '.assign', '.reopen']) {
        expect(
          file.code.includes(`COMMAND_SUFFIX = '${forbidden}'`),
          `${file.relativePath} declares a forbidden dynamic command suffix ${forbidden}`,
        ).toBe(false);
      }
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

  it('invokes client.command in exactly three files', () => {
    const publishers = FILES.filter((file) => /\.command\s*\(/.test(file.code)).map(
      (f) => f.relativePath,
    );

    // TRES puntos de publicacion desde S-027: `publish-requirement.ts` (`requirements.new`),
    // `upload-file.ts` (`files.request-upload`) y `publish-comment.ts`
    // (`requirements.{id}.comment`). Un CUARTO sigue prohibido, y la propiedad que esto defiende no
    // cambio: la traduccion de errores y la linea de log no se pueden saltear. Un archivo nuevo que
    // publicara sin pasar por ninguno de los tres lo haria sin el `try/catch` que esta suite
    // protege, y sus fallos de `core` saldrian sin diagnostico.
    //
    // La lista se AMPLIA una entrada por story que agrega un comando permitido por ADR-003 — nunca
    // se relaja a un `toBeGreaterThan`, que dejaria entrar cualquier publicador nuevo en silencio.
    expect([...publishers].sort()).toEqual(
      [PUBLISH_REQUIREMENT, UPLOAD_FILE, PUBLISH_COMMENT].sort(),
    );
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

  // TS-66 (S-027): la misma propiedad, ahora sobre el publicador del comentario.
  it('invokes client.command exactly once in publish-comment.ts, with two arguments', () => {
    const publisher = FILES.find((file) => file.relativePath === PUBLISH_COMMENT);
    expect(publisher).toBeDefined();

    const invocations = publisher?.code.match(/\.command\s*\(/g) ?? [];
    expect(invocations).toHaveLength(1);

    // DOS argumentos: el `method` (armado con el id embebido) y el payload. Un TERCERO seria un
    // `timeoutMs` propio, y ADR-006 lo prohibe: convertiria los errores explicados de core en
    // timeouts mudos.
    expect(publisher?.code).toMatch(/\.command\(method,\s*payload\)/);
    expect(publisher?.code).not.toMatch(/\.command\([^)]*timeoutMs/);
  });

  // TS-68 (S-027): el publicador del comentario REUSA la traduccion de errores, no la reimplementa.
  it('reuses the shared error translation instead of defining its own', () => {
    const publisher = FILES.find((file) => file.relativePath === PUBLISH_COMMENT);
    expect(publisher).toBeDefined();

    // Importa la traduccion compartida...
    expect(publisher?.code).toMatch(/diagnosePublishFailure/);
    // ...y NO declara un mapa de codigos propio. Una segunda traduccion divergiria de la primera en
    // el primer codigo nuevo que core agregue, y la que quedaria vieja es la que nadie mira.
    expect(publisher?.code).not.toMatch(/const\s+\w*(?:CODES|DIAGNOSES|REMEDIES)\w*\s*[:=]/);
    expect(publisher?.code).not.toMatch(/requirement_not_found/);
    expect(publisher?.code).not.toMatch(/file_not_owned/);
  });

  // TS-69 (S-027): ni el publicador ni el schema leen el entorno o el logger global.
  it('keeps the comment modules free of process.env and getLogger', () => {
    const comentario = FILES.filter(
      (file) =>
        file.relativePath === PUBLISH_COMMENT ||
        file.relativePath.endsWith(`comment.schema.ts`) ||
        file.relativePath.endsWith(`comment.types.ts`),
    );

    // Sanidad: los tres archivos existen y el filtro no quedo vacio.
    expect(comentario.length).toBeGreaterThanOrEqual(2);

    for (const file of comentario) {
      expect(file.code, `${file.relativePath} must not read process.env`).not.toContain(
        'process.env',
      );
      // El logger llega POR PARAMETRO, igual que en las dos hermanas: es lo que permite inyectar un
      // logger de captura en los tests sin tocar el singleton del proceso.
      expect(file.code, `${file.relativePath} must not use getLogger()`).not.toContain('getLogger(');
    }
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
