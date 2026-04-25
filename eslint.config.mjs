import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import securityPlugin from 'eslint-plugin-security'
import noUnsanitizedPlugin from 'eslint-plugin-no-unsanitized'
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y'

const ignoredPaths = [
  '.git/**',
  '.opencode/**',
  '.venv-docs/**',
  'docs/javascripts/vendor/**',
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
      'jsx-a11y': jsxA11yPlugin,
    },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      // A11y is enforced at the main lint gate now that the backlog
      // is at zero. Rules we've cleaned up across the renderer are
      // errors so regressions fail CI; `pnpm lint:a11y` additionally
      // surfaces the remaining advisory rules (anchor-has-content,
      // alt-text, etc.) where zero-case triggers are worth the noise.
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
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
