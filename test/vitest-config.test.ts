import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

describe('vitest.config.ts', () => {
  const test = 'test' in config ? config.test : undefined;

  it('runs the global setup that owns the single NATS container', () => {
    expect(test?.globalSetup).toContain('./test/global-setup.ts');
  });

  it('disables file parallelism, so no two files race over the shared bus', () => {
    expect(test?.fileParallelism).toBe(false);
  });

  it('includes the test files of both src/ and test/', () => {
    expect(test?.include).toEqual(
      expect.arrayContaining(['src/**/*.test.ts', 'test/**/*.test.ts']),
    );
  });

  it('runs in the node environment', () => {
    expect(test?.environment).toBe('node');
  });
});
