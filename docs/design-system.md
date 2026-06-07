# Design System

Open Cowork uses a small, enforceable design system so UI work stays consistent across themes, downstream branding, and accessibility gates.

## Tokens

Canonical structural tokens live in
`packages/shared/src/design-tokens.ts` and are documented in
[Design Tokens](design-tokens.md). Desktop imports the generated CSS variables
from `apps/desktop/src/renderer/styles/generated/design-tokens.css`; Cloud Web
emits the same structural `:root` block from `emitRootTokensCss()` in its
server-rendered shell while the Vite React client scaffold comes online.
`pnpm design-tokens:build`
updates the generated Desktop partial, and `tests/design-tokens-sync.test.ts`
drift-gates it against the shared module, the default dark public branding
theme, and the Cloud Web font package assumptions.

Use the token-backed classes and CSS variables for type, spacing, radius,
motion, elevation, and content measures. Theme color values stay inside the
`BrandThemeTokens` / public branding contract so downstream themes can change
color without forking layout. Borders use three tiers:
`--color-border-subtle` for dividers, `--color-border` for default hairlines,
and `--color-border-strong` for focused, active, or elevated containers.
The Studio material layer extends the same token source with material and
motion primitives: `--specular`, `--shadow-1` / `--shadow-2` / `--shadow-3`,
`--glass-*`, `--glow-*`, the glowing `--ring-focus`, and `--dur-4`. It also
defines shared Studio semantics such as `--studio-shell-*`, `--density-*`,
`--coworker-*`, `--lane-*`, and `--review-*`. These tokens are derived from the
active theme and must be consumed from shared CSS variables rather than
duplicated per app.

Avoid adding new Tailwind arbitrary font-size utilities such as `text-[13px]`. `pnpm lint` ratchets the existing renderer count and fails if the count increases.

## Primitives

Shared React primitives live in `packages/ui` and are exported as the private
workspace package `@open-cowork/ui`. Desktop keeps compatibility re-export
shims in `apps/desktop/src/renderer/components/ui/`, but new primitive work
should happen in the package:

- `Button` and `IconButton` for actions. `IconButton` requires a `label` prop; `pnpm lint` fails if a usage omits it.
- `Input`, `Select`, and `SegmentedControl` for form controls.
- `Dialog`, `Card`, `Badge`, `EmptyState`, `Skeleton`, `Tooltip`, and `Toaster` for common surfaces and feedback.
- `Icon` wraps Lucide icons so stroke, sizing, and naming stay consistent.
- `WorkbenchLayout`, `ActionCluster`, and `DiffView` for the shared
  workflow IA: threads/context, active conversation, top-right actions, and
  review-first artifacts/diffs.
- `StudioShell`, `StudioPageHeader`, `CoworkerAvatar`, `CoworkerCard`,
  `ComposerShell`, `TaskLane`, `ReviewPanel`, `ApprovalCard`, `ArtifactCard`,
  `ProjectCard`, and `ChannelStatusCard` for the new Studio product language.
  These are presentational primitives only; OpenCode still owns execution,
  sessions, child sessions, approvals, questions, and tool semantics.

Prefer these primitives before adding component-local button, input, badge, skeleton, or modal markup.

## Agent Builder

The Agent Builder summary uses the shared deterministic capability profile:
`computeAgentCapabilityProfile()` in
`packages/shared/src/agent-capability-profile.ts` and
`AgentCapabilityProfileView` in `packages/ui`. The five axes are Reach
(selected tools), Skills (selected skills), Context (provider-reported model
context window), Autonomy (max steps), and Precision (temperature). The score
is the weighted rollup from the Mercury prototype; it must stay pure,
provider-agnostic, and free of model-name hardcoding.

Model selection is provider-aware but persistence is unchanged. The builder
reads `config.providers.available`, shows connected state and catalog metadata,
uses `app.refreshProviderCatalog(providerId)` for live refreshes, and keeps the
advanced free-text model ID fallback for power users and uncataloged models.

Desktop and Cloud Web both expose the same workbench structure through
`data-workbench-pane="threads"`, `data-workbench-pane="conversation"`,
`data-workbench-pane="review"`, `data-action-cluster="true"`, and
`data-diff-view="true"`. Desktop styles these classes in
`apps/desktop/src/renderer/styles/globals.css`; Cloud Web styles the same
contract in `apps/website/src/style-shared-ui.ts`. Keep future chat,
artifact, and review affordances on those shared hooks so the two surfaces do
not drift.

Cloud Web has a React SSR/controller scaffold at
`apps/website/src/react-client.tsx`, `apps/website/src/react-shell.ts`, and
`apps/website/src/react-shell-controller.tsx`. It mounts a React controller for
`#open-cowork-cloud-react-root`, uses `@open-cowork/ui/app-api` for the shared
provider/hook, and uses `apps/website/src/app-api.ts` as the Cloud fetch/SSE
adapter. Auth bootstrap, routing, threads, chat, agents, capabilities,
workflows, artifacts, admin/settings surfaces, and Cloud theme switching are
React-owned; the old vanilla feature-script directory has been retired. New
React feature code should use `useAppApi()` instead of direct `fetch`,
`EventSource`, or `window.coworkApi` access.

## Accessibility Gates

CI runs `pnpm lint:a11y --max-warnings=0` and the focused renderer accessibility smoke tests. The smoke helper explicitly enables axe `color-contrast`, so contrast regressions are part of the required test gate.

Command-style pickers should expose the result list as `role="listbox"` with `role="option"` rows. Search inputs should remain search/text inputs and point at the listbox with `aria-controls` and `aria-activedescendant`; do not model these as a combobox unless the input itself owns a popup value.

## Motion

Motion durations are tokenized as `--dur-1`, `--dur-2`, `--dur-3`, and `--dur-4`. Global CSS collapses transitions, animations, and smooth scrolling under `prefers-reduced-motion: reduce`, including inline transition styles. Renderer tests cover reduced-motion scrolling for chat source jumps.

When adding JavaScript-driven motion, check `window.matchMedia('(prefers-reduced-motion: reduce)')` and provide an instant path.
