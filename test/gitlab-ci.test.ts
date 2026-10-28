import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Propiedades DECLARATIVAS del pipeline: lo que `.gitlab-ci.yml` dice, leido como texto.
 *
 * Mismo criterio que `test/dockerfile.test.ts`: corre en milisegundos, NO necesita Docker ni GitLab
 * y NO agrega una dependencia YAML. La estructura del archivo esta fijada por el Story Plan de S-031,
 * asi que alcanza con partirlo por keys de columna 0. Lo que el pipeline HACE al correr (la regla de
 * `workflow` en ejecucion, el volumen compartido con dind, los tags en el registry) no se puede
 * afirmar desde aca: lo cubren las corridas reales de la story. Las decisiones y su por que: ADR-007.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** La misma regex del snippet de validacion de `release:main` (Decision 8). */
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$/;

/**
 * Entradas de la raiz que NO disparan el pipeline, cada una con su por que (Decision 5). Toda entrada
 * de la raiz tiene que estar aca o en la allowlist `.code-changes` del `.gitlab-ci.yml`.
 */
const EXCLUDED_ROOT_ENTRIES = [
  'docs',
  '*.md',
  // Tooling de la metodologia: no es codigo del servicio.
  '.claude',
  // Nombres exactos y no `.git*`: ese patron tambien matchea `.gitlab-ci.yml`, que SI dispara CI.
  '.git',
  '.gitignore',
  // Existen en disco sin estar en git.
  'node_modules',
  'dist',
  'coverage',
  '.env*',
  // Lo crea el `before_script` del job `test`: existe en la raiz durante el job.
  '.ci-tmp',
] as const;

async function readProjectFile(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${PROJECT_ROOT}`), 'utf8');
}

/**
 * Parte el YAML en bloques por keys de columna 0. Cada bloque incluye la linea de su key y todas las
 * siguientes hasta la proxima key de columna 0. Los comentarios de columna 0 (separadores y notas
 * entre jobs) no pertenecen a ningun bloque; los indentados si, y los saca `withoutComments`.
 */
function topLevelBlocks(text: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;

    const key = /^([.\w:-]+):/.exec(line)?.[1];
    if (key !== undefined) {
      current = [line];
      blocks.set(key, current);
    } else if (current !== null) {
      current.push(line);
    }
  }

  return blocks;
}

/**
 * El texto sin lineas de comentario. Toda AUSENCIA se afirma sobre este texto: los comentarios que
 * explican por que algo no esta (`docker push` en ramas de feature, `.npm/`) nombran esa misma cosa,
 * la misma leccion que `dockerfile.test.ts`.
 */
function withoutComments(lines: readonly string[]): string {
  return lines.filter((line) => !line.trim().startsWith('#')).join('\n');
}

/** Las rutas `- ...` del bloque `.code-changes`, la allowlist de `rules:changes`. */
function allowlist(text: string): string[] {
  const block = topLevelBlocks(text).get('.code-changes') ?? [];

  return block
    .slice(1)
    .map((line) => /^\s*-\s+(\S+)/.exec(line)?.[1])
    .filter((item): item is string => item !== undefined);
}

/** Glob minimo sobre el nombre de una entrada de la raiz: primer segmento del patron, `*` → `[^/]*`. */
function matchesRootEntry(entry: string, pattern: string): boolean {
  const segment = pattern.split('/')[0] ?? '';
  const source = segment
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');

  return new RegExp(`^${source}$`).test(entry);
}

/**
 * Clasifica las entradas de la raiz contra la allowlist y las exclusiones. Una entrada que no
 * matchea ninguna lista queda sin clasificar (no dispararia CI sin que nadie lo decidiera); una que
 * matchea las dos es ambigua (un patron de exclusion demasiado amplio).
 */
function classifyRootEntries(
  entries: readonly string[],
  allowed: readonly string[],
  exclusions: readonly string[],
): { unclassified: string[]; ambiguous: string[] } {
  const unclassified: string[] = [];
  const ambiguous: string[] = [];

  for (const entry of entries) {
    const inAllowlist = allowed.some((pattern) => matchesRootEntry(entry, pattern));
    const inExclusions = exclusions.some((pattern) => matchesRootEntry(entry, pattern));

    if (inAllowlist && inExclusions) ambiguous.push(entry);
    else if (!inAllowlist && !inExclusions) unclassified.push(entry);
  }

  return { unclassified, ambiguous };
}

/**
 * El item `- |` del `before_script` de `release:main`: las lineas con mas indentacion que el `- |`,
 * hasta el `- !reference`, desindentadas. Es el snippet tal cual lo corre GitLab.
 */
function versionSnippet(text: string): string {
  const block = topLevelBlocks(text).get('release:main') ?? [];
  const start = block.findIndex((line) => /^\s*-\s*\|\s*$/.test(line));
  if (start === -1) return '';

  const itemIndent = block[start]?.search(/\S/) ?? 0;
  const body: string[] = [];
  for (const line of block.slice(start + 1)) {
    if (/^\s*-\s*!reference/.test(line)) break;
    if (line.trim().length > 0 && line.search(/\S/) <= itemIndent) break;
    body.push(line);
  }

  const indent = Math.min(
    ...body.filter((line) => line.trim().length > 0).map((line) => line.search(/\S/)),
  );
  return body.map((line) => line.slice(indent)).join('\n').trim();
}

const RELEASE_FAMILY = new Set(['.release', 'release:dev', 'release:main']);

describe('.gitlab-ci.yml', () => {
  let ci: string;
  let blocks: Map<string, string[]>;
  let dockerfile: string;

  /** El texto sin comentarios de un bloque; falla si el bloque no existe. */
  function code(name: string): string {
    const block = blocks.get(name);
    expect(block, `falta el bloque de nivel raiz "${name}"`).toBeDefined();
    return withoutComments(block ?? []);
  }

  beforeAll(async () => {
    ci = await readProjectFile('.gitlab-ci.yml');
    blocks = topLevelBlocks(ci);
    dockerfile = await readProjectFile('Dockerfile');
  });

  // TS-1
  it('declares the stages build, test and release, in that order', () => {
    const stages = /^stages:\s*\[(.*)\]/m.exec(ci)?.[1];

    expect(stages?.split(',').map((stage) => stage.trim())).toEqual(['build', 'test', 'release']);
  });

  // TS-2
  it('runs the complete suite in the test job, not a subset', () => {
    const test = code('test');

    expect(test).toContain('npm run test:teardown');
    for (const filter of ['--exclude', 'test:ci', '--project', '--testNamePattern', '-t ']) {
      expect(test, `el job test no puede filtrar la suite con "${filter}"`).not.toContain(filter);
    }
    expect(test).not.toMatch(/vitest run\s+\S/);
  });

  // TS-3
  it('runs the test job on the same base image as the Dockerfile test stage', () => {
    const jobImage = /^\s+image:\s*(\S+)/m.exec(code('test'))?.[1];
    const stageBase = /^FROM\s+(\S+)\s+AS\s+test\b/im.exec(dockerfile)?.[1];

    expect(jobImage).toBe('node:22-alpine');
    expect(jobImage).toBe(stageBase);
  });

  // TS-4
  it('gives the test job a dind daemon and a TMPDIR inside the checkout', () => {
    const test = code('test');
    const extendsLine = /^\s+extends:\s*(.*)$/m.exec(test)?.[1] ?? '';

    expect(extendsLine).toContain('.dind');
    expect(code('.dind')).toMatch(/docker:[\w.-]*dind/);
    expect(test).toContain('TMPDIR: $CI_PROJECT_DIR/.ci-tmp');
    expect(test).toContain('TESTCONTAINERS_HOST_OVERRIDE: docker');
    expect(code('variables')).toContain('DOCKER_HOST: tcp://docker:2376');
  });

  // TS-5
  it('releases only after test, and only from exactly dev and main', () => {
    expect(code('.release')).toContain('needs: [test]');

    for (const [job, branch] of [
      ['release:dev', 'dev'],
      ['release:main', 'main'],
    ] as const) {
      const release = code(job);

      expect(release).toMatch(/^\s+extends:\s*\.release\s*$/m);
      expect(release).toContain(`$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "${branch}"`);
      expect(release).not.toContain('$CI_COMMIT_TAG');

      const branches = [...release.matchAll(/\$CI_COMMIT_BRANCH\s*==\s*"([^"]*)"/g)].map((m) => m[1]);
      expect(branches).toEqual([branch]);
    }
  });

  // TS-6
  it('runs docker login and docker push only in the release family', () => {
    for (const [name, lines] of blocks) {
      if (RELEASE_FAMILY.has(name)) continue;

      const text = withoutComments(lines);
      expect(text, `el bloque "${name}" no puede hacer docker login`).not.toContain('docker login');
      expect(text, `el bloque "${name}" no puede hacer docker push`).not.toContain('docker push');
    }
  });

  // TS-7
  it('lets only release:* jobs extend .release', () => {
    for (const [name, lines] of blocks) {
      const extendsRelease = lines.some((line) => /^\s+extends:.*\.release\b/.test(line));

      if (extendsRelease) expect(name.startsWith('release:'), `"${name}" extiende .release`).toBe(true);
    }
  });

  // TS-8
  it('validates version.txt before the registry login, and the login before the build', () => {
    const release = code('release:main');
    const validation = release.indexOf('test -f version.txt');
    const login = release.indexOf('!reference [.release, before_script]');
    const build = release.indexOf('docker build');

    expect(validation).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(validation);
    expect(build).toBeGreaterThan(login);
  });

  // TS-9
  it('logs in without the password on the command line', () => {
    const release = code('.release');

    expect(release).toContain('--password-stdin');
    expect(release).not.toMatch(/docker login[^\n]*\s-p\s/);
  });

  // TS-10
  it('builds both main tags together and pushes the version before :master', () => {
    const release = code('release:main');
    const buildLines = release.split('\n').filter((line) => line.includes('docker build'));

    expect(buildLines).toHaveLength(1);
    expect(buildLines[0]).toContain('-t "$CI_REGISTRY_IMAGE:$VERSION"');
    expect(buildLines[0]).toContain('-t "$CI_REGISTRY_IMAGE:master"');

    const pushVersion = release.indexOf('docker push "$CI_REGISTRY_IMAGE:$VERSION"');
    const pushMaster = release.indexOf('docker push "$CI_REGISTRY_IMAGE:master"');
    expect(pushVersion).toBeGreaterThan(-1);
    expect(pushMaster).toBeGreaterThan(pushVersion);
  });

  // TS-11
  it('publishes only :dev from release:dev', () => {
    const release = code('release:dev');

    expect(release).toContain('docker build --target production');
    expect(release).toContain('docker push "$CI_REGISTRY_IMAGE:dev"');
    expect(release).not.toContain(':master');
    expect(release).not.toContain('$VERSION');
  });

  // TS-12
  it('makes a build failure stop the tests', () => {
    expect(code('test')).toContain('needs: [compile, build-image]');

    const compile = code('compile');
    const install = compile.indexOf('npm ci');
    const typecheck = compile.indexOf('npm run typecheck');
    const build = compile.indexOf('npm run build');
    expect(install).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(install);
    expect(build).toBeGreaterThan(typecheck);

    const image = code('build-image');
    expect(image).toContain('docker build --target production');
    expect(image).not.toContain('docker push');
  });

  // TS-13
  it('lists the CI file and version.txt in the allowlist used by both workflow rules', () => {
    expect(ci).toMatch(/^\.code-changes: &code-changes$/m);
    expect(allowlist(ci)).toEqual([
      'src/**/*',
      'test/**/*',
      'scripts/**/*',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
      'vitest.config.ts',
      'Dockerfile',
      '.dockerignore',
      'version.txt',
      '.gitlab-ci.yml',
    ]);
    expect(code('workflow').match(/changes: \*code-changes/g)).toHaveLength(2);
  });

  // TS-14
  it('orders the workflow rules so dev and main are never suppressed', () => {
    const workflow = code('workflow');
    const tag = workflow.indexOf('if: $CI_COMMIT_TAG');
    const mergeRequest = workflow.indexOf('"merge_request_event"');
    const suppression = workflow.indexOf(
      '$CI_OPEN_MERGE_REQUESTS && $CI_COMMIT_BRANCH !~ /^(dev|main)$/',
    );
    const push = workflow.search(/if: \$CI_PIPELINE_SOURCE == "push"\s*$/m);

    expect(tag).toBeGreaterThan(-1);
    expect(mergeRequest).toBeGreaterThan(tag);
    expect(suppression).toBeGreaterThan(mergeRequest);
    expect(push).toBeGreaterThan(suppression);

    const lines = workflow.split('\n');
    for (const marker of ['if: $CI_COMMIT_TAG', '$CI_OPEN_MERGE_REQUESTS']) {
      const index = lines.findIndex((line) => line.includes(marker));
      expect(lines[index + 1]?.trim(), `la regla "${marker}" va seguida de when: never`).toBe(
        'when: never',
      );
    }
  });

  // TS-15
  it('lets verification be interrupted but never a release, serialized per tag', () => {
    for (const job of ['compile', 'build-image', 'test']) {
      expect(code(job), job).toContain('interruptible: true');
    }
    expect(code('.release')).toContain('interruptible: false');
    expect(code('release:dev')).toContain('resource_group: release-dev');
    expect(code('release:main')).toContain('resource_group: release-main');
  });

  // TS-16
  it('keeps the npm cache under .ci-tmp, outside the build context', () => {
    expect(code('.npm-cache')).toContain('.ci-tmp/npm/');

    for (const job of ['compile', 'test']) {
      const install = code(job)
        .split('\n')
        .find((line) => line.includes('npm ci'));
      expect(install, job).toContain('--cache .ci-tmp/npm');
    }
    expect(withoutComments(ci.split('\n'))).not.toContain('paths: [.npm/]');
  });

  // TS-17
  it('does not read the version from package.json', () => {
    const text = withoutComments(ci.split('\n'));
    const mentions = text.split('\n').filter((line) => line.includes('package.json'));

    expect(mentions.map((line) => line.trim())).toEqual(['- package.json']);
    expect(text).not.toContain('npm pkg get version');
    expect(text).not.toContain('node -p');
  });
});

describe('root entries (rules:changes allowlist)', () => {
  let allowed: string[];
  let rootEntries: string[];

  beforeAll(async () => {
    allowed = allowlist(await readProjectFile('.gitlab-ci.yml'));
    // `readdirSync` y no `git ls-files`: la imagen `node:22-alpine` del job no trae git.
    rootEntries = readdirSync(PROJECT_ROOT);
  });

  // TS-18
  it('classifies every real root entry in exactly one list', () => {
    const result = classifyRootEntries(rootEntries, allowed, EXCLUDED_ROOT_ENTRIES);

    expect(
      result.unclassified,
      `entradas de la raiz sin clasificar: ${result.unclassified.join(', ')}. Agregala a la allowlist de .gitlab-ci.yml o a EXCLUDED_ROOT_ENTRIES`,
    ).toEqual([]);
    expect(
      result.ambiguous,
      `entradas de la raiz en las dos listas: ${result.ambiguous.join(', ')}`,
    ).toEqual([]);
  });

  // TS-19
  it('detects a new root entry that nobody classified', () => {
    expect(
      classifyRootEntries(
        ['src', 'README.md', '.env.local', 'tsconfig.build.json', '.gitlab-ci.yml', 'terraform'],
        ['src/**/*', 'tsconfig*.json', '.gitlab-ci.yml'],
        ['*.md', '.env*'],
      ),
    ).toEqual({ unclassified: ['terraform'], ambiguous: [] });
  });

  // TS-20
  it('detects an exclusion pattern broad enough to swallow the CI file', () => {
    expect(classifyRootEntries(['.gitlab-ci.yml', '.gitignore'], ['.gitlab-ci.yml'], ['.git*'])).toEqual({
      unclassified: [],
      ambiguous: ['.gitlab-ci.yml'],
    });
  });

  // TS-21
  it('keeps everything classified with the CI job .ci-tmp present', () => {
    expect(classifyRootEntries([...rootEntries, '.ci-tmp'], allowed, EXCLUDED_ROOT_ENTRIES)).toEqual({
      unclassified: [],
      ambiguous: [],
    });
  });
});

describe('release:main version validation (executed)', () => {
  let script: string;
  let dir: string | undefined;

  beforeAll(async () => {
    script = versionSnippet(await readProjectFile('.gitlab-ci.yml'));
  });

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * Corre el snippet en un dir temporal con el `version.txt` dado (o sin el). El `echo` final solo
   * corre si el snippet no hizo `exit 1`: es lo que prueba que en los casos de error no se llega a
   * definir una version utilizable. `spawnSync` y no `execFile`, porque casi todos salen con 1.
   */
  async function runWith(content: string | null) {
    dir = await mkdtemp(join(tmpdir(), 'jiku-version-'));
    if (content !== null) await writeFile(join(dir, 'version.txt'), content, 'utf8');

    return spawnSync('sh', ['-c', `${script}\necho "VERSION=$VERSION"`], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  // TS-24
  it('extracts the snippet from the pipeline', () => {
    expect(script).toContain('test -f version.txt');
    expect(script).toContain('grep -Eq');
    expect(script).not.toContain('docker');
  });

  // TS-25, TS-26, TS-27
  it.each([
    ['0.1.0\n', '0.1.0'],
    ['0.1.0\r\n', '0.1.0'],
    ['0.2.0-rc1\n', '0.2.0-rc1'],
  ])('accepts %j as version %s', async (content, version) => {
    const result = await runWith(content);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`VERSION=${version}`);
  });

  // TS-28
  it('fails when version.txt does not exist', async () => {
    const result = await runWith(null);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('version.txt no existe: no se publica nada');
    expect(result.stdout).not.toContain('VERSION=');
  });

  // TS-29
  it('fails when version.txt is empty', async () => {
    const result = await runWith('');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("version.txt no es una version valida: ''");
    expect(result.stdout).not.toContain('VERSION=');
  });

  // TS-30
  it('fails when version.txt holds only whitespace', async () => {
    const result = await runWith('  \n');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no es una version valida: ''");
  });

  // TS-31
  it.each(['dev', 'master', 'latest'])('rejects the moving tag %s as a version', async (value) => {
    const result = await runWith(`${value}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`version.txt no es una version valida: '${value}'`);
  });

  // TS-32
  it.each(['1.2', 'v0.1.0', '0.1'])('rejects the non-semver form %s', async (value) => {
    const result = await runWith(`${value}\n`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('no es una version valida');
  });
});

describe('version.txt', () => {
  let content: string;

  beforeAll(async () => {
    content = await readProjectFile('version.txt');
  });

  // TS-22
  it('holds a single semver line with a trailing newline', () => {
    // La version NO se fija aca: cada release cambia `version.txt`, y un literal convertiria el
    // primer bump en un CI rojo. Lo que se exige es la FORMA: una sola linea semver y su newline.
    const lines = content.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(lines[0]).toMatch(SEMVER);
    expect(content).toBe(`${lines[0]}\n`);
    // A proposito NO se compara con `package.json#version`: son independientes (RF-7).
  });
});

describe('.dockerignore (CI)', () => {
  let raw: string;
  let entries: string[];

  beforeAll(async () => {
    raw = await readProjectFile('.dockerignore');
    entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  });

  // TS-23
  it('excludes the CI temporary directory from the build context', () => {
    expect(entries).toContain('.ci-tmp');

    const comments = raw
      .split('\n')
      .filter((line) => line.trim().startsWith('#'))
      .join('\n')
      .toLowerCase();
    expect(comments).toContain('tmpdir');
  });
});
