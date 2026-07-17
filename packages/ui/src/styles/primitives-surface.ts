// Domain: primitives-surface
// Ownership: packages/ui Studio surface CSS (Shared layout/card/empty/skeleton primitive styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function primitivesSurfaceCss(): string {
  return `
/* Cooled warm semantics: the warning/danger hues lean toward the cool palette so
   amber/pink chips stop screaming against the indigo surfaces. These chip tokens
   (and the --color-warning/--color-red aliases routed through them) back the
   tonal badge recipe below and the semantic status pills consumed by components. */
:root {
  --chip-warning: color-mix(in srgb, var(--color-amber) 70%, var(--color-info));
  --chip-danger: color-mix(in srgb, var(--color-red) 80%, var(--color-info));
  --color-warning: var(--chip-warning);
  --color-red: var(--chip-danger);
}

/* Badge / chip — small inline status pill. Padding 0 var(--space-2), label
   weight 560, desktop letter-spacing kept, full pill radius. All 7 tones share
   one quiet tinted recipe; warning/danger route through the cooled chip tokens
   (never raw amber/red). */
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-sm);
  border: var(--border-width-1) solid transparent;
  border-radius: var(--radius-full);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: 560;
  line-height: var(--lh-xs);
  white-space: nowrap;
  letter-spacing: 0.02em;
}

.ui-badge--neutral {
  background: var(--color-surface);
  border-color: var(--color-border-subtle);
  color: var(--color-text-secondary);
}

.ui-badge--muted {
  background: var(--color-surface);
  border-color: var(--color-border-subtle);
  color: var(--color-text-muted);
}

.ui-badge--accent {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 22%, transparent);
  color: color-mix(in srgb, var(--accent-text) 88%, var(--color-text-secondary));
}

.ui-badge--info {
  background: color-mix(in srgb, var(--color-info) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-info) 22%, transparent);
  color: color-mix(in srgb, var(--color-info) 84%, var(--color-text-secondary));
}

.ui-badge--success {
  background: color-mix(in srgb, var(--color-green) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-green) 22%, transparent);
  color: color-mix(in srgb, var(--color-green) 84%, var(--color-text-secondary));
}

.ui-badge--warning {
  background: color-mix(in srgb, var(--chip-warning) 10%, transparent);
  border-color: color-mix(in srgb, var(--chip-warning) 22%, transparent);
  color: color-mix(in srgb, var(--chip-warning) 84%, var(--color-text-secondary));
}

.ui-badge--danger {
  background: color-mix(in srgb, var(--chip-danger) 10%, transparent);
  border-color: color-mix(in srgb, var(--chip-danger) 24%, transparent);
  color: color-mix(in srgb, var(--chip-danger) 86%, var(--color-text-secondary));
}

/* Studio page-header polish — these rules are NOT in the per-app studio stylesheets
   (apps own .studio-page-header / __copy / h1 / p), so they are single-sourced here
   and picked up by both desktop (studioSurfaceStyles) and web (controls/primitives
   embeds). __meta is rendered by StudioPrimitives but had no rule; the description
   gets a small top gap so the title and copy aren't cramped. The description rule is
   scoped through .studio-page-header__copy div (one extra element step) so it wins
   over each app's grouped .studio-page-header p margin:0 rule regardless of the
   order this shared sheet is embedded relative to the per-app studio CSS. */
.studio-page-header__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.studio-page-header__copy div p {
  margin-top: var(--space-1);
}

/* A filter field hosted inside the page-header actions row (cloud relocates its
   per-route filter here so the header is the single title/control band). The
   label stacks a small muted caption over the input and sits inline next to the
   header buttons. Web-only structure today, but single-sourced here so any future
   desktop header filter matches. */
.studio-page-header__filter {
  display: inline-flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.studio-page-header__filter input {
  min-height: var(--control-h-sm);
  min-width: 0;
}

/* Card padding — single-sourced here so a default Card and a studio object card
   share one flat spacing scale on both surfaces. Each app keeps its own .ui-card
   chrome (border/radius/background/shadow) but the size padding is canonical:
   sm 12 / md 16 / lg 20, on the --space grid (was an odd --row-pad ladder). */
.ui-card--sm { padding: var(--space-3); }
.ui-card--md { padding: var(--space-4); }
.ui-card--lg { padding: var(--space-5); }

/* Dialog — modal/drawer surface. Card radius matches .ui-card (--radius-xl);
   title weight 600 + tight tracking; header gap --space-3, footer gap --space-2
   with centered footer items. */
.ui-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: color-mix(in srgb, var(--color-base) 66%, transparent);
  backdrop-filter: blur(8px);
  animation: ui-fade-in var(--dur-2) var(--ease-out) both;
}

.ui-dialog-backdrop--drawer {
  display: flex;
  justify-content: flex-end;
}

.ui-dialog {
  position: fixed;
  inset-block-start: 12vh;
  inset-inline-start: 50%;
  z-index: calc(var(--z-modal) + 1);
  display: flex;
  max-height: min(var(--primitive-dialog-max-h), calc(100vh - var(--space-12)));
  max-width: calc(100vw - var(--space-8));
  transform: translateX(-50%);
  flex-direction: column;
  overflow: hidden;
  border: var(--border-width-1) solid var(--glass-border);
  border-radius: var(--radius-xl);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-3), var(--specular-strong);
  color: var(--color-text);
  animation: ui-dialog-in var(--dur-3) var(--ease-spring) both;
}

.ui-dialog--sm { width: min(var(--primitive-dialog-w-sm), calc(100vw - var(--space-8))); }
.ui-dialog--md { width: min(var(--primitive-dialog-w-md), calc(100vw - var(--space-8))); }
.ui-dialog--lg { width: min(var(--primitive-dialog-w-lg), calc(100vw - var(--space-8))); }

.ui-dialog--drawer {
  inset-block: 0;
  inset-inline: auto 0;
  height: 100dvh;
  max-height: 100dvh;
  width: min(440px, 92vw);
  transform: none;
  border-block: 0;
  border-inline-end: 0;
  border-radius: 0;
  animation-name: ui-drawer-in;
}

.ui-dialog--drawer-left {
  inset-inline: 0 auto;
  border-inline-start: 0;
  border-inline-end: var(--border-width-1) solid var(--glass-border);
  animation-name: ui-drawer-left-in;
}

.ui-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  border-bottom: var(--border-width-1) solid var(--color-border-subtle);
  padding: var(--space-4);
}

.ui-dialog__title {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: 600;
  letter-spacing: var(--tracking-tight);
  line-height: var(--lh-xl);
}

.ui-dialog__body {
  overflow: auto;
  padding: var(--space-4);
}

.ui-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  border-top: var(--border-width-1) solid var(--color-border-subtle);
  padding: var(--space-4);
}

/* Shared status-dot — the dot + label that replaces filled status pills across
   the studio surfaces (desktop + web). "live" breathes (reduced-motion guarded);
   the rest are static semantic dots. */
.studio-status-dot-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
  color: var(--color-text-secondary);
  text-transform: capitalize;
  white-space: nowrap;
}
.studio-status-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  flex: 0 0 auto;
}
.studio-status-dot--ok { background: var(--color-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-green) 16%, transparent); }
.studio-status-dot--warn { background: var(--color-amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-amber) 18%, transparent); }
.studio-status-dot--error { background: var(--color-red); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-red) 18%, transparent); }
.studio-status-dot--info { background: var(--color-info); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-info) 16%, transparent); }
.studio-status-dot--idle { background: var(--color-text-muted); }

/* Entity identity tile — the "gallery" treatment for non-agent entities (tools,
   skills, channels, spaces, artifacts, playbooks). Same opaque graphite-darkened
   chroma recipe as the agent avatars; the hue comes from --entity-chroma
   (entityChroma(seed)), the glyph sits in light ink on the saturated tile. */
.entity-tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--color-text);
  background: linear-gradient(140deg,
    color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 88%, var(--color-base)) 0%,
    color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 58%, var(--color-base)) 100%);
  border: var(--border-width-1) solid color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 45%, transparent);
  box-shadow: inset 0 1px 0 0 color-mix(in srgb, #fff 14%, transparent);
  transition: border-color var(--dur-1) var(--ease-out);
}

/* When the entity-tile recipe lands on an icon container that already carries its
   own flat/tone tile (e.g. the object-card lead icon), re-assert the chroma tile
   at higher specificity so the gallery hue wins regardless of stylesheet order. */
.studio-object-card__icon.entity-tile {
  background: linear-gradient(140deg,
    color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 88%, var(--color-base)) 0%,
    color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 58%, var(--color-base)) 100%);
  border: var(--border-width-1) solid color-mix(in srgb, var(--entity-chroma, var(--color-accent)) 45%, transparent);
  color: var(--color-text);
  box-shadow: inset 0 1px 0 0 color-mix(in srgb, #fff 14%, transparent);
}

.studio-status-dot--live {
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
  animation: studio-status-heartbeat 2s var(--ease-out) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .studio-status-dot--live { animation: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent); }
}

.ui-empty-state {
  display: grid;
  place-items: center;
  gap: var(--space-3);
  border: var(--border-width-1) solid color-mix(in srgb, var(--color-accent) 20%, var(--color-border-subtle));
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 60%),
    color-mix(in srgb, var(--color-surface) 72%, transparent);
  box-shadow: var(--shadow-1), var(--specular);
  color: var(--color-text-secondary);
  padding: var(--space-8);
  text-align: center;
}

.ui-empty-state__icon {
  display: grid;
  place-items: center;
  width: var(--control-h-xl);
  height: var(--control-h-xl);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent);
  box-shadow: var(--specular);
}

.ui-empty-state__title {
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: var(--tracking-tight);
  line-height: var(--lh-lg);
}

.ui-empty-state__body {
  max-width: 42ch;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-error-state {
  display: grid;
  place-items: center;
  gap: var(--space-3);
  border: var(--border-width-1) solid color-mix(in srgb, var(--color-red) 30%, var(--color-border-subtle));
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-red) 12%, transparent), transparent 60%),
    color-mix(in srgb, var(--color-surface) 72%, transparent);
  box-shadow: var(--shadow-1), var(--specular);
  color: var(--color-text-secondary);
  padding: var(--space-8);
  text-align: center;
}

.ui-error-state__icon {
  display: grid;
  place-items: center;
  width: var(--control-h-xl);
  height: var(--control-h-xl);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-red) 14%, transparent);
  color: var(--color-red);
  box-shadow: var(--specular);
}

.ui-error-state__title {
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: var(--tracking-tight);
  line-height: var(--lh-lg);
}

.ui-error-state__body {
  max-width: 46ch;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-error-state__hint {
  margin-top: var(--space-2);
  max-width: 46ch;
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  line-height: var(--lh-sm);
}

.ui-error-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

.ui-skeleton {
  display: block;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-surface) 80%, transparent),
    color-mix(in srgb, var(--color-surface-hover) 82%, transparent),
    color-mix(in srgb, var(--color-surface) 80%, transparent)
  );
  background-size: 200% 100%;
  animation: ui-skeleton-shimmer 1.2s var(--ease-out) infinite;
}

.ui-skeleton--text {
  width: 100%;
  height: var(--lh-sm);
}

.ui-skeleton--block {
  width: 100%;
  min-height: calc(var(--space-12) * 2);
}

.ui-skeleton--card {
  width: 100%;
  min-height: calc(var(--space-12) * 3);
  border-radius: var(--radius-md);
}

.ui-skeleton--row {
  width: 100%;
  min-height: var(--control-h-xl);
  border-radius: var(--radius-sm);
}

.ui-skeleton--message {
  width: min(72ch, 100%);
  min-height: calc(var(--space-12) * 2);
  border-radius: var(--radius-lg);
}

.ui-skeleton--table {
  width: 100%;
  min-height: calc(var(--space-12) * 4);
  border-radius: var(--radius-md);
}

@keyframes ui-skeleton-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-skeleton { animation: none; }
}
`
}

// UI animation keyframes shared verbatim by the desktop renderer and the website. The
// declarations are token-driven (`--space-*`, `--dur-*`, `--ease-*`) so they resolve
// identically in both apps. Desktop-only keyframes (`ui-spin`, `ui-disclosure-in`) and each
// app's `prefers-reduced-motion` guard stay local — only the cross-app set lives here.
