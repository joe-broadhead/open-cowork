# Studio (Option D) — design reference

This is the **visual source of truth** for the Studio redesign tracked in the roadmap epic and its sub-issues. It is the original Claude Design handoff prototype (HTML/CSS/JS) for **Open Cowork — Studio (Option D)**.

## How coding agents should use this

- The roadmap sub-issues reference files here by path, e.g. `option-d/styles.css`, `option-d/views-projects.jsx`, `option-d/data.js`, `option-d/app.jsx`. Open the referenced file to see exact layout, spacing, tokens, and component structure.
- **Recreate the visual output** in the target stack (desktop renderer `apps/desktop/src/renderer`, Cloud Web `apps/website`, shared `packages/ui`). Do **not** copy the prototype's internal structure (it's a standalone React-via-Babel demo) unless it happens to fit.
- Read the HTML entry `Open Cowork - Studio (Option D).html` to see load order and which files compose each screen.

## Files

- `Open Cowork - Studio (Option D).html` — entry point; loads the `option-d/` modules in order.
- `option-d/styles.css` — the full design system (themes, tokens, every component's CSS). The canonical reference for spacing/color/typography.
- `option-d/data.js` — the data shapes each surface expects (coworkers, projects/tasks, permissions, channels, spaces/wiki, etc.).
- `option-d/app.jsx` — app shell, routing, sidebar, theme/accent/density.
- `option-d/components.jsx` — shared primitives (Icon, Avatar, etc.).
- `option-d/views-*.jsx` — per-surface views (chat, projects, gateway, library, ops, builder, settings, wiki).
- `option-d/tweaks-panel.jsx` — the live theme/accent/density tweak panel.

## Important: brand-agnostic implementation

The prototype's **sample content is illustrative mock data** themed for a fictional company/team (names, the accent keyed to a company brand, HR scenarios). **Do not reproduce any of that branding.** Implementations must stay brand-agnostic per the roadmap issues:
- The signature accent is `#2f6bf0`; key it `azure`, never the prototype's company-brand key.
- Use the design's **layout, components, tokens, and interaction model** — not its mock copy or company theming.
