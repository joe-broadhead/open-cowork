// Dedicated a11y lint config used by `pnpm lint:a11y`. Runs as a
// hard CI gate alongside the main lint step — any new *error* violation
// blocks the PR. The two rules most likely to need judgement
// (click-events-have-key-events, label-has-associated-control) were
// promoted from warn to error after the renderer reached zero
// violations; keeping them at warn risked drift back into tolerated
// noise.
//
// JOE-893 policy (accepted warns — do NOT promote without product review):
// - jsx-a11y/no-noninteractive-element-interactions (warn)
// - jsx-a11y/no-static-element-interactions (warn)
// - jsx-a11y/alt-text, heading-has-content, no-redundant-roles, anchor-* (warn)
// CI does not fail on warns today; `pnpm lint:a11y` remains the gate for errors.
// Unexpected *new error* rules must stay at error. To hard-fail warns, add
// --max-warnings 0 in a dedicated follow-up once the warn set is zero.

import tsParser from '@typescript-eslint/parser'
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

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
    // Both the renderer AND the shared @open-cowork/ui design system are gated: the
    // primitives are the highest-leverage a11y surface, so a violation there must
    // block the PR just like one in the app.
    files: ['packages/app/src/**/*.tsx', 'packages/ui/src/**/*.tsx'],
    // The renderer carries `eslint-disable react-hooks/exhaustive-deps` directives for the MAIN
    // lint config; here that rule is off, so don't flag those directives as unused.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'jsx-a11y': jsxA11yPlugin,
      // Registered (rule off) only so the inline `eslint-disable react-hooks/exhaustive-deps`
      // directives in the chart components resolve — hooks are actually linted by the main config.
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'off',
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      // ignoreNonDOM: a `role` *prop* on a custom component (e.g. CoworkerCard's
      // domain "role") is not an ARIA attribute. DOM `role` attributes — the ones
      // that matter for a11y — are still validated.
      'jsx-a11y/aria-role': ['error', { ignoreNonDOM: true }],
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/label-has-associated-control': ['error', {
        // The design-system field primitives ARE form controls; teach the rule so a
        // `<label><Input/></label>` (or Textarea/Select/Switch) counts as associated.
        controlComponents: ['Input', 'Textarea', 'Select', 'Switch', 'SegmentedControl'],
      }],
      'jsx-a11y/no-autofocus': 'off', // deliberate in our dialogs
      'jsx-a11y/no-noninteractive-element-interactions': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
    },
  },
  {
    // Two design-system surfaces legitimately attach handlers to non-interactive
    // elements with no native HTML equivalent: Tooltip's passive hover/focus anchor
    // (the child keeps the real semantics) and the Kanban column drop target (HTML
    // has no "drop zone" element; the task cards carry keyboard/interaction). Scope
    // the suppression here rather than inline — the MAIN eslint config does not
    // register jsx-a11y for packages/ui, so an inline disable there is an unknown
    // rule. The error-level a11y rules still apply to these files.
    files: ['packages/ui/src/Tooltip.tsx', 'packages/ui/src/ProjectsKanbanSurface.tsx'],
    rules: {
      'jsx-a11y/no-static-element-interactions': 'off',
    },
  },
]
