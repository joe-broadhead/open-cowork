# Frontend Architecture

The renderer (`packages/app`) and the shared UI kit (`packages/ui`) power every
Open Cowork surface — the desktop app, the cloud web workbench, and the chart
frame. Because the same React tree ships to all of them, the frontend keeps a
deliberate layering so features stay composable, bundles stay tree-shakeable,
and module initialization order stays predictable.

This page documents the intended layers, the "core imports nothing upward"
rule, and the two automated guardrails that keep the architecture from eroding:
the **import-cycle gate** and the **renderer file-size budgets**.

## Layers

The renderer is organized as a stack. Each layer may import from the layers
**below** it, never from the layers **above** it.

| Layer | Location | Responsibility |
| --- | --- | --- |
| **App shell** | `packages/app/src/App.tsx`, `index.tsx`, `browser/` | Boots the tree, wires routing, mounts feature domains. |
| **Feature domains** | `packages/app/src/components/*` (chat, agents, threads, studio, capabilities, …) | Self-contained product features. Domains do not import one another's internals. |
| **Design system** | `packages/ui/src` | Framework-aware but product-agnostic primitives: `Button`, `Card`, `Dialog`, `IconButton`, studio primitives. |
| **Infra** | `packages/app/src/lib`, `stores/`, `hooks/`, `browser/cowork-api.ts` | Cross-cutting runtime concerns: state stores, the cloud/desktop API bridge, transport. |
| **Framework-agnostic core** | `packages/app/src/helpers/*`, `app-types.ts`, and `@open-cowork/shared` | Pure functions, types, formatting, and policy helpers with **no React and no upward imports**. |

### The "core imports nothing upward" rule

The framework-agnostic core (`helpers/`, `app-types.ts`, and `@open-cowork/shared`)
must never import from feature domains, stores, the design system, or the app
shell. Core code is the leaf of the dependency graph: it can be reused, unit
tested in isolation, and bundled without pulling React into a plain utility.

If a helper needs something from a higher layer, that is a signal the value
belongs to the caller — pass it in as an argument rather than reaching upward.

## Guardrail: import-cycle gate

Circular import chains are the most common cause of fragile initialization
order (`Cannot access 'X' before initialization`), un-tree-shakeable bundles,
and confusing refactors. `scripts/check-import-cycles.mjs` statically scans the
first-party **relative** imports inside `packages/app/src` and `packages/ui/src`
and fails if any circular chain exists. The current cycle count is **zero** and
the gate keeps it there.

- Only value imports are considered — `import type` / `export type` are erased
  by the compiler and cannot form a runtime cycle.
- Cross-package imports (`@open-cowork/*`, npm packages) are out of scope here;
  package layering is enforced separately by the cloud/gateway boundary tests.
- The gate runs as part of `pnpm lint` (`node scripts/check-import-cycles.mjs`)
  and is also asserted by `tests/renderer-modularity-boundaries.test.ts`, which
  additionally self-checks that the detector still catches a synthetic cycle.

To break a cycle, extract the shared code into a lower layer (usually a helper),
or switch a purely type-level dependency to `import type`.

## Guardrail: renderer file-size budgets

Large files concentrate responsibility and resist review. Every source file
under `packages/app/src` has a line budget of **900 lines**, enforced by
`tests/renderer-modularity-boundaries.test.ts`. A handful of files predate the
budget and carry explicit, documented exceptions that act as decomposition
backlogs — they may not grow past their pinned budget:

| File | Budget | Decomposition backlog |
| --- | --- | --- |
| `browser/cowork-api.ts` | 1,446 | Split the browser cloud API facade by domain (sessions / threads / artifacts / workflows), mirroring the `cloud-client` domain barrels. |
| `components/HomePage.tsx` | 1,214 | Extract the inline HomeComposer and its shared composer hooks (#920), plus the launchpad feed, quick-actions, and hero sections, into feature components. The small bump registers the #918 assign-menu keyboard-a11y wiring; #920's extraction brings it back down. |
| `components/layout/Sidebar.tsx` | 954 | Extract the per-section nav groups into dedicated components. |

Budgets are ratchets: when a file shrinks, lower its budget; never raise a
budget except to register a new, deliberately documented backlog. New code
should land under the general 900-line limit from the start.

## Where this is enforced

- `scripts/check-import-cycles.mjs` — the cycle gate (wired into `pnpm lint`).
- `tests/renderer-modularity-boundaries.test.ts` — file-size budgets, the
  cycle assertion, and the detector self-check.
- `scripts/lint.mjs` — renderer design-system drift gates (raw palette,
  arbitrary font sizes, icon-button labels, native dialogs).

See [Design System](design-system.md) for the primitive and token rules that
sit alongside these structural guardrails.
