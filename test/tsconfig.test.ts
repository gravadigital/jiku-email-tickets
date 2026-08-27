import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

type EffectiveConfig = {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
};

// --showConfig resolves `extends` and strips comments: it verifies the *effective*
// configuration, which is what the compiler actually applies.
async function showConfig(project: string): Promise<EffectiveConfig> {
  const { stdout } = await execFileAsync('npx', ['tsc', '--showConfig', '-p', project], {
    cwd: PROJECT_ROOT,
  });
  return JSON.parse(stdout) as EffectiveConfig;
}

describe('tsconfig.json', () => {
  let effective: EffectiveConfig;

  beforeAll(async () => {
    effective = await showConfig('tsconfig.json');
  }, 60_000);

  it('enables strict', () => {
    expect(effective.compilerOptions?.strict).toBe(true);
  });

  it('enables noUncheckedIndexedAccess', () => {
    expect(effective.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
  });

  it('targets ES2022 or newer', () => {
    const target = String(effective.compilerOptions?.target).toLowerCase();
    const year = Number(target.replace('es', ''));
    expect(year).toBeGreaterThanOrEqual(2022);
  });

  it('resolves modules the way node ESM does, so the SDK conditional exports load', () => {
    expect(String(effective.compilerOptions?.moduleResolution).toLowerCase()).toBe('nodenext');
  });

  it('maps the four subpath prefixes to src for compilation', () => {
    expect(effective.compilerOptions?.paths).toEqual({
      '#config/*': ['./src/config/*'],
      '#domain/*': ['./src/domain/*'],
      '#infra/*': ['./src/infra/*'],
      '#shared/*': ['./src/shared/*'],
    });
  });

  it('covers src/ and test/ so the tests typecheck under the same flags', () => {
    expect(effective.include).toEqual(
      expect.arrayContaining(['src/**/*.ts', 'test/**/*.ts']),
    );
  });
});

describe('tsconfig.build.json', () => {
  let effective: EffectiveConfig;

  beforeAll(async () => {
    effective = await showConfig('tsconfig.build.json');
  }, 60_000);

  it('emits to dist from src', () => {
    expect(String(effective.compilerOptions?.outDir)).toMatch(/dist$/);
    expect(String(effective.compilerOptions?.rootDir)).toMatch(/src$/);
  });

  it('inherits strict and noUncheckedIndexedAccess from the base config', () => {
    expect(effective.compilerOptions?.strict).toBe(true);
    expect(effective.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
  });

  it('keeps the tests out of the emitted output', () => {
    expect(effective.include).toEqual(['src/**/*.ts']);
  });
});
