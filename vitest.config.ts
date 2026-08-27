import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'], // 1 NATS para toda la suite
    fileParallelism: false, // secuencial: bus compartido, sin carreras
    testTimeout: 30_000,
  },
});
