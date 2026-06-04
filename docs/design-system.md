# Design System

Open Cowork uses a small, enforceable design system so UI work stays consistent across themes, downstream branding, and accessibility gates.

## Tokens

Canonical structural tokens live in
`packages/shared/src/design-tokens.ts` and are documented in
[Design Tokens](design-tokens.md). Desktop keeps the matching CSS variables in
`apps/desktop/src/renderer/styles/globals.css`; Cloud Web emits the same
structural `:root` block from `emitRootTokensCss()` while staying a zero-build,
inline HTML Cloud API client. `tests/design-tokens-sync.test.ts` drift-gates the
shared module against Desktop globals, the default dark public branding theme,
and the Cloud Web font package assumptions.

Use the token-backed classes and CSS variables for type, spacing, radius,
motion, elevation, and content measures. Theme color values stay inside the
`BrandThemeTokens` / public branding contract so downstream themes can change
color without forking layout.

Avoid adding new Tailwind arbitrary font-size utilities such as `text-[13px]`. `pnpm lint` ratchets the existing renderer count and fails if the count increases.

## Primitives

Shared renderer primitives live in `apps/desktop/src/renderer/components/ui/`:

- `Button` and `IconButton` for actions. `IconButton` requires a `label` prop; `pnpm lint` fails if a usage omits it.
- `Input`, `Select`, and `SegmentedControl` for form controls.
- `Dialog`, `Card`, `Badge`, `EmptyState`, `Skeleton`, `Tooltip`, and `Toaster` for common surfaces and feedback.
- `Icon` wraps Lucide icons so stroke, sizing, and naming stay consistent.

Prefer these primitives before adding component-local button, input, badge, skeleton, or modal markup.

Cloud Web does not import the Desktop React primitive library, but it must match
the same product vocabulary in CSS and markup: shell/sidebar/topbar, cards,
buttons, icon-sized controls, inputs, badges, notices, empty states, tables,
chat bubbles, runtime cards, and admin surface cards. The route/API,
workbench-parity, admin-surface, browser, accessibility, and performance tests
are the Cloud Web guardrail for that non-React implementation.

## Accessibility Gates

CI runs `pnpm lint:a11y --max-warnings=0` and the focused renderer accessibility smoke tests. The smoke helper explicitly enables axe `color-contrast`, so contrast regressions are part of the required test gate.

Command-style pickers should expose the result list as `role="listbox"` with `role="option"` rows. Search inputs should remain search/text inputs and point at the listbox with `aria-controls` and `aria-activedescendant`; do not model these as a combobox unless the input itself owns a popup value.

## Motion

Motion durations are tokenized as `--dur-1`, `--dur-2`, and `--dur-3`. Global CSS collapses transitions, animations, and smooth scrolling under `prefers-reduced-motion: reduce`, including inline transition styles. Renderer tests cover reduced-motion scrolling for chat source jumps.

When adding JavaScript-driven motion, check `window.matchMedia('(prefers-reduced-motion: reduce)')` and provide an instant path.
