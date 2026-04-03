import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
