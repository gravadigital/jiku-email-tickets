import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const src = (segment: string): string => fileURLToPath(new URL(`./src/${segment}/`, import.meta.url));

export default defineConfig({
  // Los prefijos `#` de package.json#imports apuntan a dist/ (runtime). Vitest corre sobre las
  // fuentes, asi que necesita el mismo mapeo hacia src/ — el lado `paths` del tsconfig, que la
  // convencion `module-imports` exige que cubra lo que importa test/. Es el resolver propio del
  // runner: no se agrega ningun paquete de reescritura ni loader ESM (los dos prohibidos).
  resolve: {
    alias: [
      { find: /^#config\/(.*)\.js$/, replacement: `${src('config')}$1.ts` },
      { find: /^#domain\/(.*)\.js$/, replacement: `${src('domain')}$1.ts` },
      { find: /^#infra\/(.*)\.js$/, replacement: `${src('infra')}$1.ts` },
      { find: /^#shared\/(.*)\.js$/, replacement: `${src('shared')}$1.ts` },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'], // 1 NATS para toda la suite
    fileParallelism: false, // secuencial: bus compartido, sin carreras
    testTimeout: 30_000,
  },
});
