# Design System

Open Cowork uses a small, enforceable design system so UI work stays consistent across themes, downstream branding, and accessibility gates.

## Tokens

Canonical structural tokens live in
`packages/shared/src/design-tokens.ts` and are documented in
[Design Tokens](design-tokens.md). Desktop imports the generated CSS variables
from `packages/app/src/styles/generated/design-tokens.css`; Cloud Web
is the browser build of the same renderer, so it ships the same structural
`:root` block (also produced by `emitRootTokensCss()` for the cloud shell).
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
`--glass-*`, `--glow-*`, the solid 2px accent `--ring-focus`, and `--dur-4`. It also
defines shared Studio semantics such as `--studio-shell-*`, `--density-*`,
`--coworker-*`, `--lane-*`, and `--review-*`. These tokens are derived from the
active theme and must be consumed from shared CSS variables rather than
duplicated per app.

Avoid adding new Tailwind arbitrary font-size utilities such as `text-[13px]`. `pnpm lint` ratchets the existing renderer count and fails if the count increases.

## Token Tiers

The design system is layered in three tiers. Work flows downward; a change at a
lower tier re-skins everything above it without editing the higher tiers.

1. **Primitive** — raw literal values, single-sourced in the token layer. The
   accent presets in `DESIGN_ACCENT_PRESETS`, the base/surface/border/text hexes
   in `DEFAULT_DARK_BRAND_THEME` / `DEFAULT_LIGHT_BRAND_THEME`, and the
   categorical data-viz palettes (`KNOWLEDGE_SPACE_HUES` in
   `packages/ui/src/knowledge-hues.ts`, `ENTITY_HUES` in
   `packages/ui/src/utils.ts`) are primitives. Only this tier holds literal
   colors.
2. **Semantic** — themeable CSS custom properties emitted from the token layer by
   `emitRootTokensCss()` (`--color-*`, `--space-*`, `--radius-*`, `--dur-*`,
   `--ease-*`, `--z-*`, `--shadow-*`, `--studio-*`, …). These are theme-invariant
   in structure and brand-variable in color. Consumers read these variables; they
   never read primitives directly.
3. **Component** — `packages/ui/src` React components and their CSS-in-TS
   (`surface-styles.ts` barrel + `packages/ui/src/styles/*-surface.ts` domains),
   plus the renderer classes in `packages/app/src/styles/globals.css` (entry)
   and `packages/app/src/styles/domains/{base,shell,studio,chat,settings}.css`.
   Component code consumes semantic tokens only.

### Style module ownership (JOE-851)

| Module | Owns |
| --- | --- |
| `packages/ui/src/styles/controls-surface.ts` | Input/select/menu/segmented/button control chrome |
| `packages/ui/src/styles/primitives-surface.ts` | Empty/skeleton/card primitives |
| `packages/ui/src/styles/*-surface.ts` (artifacts, approvals, wiki, channels, projects, knowledge) | Named Studio product surfaces |
| `packages/ui/src/styles/shared-keyframes.ts` | Cross-app keyframes |
| `packages/ui/src/surface-styles.ts` | Aggregate `studioSurfaceStyles()` barrel |
| `packages/app/src/styles/domains/base.css` | Fonts, `@theme`, type roles, focus/scroll/drag |
| `packages/app/src/styles/domains/shell.css` | Title bar, sidebar active nav, app chrome |
| `packages/app/src/styles/domains/studio.css` | App-local Studio shell/card language |
| `packages/app/src/styles/domains/chat.css` | Chat approval, thinking, workbench, markdown |
| `packages/app/src/styles/domains/settings.css` | Settings section rail/list |
| `packages/app/src/styles/globals.css` | Single renderer entry (`@import` domains) |

**Semantic-tokens-only guard.** `scripts/check-design-token-usage.mjs` (run by
`pnpm lint`) fails if Tier-3 component code in `packages/ui/src` hardcodes a raw
hex, `rgb()`, or `hsl()` color literal instead of a token, and additionally
ratchets `packages/app/src` — its raw-color count may not rise above the pinned
baseline, so new drift is blocked while the legacy count is migrated down. Pure ink/white
(`#fff` / `#000`) inside `color-mix()` material math is allowed because there is
no semantic token for pure black or white, and the two primitive palette files
above are allowlisted by path. See the script header for the exact scoping. This
keeps a downstream retint (see [Design Tokens → Retint in 5 minutes](design-tokens.md#retint-in-5-minutes))
a pure token override with no component edits.

## Primitives

Shared React primitives live in `packages/ui` and are exported as the private
workspace package `@open-cowork/ui`. Desktop no longer keeps a private UI
barrel; app-local UI files are explicit wrappers/tests only, and new primitive
work should happen in the package:

- `Button` and `IconButton` for actions. `IconButton` requires a `label` prop; `pnpm lint` fails if a usage omits it.
- `Input`, `Select`, and `SegmentedControl` for form controls.
- `Dialog`, `Card`, `Badge`, `EmptyState`, `Skeleton`, `Tooltip`, and `Toaster` for common surfaces and feedback.
- `Icon` wraps Lucide icons so stroke, sizing, and naming stay consistent.
- `WorkbenchLayout`, `ActionCluster`, and `DiffView` for the shared
  workflow IA: threads/context, active conversation, top-right actions, and
  review-first artifacts/diffs.
- Studio product language primitives (see **Studio adoption map** below). These
  are presentational only; OpenCode still owns execution, sessions, child
  sessions, approvals, questions, and tool semantics.

Prefer these primitives before adding component-local button, input, badge, skeleton, or modal markup.

## Studio adoption map

Decision (**JOE-854**): **adopt for high-traffic production surfaces; demote
gallery-only primitives** so the dual-stack is intentional rather than half-
finished. Production Team/chat/domain components may wrap Studio shells; they
must not reimplement a second visual system.

| Primitive / surface | Status | Production owner |
| --- | --- | --- |
| `ApprovalCard` (`@open-cowork/ui`) | **Adopted — shared base** | Presentational shell used by Approvals queue (`ApprovalsQueueSurface`) and by chat `packages/app/.../chat/ApprovalCard.tsx` (product logic + IPC). No second card chrome. |
| `ApprovalsQueueSurface` / `ArtifactsLibrarySurface` / `ChannelsGatewaySurface` / `ProjectsKanbanSurface` | **Adopted** | Studio utility pages in `packages/app/src/components/studio/` and Projects board. |
| `ReviewPanel`, `TaskLane`, `DiffView` | **Adopted** | Session inspector, Home review snapshot, chat diff controller. |
| `StudioPageHeader` | **Adopted** | Studio utility pages. |
| `AgentCapabilityProfileView` | **Adopted** | Agent builder / Team capability profile. |
| `CoworkerCard`, `CoworkerAvatar` | **Adopted for list/preview** | Team/list browse cards and gallery. **Agent builder** keeps app-local `AgentCard` (identity form + capability profile) — domain form, not a second card language. |
| `StudioShell`, `ComposerShell` | **Demoted (gallery / future shell)** | Catalog at `#/ui-primitives` and future shell work. Production chrome remains app `Sidebar` + workbench layout until a full shell migration. |
| `PermissionEditorRow` | **Demoted (gallery)** | Gallery + future Agent permissions polish. Production `AgentPermissionEditor` owns the form model today. |
| `StudioArtifactCard` / `DeliverableCard` / `Kanban*` / `ConversationLaneCard` / `RunTimeline` / wizard + wiki primitives | **Adopted where surfaces exist; otherwise gallery** | Prefer these before new app-local cards when wiring a surface. |

When adding a new Studio-looking control, extend `@open-cowork/ui` first, then
compose product state in `packages/app`. Do not ship a parallel ApprovalCard,
Diff chrome, or empty-state without a documented exception in this map.

`packages/ui/src/index.ts` is the single import surface for the package: every
primitive, surface, hook, and helper is re-exported there, so consumers import
from `@open-cowork/ui` and never reach into deep paths. `PrimitiveGallery`
marks each section with `data-gallery-maturity` of **production** (adopted in the
shipping shell) or **experimental** (Studio/design fiction — not product chrome
until an adopt decision). Contributors must not treat experimental gallery demos
as shipped UX.

`PrimitiveGallery`
renders the catalog live at `#/ui-primitives` on both Desktop and Cloud Web.

## Component Catalog

Core primitives and the primary semantic tokens they consume. Interaction states
(`:hover`, `:active`, `:focus-visible`, `:disabled` / `aria-disabled`) are styled
on the shared classes in `packages/app/src/styles/globals.css` and
`packages/ui/src/surface-styles.ts`; every focusable primitive picks up the
global `*:focus-visible` accent outline plus its own state styling.

| Primitive | Role | Key semantic tokens |
| --- | --- | --- |
| `Button` / `IconButton` | actions | `--accent-action-fill`, `--accent-action-foreground`, `--radius-sm`, `--control-h-*`, `--ring-focus`, `--dur-1`/`--ease-out` |
| `Input` / `Textarea` | text entry | `--color-surface`, `--color-border`, `--color-border-strong`, `--control-h-*`, `--ring-focus` |
| `Select` / `Menu` | choice + popover | `--glass-bg`, `--glass-border`, `--z-dropdown`, `--shadow-3`, `--radius-md` |
| `SegmentedControl` / `Switch` | toggles | `--color-surface-active`, `--color-accent`, `--control-h-*`, `--dur-1` |
| `Card` | container surface | `--color-surface`, `--color-border`, `--shadow-card`, `--specular`, `--radius-lg` |
| `Dialog` | modal / drawer | `--z-modal`, `--glass-bg`, `--shadow-elevated`, `--primitive-dialog-*`, focus trap |
| `Tooltip` | hover hint | `--z-tooltip`, `--glass-bg`, `--primitive-tooltip-max-w` |
| `Toaster` / `toast` | transient feedback | `--z-toast`, `--color-green`/`--color-amber`/`--color-red`, `--shadow-elevated` |
| `Badge` | inline status pill | `--color-green`/`--color-amber`/`--color-red`/`--color-info`, cooled `--chip-*`, `--radius-full` |
| `EmptyState` / `Skeleton` | placeholders | `--color-text-secondary`, `--color-surface`, `--radius-lg`, `--dur-2` |
| `Icon` / `Kbd` | glyph + hint | `--icon-size-*`, `--text-2xs`, `--color-text-secondary` |
| `WorkbenchLayout` / `ActionCluster` / `DiffView` | workflow IA | `--studio-*`, `--color-border-subtle`, `--z-sticky` |
| Studio cards/rows/lanes (`CoworkerCard`, `TaskLane`, `KanbanBoard`, `ReviewPanel`, …) | Studio product language | `--coworker-*`, `--lane-*`, `--review-*`, `--density-*` |

### Diff ownership (JOE-847)

| Layer | Module | Role |
| --- | --- | --- |
| Presentational shell | `@open-cowork/ui` `DiffView` | Shared review chrome (`data-diff-view`), header, file list hooks, empty state. Used by SessionInspector and every DiffViewer path. |
| Session controller | `packages/app/.../chat/DiffViewer` | Loads `session.diff`, view-mode toggle, expand/collapse rows (`DiffViewerRows`). Always wraps content in `DiffView` (modal + embedded). |
| Row/patch rendering | `DiffViewerRows` / `DiffViewerRowBlocks` | Unified/split hunk UI for a single file. |

Do not introduce a second top-level diff chrome. New review UIs compose `DiffView` and optionally the DiffViewer controller.

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
`data-diff-view="true"`. The renderer styles these classes once in
`packages/app/src/styles/globals.css` for both Desktop and Cloud Web.
Keep future chat, artifact, and review affordances on those shared hooks.

Cloud Web is the browser build of the unified renderer
(`packages/app/src`), served by the cloud at `GET /`. In the browser
the renderer runs against a typed `CoworkAPI` shim
(`packages/app/src/browser/cowork-api.ts`) backed by the cloud HTTP +
SSE API; on Electron the same renderer runs against the preload IPC bridge.
Auth bootstrap, routing, threads, chat, agents, capabilities, workflows,
artifacts, admin/settings surfaces, and theme switching all live in the single
renderer. New feature code should use the shared `CoworkAPI` contract
(`packages/shared/src`) through the renderer's browser client
`packages/app/src/browser/cowork-api.ts` instead of direct `fetch`,
`EventSource`, or `window.coworkApi` access.

The production visual QA contract for shared Studio surfaces is documented in
[Cloud Web Studio](cloud-web-workbench.md). Because Desktop and Cloud Web are
the same renderer, the visual language, product vocabulary, and primitive usage
are shared by construction; the contract verifies the browser shim's boundaries
and responsive layout while OpenCode still owns execution.

## Accessibility Gates

CI runs `pnpm lint:a11y --max-warnings=0` and the focused renderer accessibility smoke tests. The smoke helper explicitly enables axe `color-contrast`, so contrast regressions are part of the required test gate. `pnpm lint:a11y --max-warnings=0` is a blocking job in `.github/workflows/ci.yml` (and `release.yml`), so any `jsx-a11y` warning fails the build.

### AA baseline

The product targets WCAG 2.1/2.2 AA. Shared primitives ship these guarantees so
feature code inherits them:

- **Focus visibility.** A global `*:focus-visible` rule paints a 1px accent
  outline; `--ring-focus` is a solid, fully-opaque 2px accent ring (a
  semi-transparent ring failed SC 1.4.11), so keyboard focus stays visible on
  every surface.
- **Roles and labels.** `IconButton` requires a `label` prop (enforced by
  `pnpm lint`); command-style pickers expose `role="listbox"` / `role="option"`
  with `aria-controls` + `aria-activedescendant` on the search input.
- **Focus trap in overlays.** `Dialog`, `Select`, and `Menu` use
  `useFocusTrap`, which traps Tab, restores focus on close, and closes on
  `Escape`.
- **Target size.** Interactive controls size to the `--control-h-*` scale
  (24–48px); primary touch targets use `--control-h-lg` (40px) / `--control-h-xl`
  (48px) to meet the 44px AA target-size guidance.
- **Contrast.** Accent action fills are computed to clear 4.5:1 against their own
  gradient (see `accentActionPlanForColors`), and the axe `color-contrast` rule
  is enabled in the required smoke tests.

Command-style pickers should expose the result list as `role="listbox"` with `role="option"` rows. Search inputs should remain search/text inputs and point at the listbox with `aria-controls` and `aria-activedescendant`; do not model these as a combobox unless the input itself owns a popup value.

## Motion

Motion durations are tokenized as `--dur-1`, `--dur-2`, `--dur-3`, and `--dur-4`. Global CSS collapses transitions, animations, and smooth scrolling under `prefers-reduced-motion: reduce`, including inline transition styles. Renderer tests cover reduced-motion scrolling for chat source jumps.

When adding JavaScript-driven motion, check `window.matchMedia('(prefers-reduced-motion: reduce)')` and provide an instant path.
