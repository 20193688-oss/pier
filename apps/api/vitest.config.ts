import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Nest's dependency injection reads constructor types from decorator metadata,
 * which only SWC (not the default transformer) emits, hence the plugin.
 * `unit` runs pure and service tests; `e2e` boots the HTTP app against a real
 * Postgres (started once in `test/e2e/global-setup.ts`) with a fake chain;
 * `chain` runs the market on a real Stellar network when `E2E_STELLAR` is
 * `testnet` or `local`, and skips otherwise.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: {
      '@test': fileURLToPath(new URL('./test', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          globalSetup: ['test/e2e/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          // E2E_STELLAR=testnet|local: the market on a real Stellar network (slow).
          name: 'chain',
          include: ['test/chain/**/*.test.ts'],
          globalSetup: ['test/e2e/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 1_200_000,
        },
      },
    ],
  },
});
