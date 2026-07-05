# Design Refinement + Cloud Web → React Proposal

> **⚠️ Superseded (2026-06-24).** The Studio design pass reversed premises here: the ambient
> radial glow was removed, and the theme list was rebuilt as a curated set of user-facing
> presets (Mercury remains the default) rather than dropped for a single identity. Read this as
> a historical proposal; current state is in `theme-presets.ts` (`USER_FACING_THEME_IDS`) and
> [`design/repo-deep-audit-2026-06.md`](design/repo-deep-audit-2026-06.md).
>
> The "Cloud Web → React" migration proposed below was also overtaken: Cloud Web is no
> longer a separate `apps/website` app. The single unified renderer (`packages/app/src`)
> now runs both Desktop (Electron, real IPC) and Cloud Web (the browser, over a typed `CoworkAPI`
> shim at `packages/app/src/browser/cowork-api.ts`), and the cloud serves it at `GET /`.
> The `apps/website` package was deleted. The "Current architecture (grounded)" table and the
> `apps/website` references below describe the pre-unification state. See
> [architecture](architecture.md) and [Cloud Web Studio](cloud-web-workbench.md).

> Status: **Proposal / for review** · Author: design+arch pass · Date: 2026-06-05
>
> Two pillars, decided up front:
> 1. **Refine** the shared "Mercury" visual language toward Codex-grade restraint and polish — **keep the indigo identity and all theme presets**. No reskin.
> 2. **Migrate the Cloud Web app to React** so it shares the Desktop UI kit and reaches true interaction parity — one design system, two surfaces.

---

## 1. Why this, and what's really going on

The two apps look different, but **not because they use different design tokens** — they already share the same vocabulary (`--color-*`, `--space-*`, `--radius-*`, Mona Sans / Schibsted Grotesk). The real gaps are:

- **Aesthetic ceiling (both apps).** The shared "Mercury" language is *decorated but soft*: ultra-faint borders (`rgba(180,194,250,0.07)`), low-alpha tinted surfaces (`rgba(141,164,245,0.04)`), and a full-bleed radial gradient. Surfaces blend into the background, so the UI reads "pretty but mushy" rather than crisp and intentional. Codex's polish comes from the opposite instinct: **clear hairlines, calm flat surfaces, functional color, tight typographic hierarchy.** We can adopt that *discipline* without abandoning the indigo palette or the presets.
- **Interaction ceiling (cloud only).** Cloud Web is server-rendered HTML strings + 12 concatenated vanilla-JS client scripts. It can match Desktop *visually* but not *behaviorally* — rich client state, optimistic updates, virtualized timelines, command palette, etc. are all reimplemented by hand against `innerHTML`. React closes this for good.

### Current architecture (grounded)

| | Desktop (`apps/desktop`) | Cloud Web (`apps/website`) |
|---|---|---|
| UI | React 19 + Vite + Tailwind v4 | SSR HTML strings + vanilla JS (no React, no bundler) |
| State | Zustand (`stores/session.ts`) | hand-rolled object mutation + `innerHTML` |
| Data | `window.coworkApi.*` (preload IPC, 150+ channels) | `/api/*` HTTP + SSE only |
| Tokens | `globals.css` `@theme` + `:root` | `styles.ts` CSS-in-strings via `branding.ts` |
| Themes | **18 presets** (`renderer/helpers/theme-preset-data.ts`) | single server-set brand theme only |
| Gates | design-tokens-sync, a11y | modularity (line budgets, forbidden imports), a11y (WCAG AAA), perf (10k sessions ≤350ms), render |

**Single source of truth that matters:** `packages/shared/src/design-tokens.ts` exports `DESIGN_TOKENS` + `emitRootTokensCss()`. Both apps derive from the same default brand theme there. *Today the values are also hand-duplicated in `globals.css` (lines 40–57 and 100–171) and kept aligned by `tests/design-tokens-sync.test.ts`.* This means **one well-placed token change propagates to both apps** — the cheapest, highest-leverage lever we have.

---

## 2. Design principles (the "refinement contract")

1. **Keep the existing palette catalog and add Studio as the default preset.** Mercury's indigo accent (`#8da4f5`) remains available for existing users while Studio's graphite/plum palette becomes the default.
2. **Definition over decoration.** Crisper borders, calmer surfaces, less reliance on the gradient to do the visual work.
3. **Functional color.** Accent and status colors earn their place (active, progress, success/warn/danger) — not as ambient tint.
4. **Tighter hierarchy.** Stronger type contrast and consistent density so the eye knows where to go.
5. **One token source.** `design-tokens.ts` generates the CSS; stop hand-duplicating. This is also what lets the React cloud app consume the exact same tokens + presets.

---

## 3. Pillar A — Visual refinement spec (token-level, identity preserved)

All changes below are *refinements to ratios and structure*, applied in `packages/shared/src/design-tokens.ts` so both apps inherit them. Per-preset hues are untouched; we change how tokens **relate**, not their colors.

### 3.1 Borders & surfaces — the biggest win
The faint borders are the #1 reason the UI feels soft. Introduce a clearer hairline tier while keeping the subtle one for nested dividers.

| Token | Today | Proposed | Rationale |
|---|---|---|---|
| `--color-border` | `rgba(180,194,250,0.07)` | `~0.11` alpha (per preset ratio) | Crisp, visible card/panel edges |
| `--color-border-subtle` | `rgba(180,194,250,0.035)` | keep | Inner dividers, list separators |
| `--color-border-strong` | — *(new)* | `~0.18` alpha | Focused/active containers, table headers |
| `--color-surface` | `rgba(141,164,245,0.04)` | keep, but add 1px inset top-highlight on elevated | Subtle "lift" without heavier shadows |

> Implementation: derive border/surface alphas as **ratios off the preset's accent/border seed** so all 18 presets get the same crispness automatically (extend the preset schema with the three border tiers, default-derived for existing presets).

### 3.2 Spacing rhythm
Scale is `1,2,3,4,5,6,8,10,12` (×4px) — solid but gappy above 24px. Fill the rhythm and standardize component insets.

- Add `--space-7: 28px`, `--space-9: 36px` for smoother large-gap steps.
- **Component density pass:** list rows, table rows, and thread items move to `--control-h-sm` (28px) rhythm with `--space-2/--space-3` insets — Codex-like compactness. Cards keep `--space-4/--space-6`.

### 3.3 Type scale & hierarchy
Scale (`11→38px`) is already near-modular (~1.25 at the top). Refine optics, not sizes:

- Add **letter-spacing tokens** for large display text: `--tracking-tight: -0.01em` (xl/2xl), `-0.02em` (3xl/hero) — tightens headings the way Codex does.
- Enforce `--font-display` (Schibsted Grotesk) on page/section titles; body stays Mona Sans.
- Bump weight contrast: titles 600–650, body 400, metadata 450 muted. Variable fonts (200–900) already support this.

### 3.4 Motion polish
Durations (`120/180/240ms`) and easings are good; the gap is *consistency*.

- Standardize: hover → `--dur-1` + `--ease-out`; surface enter/exit → `--dur-2`; overlays/dialogs → `--dur-3` + `--ease-emphasized`.
- Animate only `transform`/`opacity` (never layout) for 60fps.
- Add one `--ease-spring` for "satisfying" affordances (toasts, menu open). Respect existing `prefers-reduced-motion` zeroing.

### 3.5 Elevation
Two-step shadow system is fine; refine for crispness:

- Tighten `--shadow-card` (smaller blur, slightly higher first-layer opacity) so cards read as *placed* not *floating*.
- Reserve `--shadow-elevated` strictly for overlays/popovers/dialogs.

### 3.6 The gradient
Keep the Mercury radial gradient (`--bg-image`) — it's identity — but **dial its intensity down** (~0.08 → ~0.05 alpha) so borders/surfaces, not the glow, define structure. Per-preset, still on.

### 3.7 Consolidate the token source (structural)
Replace the hand-duplicated `:root`/`@theme` blocks in `globals.css` with output from `emitRootTokensCss(DESIGN_TOKENS)`, and emit the same for cloud. Keeps `design-tokens-sync.test.ts` green by construction and gives the React cloud app one import for tokens **and** presets.

---

## 4. Pillar B — Layout / IA refinements (Codex-inspired, identity-preserving)

Optional but recommended; sequenced after the token pass. These are *evolutions*, not a rebuild.

- **Workflow-first three-pane** for chat/workbench: thread list │ active conversation │ contextual review pane (diffs, artifacts, task summary). Desktop already has the pieces (inspector, task drill-in); this formalizes the right pane.
- **Top-right action cluster** (Codex's signature): consolidate run/agent-mode/env + git/artifact actions into a single right-aligned bar instead of scattered controls.
- **Diff/review-first artifacts:** present file changes and artifacts as first-class review surfaces, not afterthoughts.
- **Calmer chrome:** thinner sidebar dividers, denser nav, less chrome around the canvas — let content breathe.

---

## 5. Pillar C — Cloud Web → React migration plan

### 5.1 Target architecture
```
packages/
  shared/        ← types, logic, design tokens + presets (exists; add preset export)
  ui/            ← NEW: @open-cowork/ui — pure presentational primitives
apps/
  desktop/       ← imports @open-cowork/ui; provides window.coworkApi adapter
  website/       ← React client; imports @open-cowork/ui; provides fetch /api adapter
```

**Key decoupling move — an API adapter interface.** Desktop primitives are already pure (verified: `Button`, `Input`, `Select`, `Dialog`, `Card`, `Badge`, `Icon` import only React + `cn` + `useFocusTrap` + lucide — **zero Electron/IPC/Zustand**). Feature components are the coupled layer: they call `window.coworkApi.*` and read `useSessionStore`. We introduce a single `AppAPI` interface (the contract already half-exists as `CoworkAPI` in shared):

- **Desktop** implements `AppAPI` over `window.coworkApi` (IPC).
- **Cloud** implements `AppAPI` over `fetch('/api/*')` + `EventSource` (SSE) — the endpoints already enumerated in `route-api-matrix.ts`.
- Feature components consume `AppAPI` via React context, not `window.*` directly.

### 5.2 Reuse buckets (verified)
| Bucket | Examples | Effort |
|---|---|---|
| **Reuse as-is** → move to `@open-cowork/ui` | all `components/ui/` primitives, `useFocusTrap`, `cn`, tokens | **Zero** |
| **Reuse via adapter** | ChatView, composer, thread list, agents, capabilities, workflows | **Medium** (swap IPC→`AppAPI`) |
| **Desktop-only (stub on web)** | title bar/window chrome, native file/dir pickers, clipboard, file explorer, Vega chart BrowserWindow | **N/A** — web fallbacks (`<input type=file>`, Clipboard API) or hidden |

### 5.3 Rendering / serving
- Keep the existing entrypoint contract: `cloudWebsiteHtml(policy, branding, nonce)` still returns a string and is still served from `http-server.ts` at `/` with the **CSP nonce** and the `#open-cowork-cloud-bootstrap` JSON tag.
- Replace the body with **React SSR (renderToString) + hydrate**, or ship CSR with the same bootstrap JSON as initial props. SSR preferred to preserve first-paint, a11y landmarks, and the render-test contract.
- Add a **browser bundler** (esbuild/Vite) to `apps/website` to emit the React client bundle (today there's no bundler — build is `tsc --noEmit`).

### 5.4 Gates the migration must honor (and how)
- **Forbidden imports** (`@opencode-ai/sdk`, `*-control-plane-store`, `node:sqlite`, `pg`, `stripe-billing-adapter`): **unchanged and critical** — the React client stays a pure HTTP client. The `AppAPI` fetch adapter enforces this naturally.
- **Modularity line budgets:** will need re-baselining for components/bundle; switch the metric from "lines per concatenated script" to "per-module + bundle-size budget."
- **Accessibility (WCAG AAA contrast, landmarks, focus, reduced-motion, 920px responsive):** carries over if components render the same semantic HTML — our primitives already do. Keep `accessibility.test.ts` running against SSR output.
- **Performance (10k sessions filter ≤350ms, bootstrap ≤8s, route transitions ≤1.2s):** re-profile with React; virtualize lists (Desktop already uses `@tanstack/react-virtual`) to stay within budget.
- **Render/redaction/branding/bootstrap-escaping (`render.test.ts`):** preserve the bootstrap JSON shape, branding overrides, and sanitizer boundary.

### 5.5 Theming payoff — *this is where "keep the themes" pays off*
Once cloud is React on the shared token system, the **18 presets become available in Cloud Web too**. A user-selectable theme switcher can be shared between both apps. Server-set branding (`PublicBrandingThemeTokens`) still overrides for white-label tenants. Net: themes are not just kept — they're **unified across both surfaces**.

---

## 6. Phased rollout

**Phase 0 — Token consolidation (low risk, high leverage).** Make `design-tokens.ts` the generator; both apps consume `emitRootTokensCss`. No visual change yet; unblocks everything.

**Phase 1 — Visual refinement (Pillar A).** Border tiers, surface lift, spacing fill, type tracking, motion standardization, gradient dial-down, elevation. Lands in *both* apps at once via shared tokens. Update the 18 presets' border ratios. *Ship + screenshot diff per preset.*

**Phase 2 — Extract `@open-cowork/ui`.** Move pure primitives out of desktop; desktop imports from the package (no behavior change). Add bundler to `apps/website`.

**Phase 3 — `AppAPI` adapter + first React surface.** Define `AppAPI`; build the desktop IPC adapter and cloud fetch adapter. Port **one** cloud surface (recommend Chat/Workbench) to React behind the existing SSR entrypoint. Validate all gates.

**Phase 4 — Port remaining cloud surfaces** (threads, agents, capabilities, workflows, admin) surface-by-surface, retiring the matching vanilla-JS client scripts as each lands.

**Phase 5 — IA refinements (Pillar B)** once both apps share React components: three-pane workflow layout, top-right action cluster, diff-first review. Shared, so it lands everywhere.

---

## 7. Risks & open decisions
- **SSR vs CSR for cloud** — SSR best preserves the existing render/a11y gates; CSR is simpler but regresses first paint. *Recommend SSR + hydrate.*
- **Line-budget gate** needs a new definition for a bundled React app (per-module + bundle size, not concatenated-script lines).
- **Perf budgets** must be re-profiled against React hydration; commit to virtualization early.
- **Scope of Pillar B (IA)** — pure refinement vs. fuller Codex-style relayout. Defer until Phases 0–4 prove the shared system.
- **Where the theme switcher lives in cloud** (per-user persisted vs. session-only) given tenant branding precedence.
