# Design Tokens

Open Cowork separates color from structure.

The canonical typed token source is
`packages/shared/src/design-tokens.ts`. It exports `DESIGN_TOKENS`,
`DEFAULT_DARK_BRAND_THEME`, `DEFAULT_LIGHT_BRAND_THEME`, and
`emitRootTokensCss()`. The default dark theme is Mercury graphite with the
Azure signature accent; Day is the matching warm light scheme.
Desktop imports the generated CSS partial at
`packages/app/src/styles/generated/design-tokens.css`, produced by
`pnpm design-tokens:build`; Cloud Web emits the same structural variables from
`emitRootTokensCss()` and layers public branding color tokens on top.
`tests/design-tokens-sync.test.ts` drift-gates the generated Desktop partial
against the shared module and the default Cloud Web dark branding theme.

Color tokens stay in the runtime `BrandThemeTokens` and public branding
contracts so downstream themes can vary by brand and color scheme. Structural
tokens are theme invariant and should not be forked by downstream deployments.

## Type

| Token | Size | Line height | Role |
| --- | ---: | ---: | --- |
| `--text-2xs` | 11px | 14px | badges, keyboard hints, dense metadata |
| `--text-xs` | 12px | 16px | secondary labels and compact controls |
| `--text-sm` | 13px | 18px | dense UI default |
| `--text-md` | 14px | 21px | body copy and chat messages |
| `--text-lg` | 16px | 24px | card titles |
| `--text-xl` | 19px | 26px | section headers |
| `--text-2xl` | 24px | 30px | page titles |
| `--text-3xl` | 30px | 36px | large product moments |
| `--text-hero` | 38px | 42px | first-viewport Home greeting |

Tailwind exposes these as `text-*` utilities such as `text-md` and
`text-hero`.

## Space

Spacing uses a 4px base with 6px and 10px avoided unless an existing surface
needs a local exception.

| Token | Value |
| --- | ---: |
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-7` | 28px |
| `--space-8` | 32px |
| `--space-9` | 36px |
| `--space-10` | 40px |
| `--space-12` | 48px |

Tailwind spacing utilities such as `gap-3`, `p-4`, and `mt-6` resolve to this
scale.

## Borders And Elevation

Surfaces use three border tiers so the UI stays crisp across all presets:

| Token | Role |
| --- | --- |
| `--color-border-subtle` | inner dividers, dense list separators |
| `--color-border` | default card, table, input, and panel hairlines |
| `--color-border-strong` | focused, active, selected, or elevated containers |

Cards and panels combine `--shadow-card` with a subtle inset top highlight;
dialogs and popovers reserve `--shadow-elevated`.

The Studio material layer adds physical-material primitives without changing the
active theme palette:

| Token | Role |
| --- | --- |
| `--specular` / `--specular-strong` | 1px inset light lines for elevated or active material surfaces |
| `--shadow-1` | tight contact shadow for small lifted controls |
| `--shadow-2` | alias to the per-theme `--shadow-card` ramp |
| `--shadow-3` | alias to the per-theme `--shadow-elevated` ramp |
| `--glass-bg`, `--glass-blur`, `--glass-border` | floating-surface glass treatment for dialogs, menus, palettes, tooltips, and toasts |
| `--glow-accent`, `--glow-soft` | accent-derived glow for active, streaming, and focus moments |

`--shadow-card` and `--shadow-elevated` remain the canonical per-theme shadow
sources. The `--shadow-2` and `--shadow-3` aliases preserve the character of
all 18 presets while giving component code a consistent three-tier ramp.

## Tracking

Display type uses small negative tracking instead of oversized weight:

| Token | Value | Role |
| --- | ---: | --- |
| `--tracking-tight` | -0.01em | `xl` and `2xl` headings |
| `--tracking-display` | -0.02em | `3xl` and hero headings |

## Shape

| Token | Value | Role |
| --- | ---: | --- |
| `--radius-xs` | 6px | small chips and tight controls |
| `--radius-sm` | 8px | standard buttons and inputs |
| `--radius-md` | 10px | grouped controls |
| `--radius-lg` | 14px | cards and panels |
| `--radius-xl` | 18px | dialogs and hero composer surfaces |
| `--radius-full` | 9999px | pills and circular affordances |

## Motion

Use `--dur-1` for small hover changes, `--dur-2` for panel/toast transitions,
`--dur-3` for larger surface changes, and `--dur-4` for app-shell or hero
surface choreography. `prefers-reduced-motion: reduce` sets all four durations
to `0ms`.

Use `--ease-out` for most interface exits/entries and `--ease-emphasized`
only when a surface needs a clearer snap. Use `--ease-spring` for polished
press, menu, disclosure, and app-shell motion where the movement is short,
GPU-friendly, and reduced-motion safe.

## Layers And Controls

Z-index tokens reserve predictable stacking slots:

| Token | Value | Role |
| --- | ---: | --- |
| `--z-sticky` | 10 | sticky headers |
| `--z-dropdown` | 40 | menus and popovers |
| `--z-overlay` | 50 | page overlays |
| `--z-modal` | 60 | modal dialogs |
| `--z-toast` | 70 | app-shell notifications |
| `--z-command` | 80 | command palette |
| `--z-tooltip` | 90 | tooltips |

Control heights are `--control-h-sm` at 28px, `--control-h-md` at 32px, and
`--control-h-lg` at 40px.

## Studio Semantics

Studio-specific tokens are still presentation tokens. They describe shared
Desktop and Cloud Web UI structure without taking ownership of OpenCode
execution behavior.

| Token family | Role |
| --- | --- |
| `--studio-shell-*` | shared shell, topbar, inspector, composer, and task-lane dimensions |
| `--density-*` | compact, regular, and comfy row padding/gap values for operational surfaces; emitted as `--row-pad` and `--gap` via `:root[data-density]` |
| `--coworker-*` | semantic agent/coworker identity colors for lead, strategist, builder, reviewer, operator, and neutral identities |
| `--lane-*` | planning, delegated, review, approval, and artifact lane colors |
| `--review-*` | proposed, accepted, and blocked review outcome colors |

Use these variables for visual identity and status only. Runtime status,
delegation, approvals, questions, sessions, and tool semantics remain owned by
OpenCode and the existing Open Cowork projection layer.

## Consumers

| Surface | Source path | Contract |
| --- | --- | --- |
| Shared package | `packages/shared/src/design-tokens.ts` | Canonical typed token values, default dark brand theme, public branding bridge, and CSS emitter. |
| Shared React UI | `packages/ui/src/` | Token-backed `WorkbenchLayout`, `ActionCluster`, `DiffView`, Studio shell/coworker/composer/lane/card primitives, production Studio cards/rows/boards/timelines/wizard/wiki primitives, and base primitive components consumed by Desktop and Cloud Web. |
| Desktop | `packages/app/src/styles/generated/design-tokens.css` | Generated `:root` CSS variables imported by `globals.css`; do not hand-edit. |
| Cloud Web | `packages/app/src/styles` (browser build served by `packages/cloud-server/src/browser-renderer-app.ts`) | Cloud Web is the browser build of the renderer, so it ships the same generated `:root` token CSS as Desktop (from `emitRootTokensCss()`), serves Mona Sans / Schibsted Grotesk from `/assets/fonts/*.woff2`, and overlays public branding variables from the cloud bootstrap. There is no separate Cloud Web stylesheet. |
| Drift gate | `tests/design-tokens-sync.test.ts` | Fails when generated Desktop tokens, shared tokens, font package assumptions, or default public branding drift. |

Run `pnpm design-tokens:build` after editing `DESIGN_TOKENS`. CI also runs
`pnpm design-tokens:check` through `pnpm lint`, so stale generated CSS fails
instead of silently drifting.

## Public Branding Theme Keys

`cloud.publicBranding.theme` may override color and visual-brand values only.
The default theme is the Desktop-aligned Mercury graphite palette from
`DEFAULT_DARK_BRAND_THEME`; `DEFAULT_LIGHT_BRAND_THEME` defines the matching
Day warm light palette for presets and downstream full-theme overrides. Legacy
light partial overrides remain supported for existing deployments.

Supported keys are:

`background`, `surface`, `mutedSurface`, `border`, `text`, `mutedText`,
`accent`, `accent2`, `accentSoft`, `accentLine`, `accentStrong`, `focus`,
`warn`, `danger`, `ok`, `surfaceHover`, `surfaceActive`, `borderSubtle`,
`borderStrong`, `elevated`, `textSecondary`, `accentHover`,
`accentForeground`, `green`, `amber`, `red`, `info`, `shadowCard`,
`shadowElevated`, and `bgImage`.

Downstream builders should override only the color/brand keys they own and let
the shared structural tokens continue to define layout density, control heights,
radii, typography scale, shadows, glass, glow, and motion. Do not reintroduce
Cloud Web-only spacing or typography scales.
