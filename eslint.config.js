import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

const svelteRunes = {
  $state: 'readonly',
  $derived: 'readonly',
  $effect: 'readonly',
  $props: 'readonly',
  $bindable: 'readonly',
  $inspect: 'readonly',
};

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
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
    files: ['frontend/src/**/*.svelte.ts'],
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...svelteRunes,
      },
      parserOptions: {
        extraFileExtensions: ['.svelte.ts'],
      },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      'no-console': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['off'],
      complexity: ['error', 20],
      'max-depth': ['error', 4],
      'max-params': 'off',
      'svelte/valid-compile': 'error',
      'svelte/no-at-html-tags': 'error',
      'svelte/prefer-svelte-reactivity': 'warn',
      'svelte/require-each-key': 'warn',
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
      '*.config.js',
    ],
  },
];
