import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@scripts': fileURLToPath(new URL('./scripts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The artifact check runs a release build of the contract.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
