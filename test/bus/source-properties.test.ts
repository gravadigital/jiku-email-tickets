import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * TS-16 a TS-19: las propiedades de la forma "no existe ningun camino de codigo que X".
 *
 * Un test de comportamiento no puede afirmar eso —solo puede probar los caminos que ejercita— asi
 * que se escanea `src/` con los comentarios stripeados. El patron es el de
 * test/config/source-properties.test.ts, incluido su test de sanidad del scanner: sin el, un
 * scanner que devuelve vacio hace pasar todos los tests de abajo sin verificar nada.
 */

const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
const BUS_CONNECTION = `infra${sep}bus${sep}connection.ts`;

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
 * Imprescindible en este servicio: el codigo comenta densamente los "por que" verificados, y varios
 * de esos comentarios mencionan justamente lo que estos tests prohiben —`process.env`, `users`,
 * `connect()`— para explicar por que NO se hace. Sin stripear, cada explicacion haria fallar su
 * propio test.
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

describe('src/ bus source properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Sin esta sanidad, un scanner roto pasaria todos los tests de abajo sin verificar nada.
    expect(FILES.length).toBeGreaterThan(3);
    expect(FILES.map((f) => f.relativePath)).toContain(BUS_CONNECTION);
  });

  // TS-16
  it('imports the SDK connect in exactly one file', () => {
    // Se busca el IMPORT y no la palabra `connect`, que aparece como substring en otros contextos
    // (`connection`, `connectToBus`, `connectedUrl`) y haria del test un falso positivo.
    const importers = FILES.filter((file) =>
      /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*'@gravadigital\/jiku'/.test(file.code),
    ).map((f) => f.relativePath);

    expect(importers).toEqual([BUS_CONNECTION]);
  });

  it('invokes the SDK connect exactly once, in the file that imports it', () => {
    const connection = FILES.find((file) => file.relativePath === BUS_CONNECTION);
    expect(connection).toBeDefined();

    // `connect(` a secas matchearia tambien `connectToBus(`, asi que se exige que no venga
    // precedido por un caracter de identificador.
    const invocations = connection?.code.match(/(?<![A-Za-z0-9_$])connect\s*\(/g) ?? [];

    // Conectar cuesta un round-trip a Zitadel MAS el handshake que corre el auth-callout: una
    // conexion por operacion multiplicaria ese costo y ofreceria mas superficie al callout.
    expect(invocations).toHaveLength(1);
  });

  it('never opens a raw NATS connection outside the SDK', () => {
    // `nats` no es dependencia y no puede volverse una (ADR-002): dos copias de la libreria en el
    // arbol son dos juegos de clases de error, y `error instanceof X` falla contra la copia que
    // lanzo. El subpath del SDK garantiza una sola copia.
    const offenders = FILES.filter((file) => /from\s*'nats'/.test(file.code)).map(
      (f) => f.relativePath,
    );

    expect(offenders).toEqual([]);
  });

  // TS-17
  it('declares no environment variable that could carry the user-id', () => {
    const schema = FILES.find((file) => file.relativePath === `config${sep}schema.ts`);
    expect(schema).toBeDefined();

    // El user-id tiene que coincidir exactamente con el `sub` que el auth-callout lee para
    // autorizar el subject. Si saliera del entorno, se podria declarar una identidad que no es la
    // de la key (NFR-S03, invariante 17).
    expect(schema?.code).not.toMatch(/USER_?ID|SUBJECT|MAIL_BOT/i);
  });

  it('never passes userId or inboxPrefix in the options of the SDK connect', () => {
    // El propio d.ts del SDK dice de `userId` *"LEAVE IT UNSET"*: se deriva del `sub` del token, y
    // un valor que no coincida produce una violacion de autorizacion, no acceso al espacio de
    // otro. `inboxPrefix` lo fija el SDK siempre como `_INBOX.<hash(sub)>`, y cualquier otro hace
    // que la reply se publique donde nadie escucha y la request expire SIN ERROR VISIBLE.
    //
    // La asercion se acota al ARGUMENTO de connect() y no a la aparicion del identificador en
    // cualquier lado: `userId` e `inboxPrefix` son tambien getters legitimos del Client, y la
    // linea de arranque los LEE de ahi a proposito para el diagnostico. Prohibir el nombre a secas
    // haria fallar el uso correcto junto con el incorrecto.
    const connection = FILES.find((file) => file.relativePath === BUS_CONNECTION);

    // El objeto se declara como `const options = { ... }` y se le pasa a connect() por nombre, asi
    // que lo que hay que aislar es la declaracion. Se afirma primero que se encontro: un regex que
    // deja de matchear porque el codigo se reescribio haria pasar las dos aserciones de abajo sin
    // verificar nada.
    const options = /const options = \{([\s\S]*?)\n  \};/.exec(connection?.code ?? '');

    expect(options, 'the connect() options object must be findable to be checked').not.toBeNull();
    expect(options?.[1]).not.toMatch(/\buserId\s*:/);
    expect(options?.[1]).not.toMatch(/\binboxPrefix\s*:/);

    // Y que ese objeto sea efectivamente el que recibe connect(), no uno cualquiera.
    expect(connection?.code).toMatch(/(?<![A-Za-z0-9_$])connect\(options\)/);
  });

  it('reads the identity off the client rather than declaring it', () => {
    // La contracara del test anterior: el user-id que se loguea sale del Client —que lo derivo del
    // `sub` del token, que a su vez salio de la key— y no de un valor que el conector declare.
    //
    // La linea de arranque vive en `startup.ts` desde S-005, no en `index.ts`: la secuencia se
    // extrajo para que los DOS entry points (`start` y `verify`) la reusen sin duplicarla. Lo que
    // se afirma es la propiedad, no el archivo donde estaba.
    const startup = FILES.find((file) => file.relativePath === 'startup.ts');

    expect(startup, 'the shared startup sequence must be findable').toBeDefined();
    expect(startup?.code).toMatch(/client\.userId/);
    expect(startup?.code).toMatch(/client\.inboxPrefix/);
  });

  // TS-18
  it('never creates or asks for its row in the users table', () => {
    // La fila la crea Jiku sola al consumir el evento del auth-callout en la primera
    // autenticacion, con `identity_type: service` y `email` en NULL. El conector no la crea ni la
    // pide (CA-9, ADR-005, G-03).
    //
    // No es un `grep 'users'` a secas —la palabra puede aparecer en una URL o un identificador—
    // sino una asercion sobre lo que importaria de verdad.
    //
    // ACTUALIZADO EN S-005: hasta S-004 ningun archivo publicaba comandos y la asercion podia ser
    // "ningun `.command(` en ningun lado". S-005 introduce exactamente UNO —`requirements.new`, en
    // `domain/publicacion/publish-requirement.ts`.
    //
    // ACTUALIZADO EN S-018: se agrega un SEGUNDO publicador autorizado —`files.request-upload`, en
    // `domain/publicacion/upload-file.ts`— asi que la lista de publicadores deja de ser un unico
    // archivo y pasa a ser la lista CERRADA de los dos que ADR-003 permite. La propiedad que sigue
    // valiendo es la misma de siempre, mas precisa: el conector no publica NINGUN comando
    // relacionado con `users`, y publica solo desde los archivos autorizados. La cota de cuantos y
    // cuales comandos existen la afirma `test/publicacion/source-properties.test.ts`; lo que se
    // defiende aca es la fila en `users`.
    const PUBLISHERS = [
      `domain${sep}publicacion${sep}publish-requirement.ts`,
      `domain${sep}publicacion${sep}upload-file.ts`,
    ];

    for (const file of FILES) {
      if (!PUBLISHERS.includes(file.relativePath)) {
        expect(file.code, `${file.relativePath} must not publish a command`).not.toMatch(
          /\.command\s*\(/,
        );
      }
      expect(file.code, `${file.relativePath} must not name the users command`).not.toMatch(
        /['"`]users\.[a-z]+['"`]/,
      );
      expect(file.code, `${file.relativePath} must not write SQL`).not.toMatch(
        /\bINSERT\s+INTO\b/i,
      );
    }

    // Y ninguno de los publicadores publica un comando de `users`: la fila la crea Jiku sola en la
    // primera autenticacion, y el conector no la crea ni la pide (G-03, ADR-005).
    for (const publisherPath of PUBLISHERS) {
      const publisher = FILES.find((file) => file.relativePath === publisherPath);
      expect(publisher, `${publisherPath} must be findable`).toBeDefined();
      expect(publisher?.code).not.toMatch(/['"`]users\./);
    }
  });

  it('declares no database client, as ADR-001 forbids', () => {
    for (const file of FILES) {
      expect(file.code).not.toMatch(/from\s*'(pg|sequelize|sequelize-typescript|typeorm|prisma|knex)'/);
    }
  });

  // TS-19
  it('writes nothing to disk from the bus modules', () => {
    // El access token vive SOLO en memoria (ADR-005, CA-8): ni cache, ni archivo de estado. El
    // servicio entero no tiene estado en disco (ADR-001, NFR-R02).
    const busFiles = FILES.filter((file) => file.relativePath.startsWith(`infra${sep}bus${sep}`));
    expect(busFiles.length).toBeGreaterThan(0);

    for (const file of busFiles) {
      expect(file.code, `${file.relativePath} must not write to disk`).not.toMatch(
        /writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync/,
      );
    }
  });

  it('reads no environment variable from the bus modules', () => {
    // src/config/env.ts sigue siendo el unico lector del entorno del servicio; los modulos del bus
    // reciben todo por parametro, que es lo que los hace testeables sin tocar el singleton.
    const busFiles = FILES.filter((file) => file.relativePath.startsWith(`infra${sep}bus${sep}`));

    for (const file of busFiles) {
      expect(file.code, `${file.relativePath} must not read process.env`).not.toContain('process.env');
      expect(file.code, `${file.relativePath} must not use the logger singleton`).not.toMatch(
        /\bgetLogger\s*\(/,
      );
    }
  });

  it('never lowers the SDK command timeout below the floor', () => {
    // El timeout queda en el default del SDK (15000 ms) y NO SE BAJA: uno mas corto que el del bus
    // convierte una respuesta lenta en un ticket perdido sin reintento (ADR-006).
    const busFiles = FILES.filter((file) => file.relativePath.startsWith(`infra${sep}bus${sep}`));

    for (const file of busFiles) {
      expect(file.code, `${file.relativePath} must take the timeout from config`).not.toMatch(
        /timeoutMs\s*:\s*\d/,
      );
    }
  });
});
