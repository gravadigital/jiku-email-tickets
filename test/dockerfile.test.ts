import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Propiedades DECLARATIVAS del empaquetado: lo que el `Dockerfile` y el `.dockerignore` dicen.
 *
 * Este archivo es el equivalente de `test/manifest.test.ts` —que verifica `package.json`— aplicado
 * al empaquetado. Corre en milisegundos y NO necesita Docker: lo que la imagen RESULTA ser se
 * verifica en `test/docker-image.test.ts`, que si lo necesita y tarda minutos. Separarlos hace que
 * un fallo diga de inmediato si el problema esta en lo que el Dockerfile declara o en lo que la
 * imagen termina siendo, y que quien corre la suite sin Docker pierda solo el segundo.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Nombres de variables que llevan credenciales o configuracion de despliegue. */
const RUNTIME_ONLY_VARIABLES = [
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
  'JIKU_VERIFY_PROJECT_ID',
] as const;

interface DockerfileLine {
  readonly raw: string;
  readonly text: string;
  readonly isComment: boolean;
  /** Primer token en mayusculas de una linea de instruccion; `null` en comentarios y vacias. */
  readonly directive: string | null;
}

/**
 * Clasifica cada linea en comentario / instruccion / vacia.
 *
 * Sin esta clasificacion las aserciones de AUSENCIA (`EXPOSE`, `HEALTHCHECK`) fallarian por culpa
 * de la documentacion que la propia story pide: CA-3 exige comentarios que expliquen por que esas
 * dos directivas no estan, y esos comentarios MENCIONAN las palabras. Un test ingenuo que buscara
 * la palabra en todo el archivo se rompe con la documentacion correcta, que es el peor incentivo
 * posible.
 */
function parseDockerfile(contents: string): DockerfileLine[] {
  return contents.split('\n').map((raw) => {
    const text = raw.trim();
    const isComment = text.startsWith('#');
    const firstToken = text.split(/\s+/)[0] ?? '';
    const directive = !isComment && /^[A-Z]+$/.test(firstToken) ? firstToken : null;

    return { raw, text, isComment, directive };
  });
}

/** Las lineas de instruccion (no comentarios, no vacias) que usan la directiva pedida. */
function directiveLines(lines: readonly DockerfileLine[], directive: string): DockerfileLine[] {
  return lines.filter((line) => line.directive === directive);
}

/**
 * Solo el texto de las INSTRUCCIONES, sin comentarios.
 *
 * Es el texto sobre el que se afirma toda AUSENCIA. La razon es la misma que la de `parseDockerfile`
 * y vale la pena repetirla: los comentarios que CA-3 exige nombran `EXPOSE`, `HEALTHCHECK`,
 * `npm install`, `python3` y `.env.defaults` para explicar por que NO estan, asi que afirmar sobre
 * el archivo crudo haria que la documentacion correcta rompiera el test.
 */
function instructionText(lines: readonly DockerfileLine[]): string {
  return lines
    .filter((line) => line.directive !== null)
    .map((line) => line.text)
    .join('\n');
}

/** Solo el texto de los comentarios, en minusculas, para las aserciones de "esta explicado". */
function commentText(lines: readonly DockerfileLine[]): string {
  return lines
    .filter((line) => line.isComment)
    .map((line) => line.text)
    .join('\n')
    .toLowerCase();
}

/**
 * El bloque de lineas de una etapa: desde su `FROM ... AS <name>` hasta el `FROM` siguiente.
 *
 * Varias aserciones son POR ETAPA y no globales: un `npm ci` sin `--omit=dev` es correcto en `test`
 * y en `builder`, y es un fallo en `production`. Afirmar sobre el archivo entero las confundiria.
 */
function stageBlock(lines: readonly DockerfileLine[], stage: string): DockerfileLine[] {
  const startIndex = lines.findIndex(
    (line) => line.directive === 'FROM' && new RegExp(`\\bAS\\s+${stage}\\b`, 'i').test(line.text),
  );

  if (startIndex === -1) return [];

  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => line.directive === 'FROM');

  return endOffset === -1 ? rest : rest.slice(0, endOffset);
}

/** El texto de las instrucciones de una etapa, sin comentarios: lo que la etapa HACE. */
function stageInstructions(lines: readonly DockerfileLine[], stage: string): string {
  return stageBlock(lines, stage)
    .filter((line) => line.directive !== null)
    .map((line) => line.text)
    .join('\n');
}

describe('Dockerfile', () => {
  let contents: string;
  let lines: DockerfileLine[];
  let engineFloor: string;

  beforeAll(async () => {
    contents = await readFile(new URL('Dockerfile', `file://${PROJECT_ROOT}`), 'utf8');
    lines = parseDockerfile(contents);

    const manifestRaw = await readFile(new URL('package.json', `file://${PROJECT_ROOT}`), 'utf8');
    const manifest = JSON.parse(manifestRaw) as { engines?: Record<string, string> };
    engineFloor = manifest.engines?.node ?? '';
  });

  // TS-1
  it('declares the three stages in order: test, builder, production', () => {
    const stages = directiveLines(lines, 'FROM')
      .map((line) => /\bAS\s+(\S+)/i.exec(line.text)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(stages).toEqual(['test', 'builder', 'production']);
  });

  // TS-2
  it('installs only production dependencies in the production stage', () => {
    const production = stageInstructions(lines, 'production');

    expect(production).toContain('npm ci --omit=dev');
    // `npm install` resuelve el arbol de nuevo e ignora el lockfile: la imagen dejaria de ser
    // reproducible respecto del `package-lock.json` que la suite verifico.
    expect(instructionText(lines)).not.toContain('npm install');

    // Y ningun `npm ci` SIN `--omit=dev` en esta etapa: eso metería las devDependencies a la
    // imagen final. En `test` y `builder` el mismo comando es correcto.
    const bareInstallInProduction = production
      .split('\n')
      .some((line) => line.includes('npm ci') && !line.includes('--omit=dev'));
    expect(bareInstallInProduction).toBe(false);
  });

  // TS-3
  it('uses a base image that satisfies the node engines floor of package.json', () => {
    const bases = directiveLines(lines, 'FROM').map((line) => line.text.split(/\s+/)[1] ?? '');

    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      expect(base, 'every stage must start from the same base image').toBe('node:22-alpine');
    }

    // Contra el `engines.node` REAL y no contra un literal: si mañana sube el floor, el test dice
    // exactamente donde hay que subir tambien la imagen base.
    const floorMajor = Number(/(\d+)/.exec(engineFloor)?.[1]);
    const imageMajor = Number(/node:(\d+)/.exec(bases[0] as string)?.[1]);

    expect(Number.isNaN(floorMajor)).toBe(false);
    expect(imageMajor).toBeGreaterThanOrEqual(floorMajor);
  });

  // TS-4
  it('creates a non-root user and activates it after the last COPY/RUN of the production stage', () => {
    expect(contents).toContain('adduser');

    const production = stageBlock(lines, 'production');
    const userIndex = production.findIndex((line) => line.directive === 'USER');

    expect(userIndex).toBeGreaterThanOrEqual(0);

    const userName = (production[userIndex] as DockerfileLine).text.split(/\s+/)[1];
    expect(userName).toBeDefined();
    expect(userName).not.toBe('root');

    // Los `COPY`/`RUN` escriben en /app, asi que tienen que ocurrir mientras el usuario sigue
    // siendo root. Un `USER` adelantado produce una imagen que falla al construirse... o peor, que
    // se construye y falla al arrancar por permisos.
    const lastWriteIndex = production.reduce(
      (last, line, index) => (line.directive === 'COPY' || line.directive === 'RUN' ? index : last),
      -1,
    );
    expect(userIndex).toBeGreaterThan(lastWriteIndex);
  });

  // TS-5
  it('declares no EXPOSE instruction', () => {
    expect(directiveLines(lines, 'EXPOSE')).toHaveLength(0);
  });

  // TS-6
  it('declares no HEALTHCHECK instruction', () => {
    expect(directiveLines(lines, 'HEALTHCHECK')).toHaveLength(0);
  });

  // TS-7
  it('documents both absences as decisions, in comments', () => {
    const comments = commentText(lines);

    // Sin el comentario, la ausencia es indistinguible de un olvido y el proximo lector la va a
    // "completar" con el `process.exit(0)` que la convencion sugiere. El comentario ES el artefacto
    // que lo impide, y por eso es criterio de aceptacion y no decoracion.
    expect(comments).toContain('expose');
    expect(comments).toContain('healthcheck');
    // Y la razon concreta: un check que siempre pasa no prueba nada.
    expect(comments).toMatch(/siempre pasa|no prueba nada/);
  });

  // TS-8
  it('starts the worker and never the verification mode', () => {
    const cmdLines = directiveLines(lines, 'CMD');

    expect(cmdLines).toHaveLength(1);

    const cmd = (cmdLines[0] as DockerfileLine).text;
    // Forma exec: `npm` interpondria un proceso padre que no propaga señales al hijo.
    expect(cmd).toBe('CMD ["node", "dist/index.js"]');
    // ADR-003: un requisito creado no se modifica ni se borra. Si el CMD publicara, cada reinicio
    // del contenedor dejaria basura permanente e irrecuperable en Jiku.
    expect(cmd).not.toContain('verify');
  });

  // TS-9
  it('keeps package.json in the final image, as module-imports requires', () => {
    const production = stageInstructions(lines, 'production');

    // El campo `imports` vive en package.json: sin ese archivo en la imagen, cada import `#`
    // falla al arrancar con ERR_PACKAGE_IMPORT_NOT_DEFINED. La imagen se construye perfecta y
    // muere al correr.
    expect(production).toMatch(/COPY\s+package\*\.json/);
    expect(production).not.toMatch(/rm\s+.*package\.json/);
  });

  // TS-10
  it('copies dist/ from the builder stage and never from the build context', () => {
    const production = stageInstructions(lines, 'production');

    expect(production).toMatch(/COPY\s+--from=builder\s+\/app\/dist\s+\.\/dist/);
    // Copiarlo del host haria que la imagen dependiera de que alguien corriera `npm run build`
    // antes — el fallo "funciona en mi maquina" en su forma mas pura. Ademas `dist` esta en el
    // `.dockerignore`, asi que ni siquiera esta en el contexto.
    const copiesDistFromContext = production
      .split('\n')
      .some((line) => /^COPY\s+(?!--from)/.test(line) && /\bdist\b/.test(line));
    expect(copiesDistFromContext).toBe(false);
  });

  // TS-20
  it('bakes no credential nor deployment value through ENV', () => {
    const envLines = directiveLines(lines, 'ENV').map((line) => line.text);

    for (const variable of RUNTIME_ONLY_VARIABLES) {
      for (const line of envLines) {
        expect(line, `${variable} must be injected at runtime, never baked`).not.toContain(variable);
      }
    }
  });

  it('installs no native build toolchain: no production dependency compiles native modules', () => {
    // La propia convencion `dockerfile` autoriza quitarlo: "Remove it if not needed".
    const instructions = instructionText(lines);
    expect(instructions).not.toContain('python3');
    expect(instructions).not.toMatch(/apk add[^\n]*\bg\+\+/);
  });

  it('copies no .env.defaults: this service keeps its defaults in the Zod schema', () => {
    // La convencion asume un `.env.defaults`. Este servicio no lo tiene —sus defaults viven en
    // `src/config/schema.ts`, validados y tipados— asi que un `COPY .env.defaults` no seria una
    // mejora: cortaria el build.
    expect(instructionText(lines)).not.toContain('.env.defaults');
  });

  it('leaves the test stage ready without running the suite inside the build', () => {
    const test = stageInstructions(lines, 'test');

    expect(test).toContain('npm ci');
    // La suite levanta un contenedor NATS con Testcontainers: correrla con `RUN` exigiria Docker
    // DENTRO del build, que un `docker build` normal no tiene. La etapa deja el contexto listo para
    // correrla a mano con `docker run`; el CI la corre sobre el checkout (ADR-007).
    expect(test).not.toMatch(/RUN\s+npm\s+(test|run test)/);
    expect(commentText(lines)).toContain('testcontainers');
  });

  it('does not ship devDependencies through a stray copy of node_modules', () => {
    const production = stageInstructions(lines, 'production');

    // El unico node_modules de la imagen final tiene que salir del `npm ci --omit=dev`. Copiarlo
    // de `test` o de `builder` traeria las devDependencies enteras y anularia el `--omit=dev`.
    expect(production).not.toMatch(/COPY\s+--from=(test|builder)[^\n]*node_modules/);
  });

  it('installs dependencies before copying the sources, so a code change does not invalidate them', () => {
    for (const stage of ['test', 'builder'] as const) {
      const instructions = stageBlock(lines, stage).filter((line) => line.directive !== null);
      const installIndex = instructions.findIndex((line) => line.text.includes('npm ci'));
      const copyAllIndex = instructions.findIndex((line) => /^COPY\s+\.\s+\./.test(line.text));

      expect(installIndex, `${stage} must install dependencies`).toBeGreaterThanOrEqual(0);
      expect(copyAllIndex, `${stage} must copy the sources`).toBeGreaterThanOrEqual(0);
      expect(installIndex, `${stage} must install before copying the sources`).toBeLessThan(copyAllIndex);
    }
  });

  // TS-6 (S-032)
  it('names the pinned jiku-ts@edd1064 build in the TEMPORAL note, and keeps the three vendor copies', () => {
    // La nota TEMPORAL es la que dice POR QUE `vendor/` viaja en la imagen y CUANDO se borra. Si
    // siguiera nombrando el 1.1.0, quien lea el Dockerfile buscaria publicar un minor que ya no es
    // el que hace falta (REQ-008 consume el build de jiku-ts@edd1064, con el Espacio KV).
    const comments = lines.filter((line) => line.isComment).map((line) => line.text);

    expect(comments.some((line) => line.includes('jiku-ts@edd1064'))).toBe(true);
    expect(comments.filter((line) => line.includes('1.1.0'))).toEqual([]);
    expect(directiveLines(lines, 'COPY').filter((line) => line.text === 'COPY vendor ./vendor')).toHaveLength(3);
  });

  it('clears the npm cache in the same layer that installs, or the layer keeps it', () => {
    const production = stageInstructions(lines, 'production');
    const installLine = production.split('\n').find((line) => line.includes('npm ci --omit=dev'));

    expect(installLine).toBeDefined();
    expect(installLine).toContain('npm cache clean --force');
  });
});

describe('.dockerignore', () => {
  let entries: string[];

  beforeAll(async () => {
    const contents = await readFile(new URL('.dockerignore', `file://${PROJECT_ROOT}`), 'utf8');
    entries = contents
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  });

  // TS-11
  it('excludes the paths through which a secret enters the build context', () => {
    // No es una optimizacion de tamaño: `COPY . .` mete el contexto entero, y el contexto de una
    // maquina de desarrollo incluye `.env.local`, `.env.test`, quiza una key JSON de desarrollo y
    // el `.git` completo con todo el historial. CA-4 se enuncia sobre la imagen y se gana aca.
    expect(entries).toContain('node_modules');
    expect(entries).toContain('dist');
    expect(entries).toContain('.git');

    // Patron amplio y no una lista de nombres exactos: la lista se queda vieja y el archivo que se
    // cuela es siempre el que no estaba en ella.
    expect(entries).toContain('.env*');
  });

  it('excludes credential files by pattern, not by name', () => {
    for (const pattern of ['*.pem', '*.key', '*.creds']) {
      expect(entries).toContain(pattern);
    }
  });

  // TS-12
  it('does not exclude what the test stage needs', () => {
    // `.dockerignore` excluye del CONTEXTO, asi que lo excluido no puede copiarse en NINGUNA
    // etapa. Excluir `test/` dejaria la etapa `test` inservible. Que esos archivos entren al
    // contexto no debilita CA-4, que es sobre SECRETOS: la etapa `production` no los copia, que es
    // lo unico que importa para la imagen final.
    for (const needed of ['test', 'test/', 'vitest.config.ts', 'scripts', 'scripts/']) {
      expect(entries, `${needed} must stay in the build context`).not.toContain(needed);
    }
  });

  it('explains in a comment why the test directory stays in the context', async () => {
    const contents = await readFile(new URL('.dockerignore', `file://${PROJECT_ROOT}`), 'utf8');
    const comments = contents
      .split('\n')
      .filter((line) => line.trim().startsWith('#'))
      .join('\n')
      .toLowerCase();

    expect(comments).toContain('test');
  });
});
