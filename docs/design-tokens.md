# Design Tokens

Open Cowork separates color from structure.

Color tokens stay in the runtime `BrandThemeTokens` contract so downstream
themes can vary by brand and color scheme. Structural tokens are theme
invariant and live in `apps/desktop/src/renderer/styles/globals.css`.

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
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |

Tailwind spacing utilities such as `gap-3`, `p-4`, and `mt-6` resolve to this
scale.

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
and `--dur-3` for larger surface changes. `prefers-reduced-motion: reduce`
sets all three durations to `0ms`.

Use `--ease-out` for most interface exits/entries and `--ease-emphasized`
only when a surface needs a clearer snap.

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
