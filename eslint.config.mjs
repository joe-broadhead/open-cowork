import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import securityPlugin from 'eslint-plugin-security'
import noUnsanitizedPlugin from 'eslint-plugin-no-unsanitized'
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'

const ignoredPaths = [
  '.git/**',
  '.opencode/**',
  '.venv-docs/**',
  'coverage/**',
  'docs/javascripts/vendor/**',
  '**/dist/**',
  '**/dist-browser/**',
  '**/release/**',
  'node_modules/**',
  'site/**',
]

const tsFiles = ['**/*.ts', '**/*.tsx']
const browserTsFiles = ['packages/app/src/**/*.ts', 'packages/app/src/**/*.tsx']
const desktopLibTsFiles = ['apps/desktop/src/lib/**/*.ts']
const nodeTsFiles = [
  'apps/desktop/src/main/**/*.ts',
  'apps/desktop/src/preload/**/*.ts',
  'apps/desktop/src/lib/**/*.ts',
  'packages/**/*.ts',
  'mcps/**/*.ts',
  'scripts/**/*.ts',
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
      'no-restricted-imports': ['error', {
        paths: [
          'electron',
          'fs',
          'fs/promises',
          'node:fs',
          'node:fs/promises',
          'net',
          'node:net',
          'child_process',
          'node:child_process',
          'os',
          'node:os',
          'process',
          'node:process',
        ],
        patterns: [
          {
            group: [
              '../main/**',
              '../../main/**',
              '../../../main/**',
              'apps/desktop/src/main/**',
              '../preload/**',
              '../../preload/**',
              '../../../preload/**',
              'apps/desktop/src/preload/**',
            ],
            message: 'Renderer code must stay behind the preload bridge and must not import main or preload code.',
          },
        ],
      }],
    },
  },
  {
    files: desktopLibTsFiles,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          'electron',
          'fs',
          'fs/promises',
          'node:fs',
          'node:fs/promises',
          'net',
          'node:net',
          'child_process',
          'node:child_process',
          'os',
          'node:os',
          'process',
          'node:process',
        ],
        patterns: [
          {
            group: [
              '../main/**',
              '../../main/**',
              '../../../main/**',
              'apps/desktop/src/main/**',
              '../preload/**',
              '../../preload/**',
              '../../../preload/**',
              'apps/desktop/src/preload/**',
            ],
            message: 'apps/desktop/src/lib is the pure calculation layer and must not import main or preload code.',
          },
        ],
      }],
      'no-restricted-globals': ['error', 'Date', 'setTimeout', 'setInterval'],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'apps/desktop/src/lib must not read randomness directly.',
        },
        {
          selector: "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
          message: 'apps/desktop/src/lib must not allocate random ids directly.',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'apps/desktop/src/lib must not read environment variables directly.',
        },
      ],
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
      // Vite's root renderer entry writes only the React mount node that it
      // creates from static app code; no user/content input reaches this sink.
      'packages/app/src/index.tsx',
      // MarkdownContent sanitizes streamed markdown through DOMPurify before
      // assigning HTML. The exemption keeps the sanitizer boundary explicit.
      'packages/app/src/components/chat/MarkdownContent.tsx',
      // MermaidChart renders syntax that Mermaid owns after chart spec
      // validation; it does not pass user HTML through directly.
      'packages/app/src/components/chat/MermaidChart.tsx',
    ],
    rules: {
      'no-unsanitized/method': 'off',
      'no-unsanitized/property': 'off',
    },
  },
  {
    // Type-aware async-safety: flag unhandled promises so background work is
    // explicitly awaited or `void`-marked. Scoped to app/package/mcp source +
    // tests (everything already covered by a tsconfig project) so the type
    // service can resolve each file.
    files: [
      'apps/desktop/src/**/*.ts', 'apps/desktop/src/**/*.tsx',
      'apps/gateway/src/**/*.ts', 'apps/standalone-gateway/src/**/*.ts',
      'packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx',
      'mcps/*/src/**/*.ts',
    ],
    // The gateway packages exclude their `*.test.ts` from their tsconfigs
    // (they ship runtime-only dist), so the type service can't resolve those
    // test files. Skip them here; their production source is still covered.
    ignores: [
      'apps/gateway/src/**/*.test.ts',
      'apps/standalone-gateway/src/**/*.test.ts',
      'packages/gateway-*/src/**/*.test.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // React hooks correctness for every renderer surface (desktop renderer +
    // shared UI). rules-of-hooks catches hook-order bugs; exhaustive-deps keeps
    // effect/memo dependency arrays honest.
    files: [
      'packages/app/src/**/*.tsx',
      'packages/ui/src/**/*.tsx',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]
