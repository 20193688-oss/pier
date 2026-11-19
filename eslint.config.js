// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * One ESLint config for every workspace. The rule that matters most here:
 * no dot-relative imports in source or tests (AGENTS.md), so every module is
 * reached through its package's `@/` alias or another package's name.
 */
const noRelativeImports = {
  patterns: [
    {
      regex: String.raw`^\.{1,2}(?:/|$)`,
      message: 'Import through the `@/` alias (or a package name), never a relative path.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      'apps/web/**',
      '.dev-stack/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['**/src/**/*.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', noRelativeImports],
    },
  },
  prettier,
);
