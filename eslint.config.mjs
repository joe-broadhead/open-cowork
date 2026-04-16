import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import securityPlugin from 'eslint-plugin-security'
import noUnsanitizedPlugin from 'eslint-plugin-no-unsanitized'

const ignoredPaths = [
  '.git/**',
  '.opencode/**',
  '.venv-docs/**',
  '**/dist/**',
  '**/release/**',
  'node_modules/**',
  'site/**',
]

const tsFiles = ['**/*.ts', '**/*.tsx']
const browserTsFiles = ['apps/desktop/src/renderer/**/*.ts', 'apps/desktop/src/renderer/**/*.tsx']
const nodeTsFiles = [
  'apps/desktop/src/main/**/*.ts',
  'apps/desktop/src/preload/**/*.ts',
  'apps/desktop/src/lib/**/*.ts',
  'packages/**/*.ts',
  'mcps/**/*.ts',
  'scripts/**/*.ts',
  'tests/**/*.ts',
]
const jsFiles = ['**/*.js', '**/*.mjs']

export default [
  {
    ignores: ignoredPaths,
  },
  js.configs.recommended,
  {
    files: tsFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      security: securityPlugin,
    },
    rules: {
      'no-redeclare': 'off',
      'no-shadow': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
    },
  },
  {
    files: jsFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      security: securityPlugin,
    },
    rules: {
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
    },
  },
  {
    files: browserTsFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'no-unsanitized': noUnsanitizedPlugin,
    },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    files: nodeTsFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: [
      'apps/desktop/src/renderer/index.tsx',
      'apps/desktop/src/renderer/components/chat/MarkdownContent.tsx',
      'apps/desktop/src/renderer/components/chat/MermaidChart.tsx',
    ],
    rules: {
      'no-unsanitized/method': 'off',
      'no-unsanitized/property': 'off',
    },
  },
]
