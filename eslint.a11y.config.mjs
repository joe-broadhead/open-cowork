// Dedicated a11y lint config used by `pnpm lint:a11y`. Surfaces the
// full warning set (click-events-have-key-events, label associations,
// static-element-interactions, etc.) without blocking the main CI
// gate. Roadmap (docs/roadmap.md "Deferred Work") tracks the full
// cleanup; incremental enablement flips rules from this file into
// the main `eslint.config.mjs` as the renderer catches up.

import tsParser from '@typescript-eslint/parser'
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y'

export default [
  {
    ignores: [
      '.git/**',
      '**/dist/**',
      '**/release/**',
      'node_modules/**',
      'site/**',
    ],
  },
  {
    files: ['apps/desktop/src/renderer/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'jsx-a11y': jsxA11yPlugin,
    },
    rules: {
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/label-has-associated-control': 'warn',
      'jsx-a11y/no-autofocus': 'off', // deliberate in our dialogs
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
    },
  },
]
