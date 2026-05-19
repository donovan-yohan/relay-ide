import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...sonarjs.configs.recommended,
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    rules: {
      'sonarjs/cognitive-complexity': ['error', 30],
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
      complexity: ['error', 30],
      'max-depth': ['error', 4],
      'max-params': 'off',
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX trees commonly nest beyond 4 levels — keep the rule but lift cap.
      'max-depth': ['error', 6],
    },
  },
  {
    // Protocol adapters dispatch on broad provider event taxonomies; their
    // notification handlers are inherently switch-heavy. Cap thresholds higher
    // than the project default rather than splitting them artificially.
    files: ['server/protocol-adapters/**/*.ts'],
    rules: {
      complexity: ['error', 40],
      'sonarjs/cognitive-complexity': ['error', 40],
      'sonarjs/max-switch-cases': 'off',
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
      '.agents/**',
      '.chalk/**',
      '.hermes/**',
      'docs/**',
      'relay-ide-tmp/**',
      '*.config.js',
      'test/fixtures/**',
    ],
  },
];
