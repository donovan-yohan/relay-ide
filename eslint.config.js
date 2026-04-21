import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...sonarjs.configs.recommended,
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    rules: {
      'sonarjs/cognitive-complexity': ['error', 25],
      'sonarjs/no-duplicate-string': ['warn', { threshold: 4 }],
      'sonarjs/max-switch-cases': ['warn', 15],
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    rules: {
      'no-console': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      complexity: ['error', 25],
      'max-depth': ['error', 4],
      'max-params': 'off',
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      '.svelte-kit/',
      '.claude/**',
      '.belayer/**',
      '.git/**',
      '.worktrees/**',
      '*.config.js',
    ],
  },
];
