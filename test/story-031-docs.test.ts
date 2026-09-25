import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * S-031: verificaciones de CONTENIDO de la documentacion que dejo de decir que el CI/CD esta
 * diferido — no de comportamiento. Lo que el pipeline declara lo verifica `test/gitlab-ci.test.ts`.
 *
 * Mismo criterio que `test/story-029-docs.test.ts`: se ancla por PALABRAS CLAVE ESTRUCTURALES, no
 * por prosa completa, y se aisla la SECCION antes de afirmar, con un caso sanity de longitud para
 * que un `indexOf` fallido no de un falso verde. Lo que estos casos protegen es que BORRAR la
 * seccion, o volver a escribir "diferido", rompa la suite.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${PROJECT_ROOT}/`), 'utf8');
}

/** Desde `heading` hasta el siguiente `\n## `, o hasta el final. `''` si el heading no esta. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) return '';

  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', heading.length);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('README.md documenta el pipeline de CI', () => {
  let readme: string;
  let ci: string;

  beforeAll(async () => {
    readme = await read('README.md');
    ci = section(readme, '## Integración continua');
  });

  // TS-33
  it('sanity: la seccion de CI existe y tiene contenido real', () => {
    expect(readme.indexOf('## Integración continua')).toBeGreaterThan(-1);
    expect(ci.length).toBeGreaterThan(800);
  });

  // TS-33
  it('nombra los tags, la version, dind, la suite completa, los MR y la ADR', () => {
    for (const keyword of [':dev', ':master', 'version.txt', 'dind', 'test:teardown', 'ADR-007']) {
      expect(ci, keyword).toContain(keyword);
    }
    expect(ci).toMatch(/merge request/i);
  });

  // TS-34
  it('ya no dice que el CI esta fuera del alcance del repo', () => {
    expect(readme).not.toContain('fuera del alcance de este repo');
  });
});

describe('overview.md ya no difiere el CI', () => {
  const OVERVIEW = 'docs/architectures/jiku-mail-connector/overview.md';
  let overview: string;
  let deferred: string;

  beforeAll(async () => {
    overview = await read(OVERVIEW);

    const start = overview.indexOf('**Diferido a operaciones:**');
    const rest = start === -1 ? '' : overview.slice(start);
    const end = rest.indexOf('\n\n');
    deferred = end === -1 ? rest : rest.slice(0, end);
  });

  it('sanity: el documento se leyo y el parrafo de diferidos existe', () => {
    expect(overview.length).toBeGreaterThan(5_000);
    expect(deferred.length).toBeGreaterThan(100);
  });

  // TS-35
  it('saca el CI de los diferidos y conserva staging y la rotacion de la key', () => {
    expect(deferred).not.toContain('CI/CD');
    expect(deferred).not.toContain('registry');
    expect(deferred).toContain('staging');
    expect(deferred).toContain('rotacion');
    expect(overview).toContain('REQ-007');
    expect(overview).toContain('ADR-007');
  });
});

describe('docs/prd/architecture.md decide el CI/CD', () => {
  let prd: string;
  let cicd: string;

  beforeAll(async () => {
    prd = await read('docs/prd/architecture.md');

    const start = prd.indexOf('**CI/CD:**');
    const rest = start === -1 ? '' : prd.slice(start);
    const end = rest.indexOf('## Estrategia de Deployment');
    cicd = end === -1 ? rest : rest.slice(0, end);
  });

  it('sanity: el documento se leyo y la seccion de CI/CD existe', () => {
    expect(prd.length).toBeGreaterThan(5_000);
    expect(cicd.length).toBeGreaterThan(200);
  });

  // TS-36
  it('registra la decision: GitLab, los tags, version.txt y la ADR', () => {
    expect(cicd).not.toContain('**Diferido.**');
    for (const keyword of ['GitLab', ':dev', ':master', 'version.txt', 'ADR-007']) {
      expect(cicd, keyword).toContain(keyword);
    }
  });

  // TS-37
  it('actualiza la tabla de diferidos y el bullet de deployment, sin tocar el resto', () => {
    const row = prd.split('\n').find((line) => line.startsWith('| CI/CD'));
    expect(row).toBeDefined();
    expect(row).not.toContain('Pendiente');

    const bullet = prd.split('\n').find((line) => line.includes('**Pendiente de operaciones:**'));
    expect(bullet).toBeDefined();
    const bulletStart = prd.indexOf('**Pendiente de operaciones:**');
    const bulletText = prd.slice(bulletStart, prd.indexOf('\n- ', bulletStart + 1));
    expect(bulletText).not.toContain('Lo mismo el registry de la imagen');

    expect(prd).toContain('Entorno de staging');
    expect(prd).toContain('Rotación de la key');
  });
});

describe('ADR-007 registra el CI y las dos decisiones que no hay que "corregir"', () => {
  let adr: string;

  beforeAll(async () => {
    adr = await read('docs/adrs/ADR-007-ci-gitlab-registry-del-proyecto.md');
  });

  // TS-38
  it('sanity: la ADR existe, esta aceptada y tiene su estructura', () => {
    expect(adr.length).toBeGreaterThan(3_000);
    expect(adr).toContain('**Status:** Accepted');
    expect(adr).toContain('## Implementation Rules');
    expect(adr).toContain('## Alternatives Considered');
  });

  // TS-38
  it('nombra la suite sobre el checkout, la reconstruccion, los tags y lo que sigue diferido', () => {
    for (const keyword of [
      'checkout',
      'reconstru',
      '--target production',
      'dind',
      ':dev',
      ':master',
      'version.txt',
      '--password-stdin',
      'deploy',
    ]) {
      expect(adr, keyword).toContain(keyword);
    }
  });
});
