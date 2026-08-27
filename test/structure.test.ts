import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const BASE_DIRECTORIES = ['src/config', 'src/domain', 'src/infra', 'src/shared'] as const;
const DOMAIN_MODULES = [
  'src/domain/ingesta',
  'src/domain/ruteo',
  'src/domain/publicacion',
] as const;

async function isDirectory(relativePath: string): Promise<boolean> {
  const stats = await stat(new URL(relativePath, `file://${PROJECT_ROOT}`));
  return stats.isDirectory();
}

describe('src/ layout', () => {
  it.each(BASE_DIRECTORIES)('has %s as a directory', async (relativePath) => {
    await expect(isDirectory(relativePath)).resolves.toBe(true);
  });

  it.each(DOMAIN_MODULES)('has the manifest module %s as a directory', async (relativePath) => {
    await expect(isDirectory(relativePath)).resolves.toBe(true);
  });

  it('has an entry point', async () => {
    const stats = await stat(new URL('src/index.ts', `file://${PROJECT_ROOT}`));
    expect(stats.isFile()).toBe(true);
  });
});
