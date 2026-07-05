// Shared Studio surface stylesheet (CSS-in-TS).
//
// These rules style the shared @open-cowork/ui surfaces. There is one renderer
// (`packages/app`) running on both Electron (desktop) and the browser (cloud), so
// styling the surfaces here — once, in @open-cowork/ui — means both platforms are
// pixel-identical by construction.
//
// Rules here may use only design tokens emitted by @open-cowork/shared
// (`emitRootTokensCss`). Do not use app-local CSS aliases — only the shared
// tokens are guaranteed present wherever the renderer runs.
//
// Consumed by `packages/app/src/index.tsx`, which injects `studioSurfaceStyles()`
// into a <style> element at renderer startup.
//
// Radius is assigned by surface ROLE, not by eye (pick the var, never a px):
//   --radius-xs  inline code chips, kbd, tiny inset rectangles
//   --radius-sm  ALL interaction controls (button, input, select trigger, menu)
//   --radius-md  icon tiles/chips, task/kanban cards, mini previews, notices
//   --radius-lg  panels, lanes, rows, dialogs, empty-state, toast, callouts
//   --radius-xl  the studio shell, chat composer shell
//   --radius-2xl primary content cards (coworker/decision/artifact/plan)
//   --radius-3xl the composer (single most-rounded surface)
//   --radius-full badges, chips, pills, count bubbles, avatars, status dots
// Depth is the fixed ladder --shadow-1/2/3 + --specular(-strong) on raised/
// floating surfaces — never bespoke rgba shadows, scale-on-hover, or glows.

export function artifactsSurfaceCss(): string {
  return `
    .studio-artifacts-library {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-4);
      color: var(--color-text);
    }
    .studio-artifacts-toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(0, 2fr) auto;
      align-items: start;
      gap: var(--space-3);
    }
    .studio-artifacts-filters,
    .studio-artifacts-toolbar__actions,
    .studio-artifact-card__actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .studio-artifacts-filter {
      min-height: var(--control-h-sm);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      cursor: pointer;
      padding: 0 var(--space-3);
      font-size: var(--text-xs);
      font-weight: 560;
    }
    .studio-artifacts-filter:hover,
    .studio-artifacts-filter[data-active="true"] {
      border-color: var(--accent-line);
      background: var(--accent-soft);
      color: var(--accent-text);
    }
    .studio-artifacts-filter:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-artifacts-notice {
      margin: 0;
      border: var(--border-width-1) solid color-mix(in srgb, var(--color-info) 42%, var(--color-border) 58%);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--color-info) 14%, var(--color-elevated) 86%);
      color: var(--color-text-secondary);
      padding: var(--space-3);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-artifacts-notice[data-tone="warning"] {
      border-color: color-mix(in srgb, var(--color-amber) 42%, var(--color-border) 58%);
      background: color-mix(in srgb, var(--color-amber) 14%, var(--color-elevated) 86%);
      color: var(--color-amber);
    }
    .studio-artifacts-notice[data-tone="danger"] {
      border-color: color-mix(in srgb, var(--color-red) 42%, var(--color-border) 58%);
      background: color-mix(in srgb, var(--color-red) 14%, var(--color-elevated) 86%);
      color: var(--color-red);
    }
    .studio-artifacts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: var(--space-4);
    }
    .studio-artifacts-sidecar {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .studio-artifact-card {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-3);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-2xl);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-2), var(--specular);
      padding: var(--space-4);
    }
    .studio-artifact-card__head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: flex-start;
      gap: var(--space-3);
    }
    .studio-artifact-card__icon {
      display: inline-flex;
      width: var(--control-h-lg);
      height: var(--control-h-lg);
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-md);
      /* Paint comes from the co-applied .entity-tile (per-artifact identity chroma). */
    }
    .studio-artifact-card__title {
      min-width: 0;
    }
    .studio-artifact-card__title h3 {
      margin: 0;
      overflow: hidden;
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: var(--text-md);
      line-height: var(--lh-md);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-artifact-card__title p {
      margin: var(--space-1) 0 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .studio-artifact-card__preview {
      display: grid;
      min-height: 92px;
      align-content: center;
      gap: var(--space-2);
      border: var(--border-width-1) dashed var(--color-border);
      border-radius: var(--radius-md);
      background: repeating-linear-gradient(135deg, var(--color-surface), var(--color-surface) 8px, transparent 8px, transparent 16px);
      padding: var(--space-3);
    }
    .studio-artifact-card__preview span {
      overflow: hidden;
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
      font-weight: 560;
      line-height: var(--lh-sm);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-artifact-card__preview code {
      overflow: hidden;
      color: var(--color-text-muted);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-artifact-card__facts {
      display: grid;
      gap: var(--space-2);
      margin: 0;
    }
    .studio-artifact-card__facts dt {
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      font-weight: 600;
      line-height: var(--lh-2xs);
      text-transform: uppercase;
    }
    .studio-artifact-card__facts div {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      align-items: baseline;
      gap: var(--space-2);
    }
    .studio-artifact-card__facts dd {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @media (max-width: 880px) {
      .studio-artifacts-toolbar {
        grid-template-columns: minmax(0, 1fr);
      }
      .studio-artifacts-toolbar__actions {
        justify-content: flex-start;
      }
    }
    @media (max-width: 640px) {
      .studio-artifacts-grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }`
}

export function knowledgeGraphCss(): string {
  return `
    .studio-graph-panel {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-3);
    }
    .studio-graph-legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-4);
    }
    .studio-graph-legend-item {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      color: var(--color-text-secondary);
    }
    .studio-graph-legend-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex: none;
    }
    .studio-graph {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
      flex-direction: column;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-base);
      overflow: hidden;
    }
    .studio-graph--empty {
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
    }
    .studio-graph-svg {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 420px;
    }
    .studio-graph-node {
      transition: opacity 200ms ease;
    }
    .studio-graph-node[data-dim="true"] {
      opacity: 0.25;
    }
    .studio-graph-label {
      fill: var(--color-text-secondary);
      font-family: var(--font-ui);
      pointer-events: none;
    }
    .studio-graph-node[data-kind="root"] .studio-graph-label,
    .studio-graph-node[data-kind="space"] .studio-graph-label {
      fill: var(--color-text);
    }
    .studio-graph-node:focus-visible {
      outline: none;
    }
    .studio-graph-node:focus-visible circle {
      stroke: var(--color-accent);
      stroke-width: 3;
    }`
}

export function approvalsSurfaceCss(): string {
  return `
    .studio-approvals-surface {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-4);
    }
    .studio-approvals-list,
    .studio-question-controls,
    .studio-question-block,
    .studio-question-answer {
      display: flex;
      min-width: 0;
      flex-direction: column;
    }
    .studio-approvals-list,
    .studio-question-controls {
      gap: var(--space-3);
    }
    .studio-approval-item {
      align-items: flex-start;
    }
    .studio-approval-item__identity,
    .studio-approval-item__chips,
    .studio-question-options,
    .studio-question-answer .studio-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .studio-approval-item__identity {
      color: var(--color-text-secondary);
    }
    .studio-approval-item__identity div {
      display: flex;
      min-width: 0;
      flex-direction: column;
    }
    .studio-approval-item__identity strong {
      color: var(--color-text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-approval-item__identity span {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .studio-approval-command {
      margin: 0;
      max-height: 240px;
      overflow: auto;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      padding: var(--space-3);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .studio-question-block {
      gap: var(--space-2);
    }
    .studio-question-block strong {
      color: var(--color-text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-question-option {
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      cursor: pointer;
      padding: var(--space-2) var(--space-3);
      text-align: start;
    }
    .studio-question-option:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-question-option:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .studio-question-option[data-selected="true"] {
      border-color: color-mix(in srgb, var(--color-accent) 62%, var(--color-border));
      background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
      color: var(--color-text);
    }
    .studio-question-option:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    .studio-question-option span,
    .studio-question-option small {
      display: block;
    }
    .studio-question-option small {
      margin-top: var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      line-height: var(--lh-2xs);
    }`
}

export function wikiSurfaceCss(): string {
  return `
    .studio-wiki-rail {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-3);
      border-inline-end: var(--border-width-1) solid var(--color-border-subtle);
      background: var(--color-surface);
      padding: var(--space-3);
    }
    .studio-wiki-rail__view {
      display: flex;
    }
    .studio-wiki-rail__view > * {
      flex: 1 1 auto;
      min-width: 0;
    }
    .studio-wiki-rail__spaces,
    .studio-wiki-space div {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .studio-wiki-space h3 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0 0 var(--space-2);
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .studio-wiki-space h3 span {
      width: var(--space-5);
      height: var(--space-5);
      border-radius: var(--radius-sm);
    }
    .studio-wiki-rail .studio-wiki-space__meta {
      flex-direction: row;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0 0 var(--space-2);
    }
    .studio-wiki-space__meta span {
      display: inline-flex;
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      padding: 0 var(--space-2);
      font-size: var(--text-2xs);
      line-height: var(--space-5);
      color: var(--color-text-muted);
    }
    .studio-wiki-space__meta .studio-wiki-space__role {
      color: var(--color-text-secondary);
      background: var(--color-elevated);
    }
    .studio-wiki-space button {
      justify-content: flex-start;
      min-height: var(--control-h-sm);
      overflow: hidden;
      border: 0;
      background: transparent;
      color: var(--color-text-secondary);
      padding: 0 var(--space-3);
      text-align: start;
      text-overflow: ellipsis;
    }
    .studio-wiki-space button:hover,
    .studio-wiki-space button[data-active="true"] {
      background: var(--color-elevated);
      color: var(--color-text);
    }
    .studio-wiki-space button:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-wiki-page {
      min-width: 0;
      overflow: auto;
      padding: var(--space-6);
    }
    .studio-wiki-page__crumbs {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    .studio-wiki-page__head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      margin-top: var(--space-3);
    }
    .studio-wiki-page__head h1 {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: var(--text-2xl);
      line-height: var(--lh-2xl);
    }
    .studio-wiki-page__head-side {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
    }
    .studio-wiki-page__body {
      margin-top: var(--space-5);
    }
    .studio-wiki-page__body h2 {
      margin: var(--space-5) 0 var(--space-2);
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: var(--text-lg);
    }
    .studio-wiki-page__body p,
    .studio-wiki-page__body li {
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
      line-height: var(--lh-lg);
    }
    .studio-wiki-page__body ul {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-2) 0;
      padding: 0;
      list-style: none;
    }
    .studio-wiki-page__body li {
      position: relative;
      padding-inline-start: var(--space-5);
    }
    .studio-wiki-page__body li::before {
      content: "";
      position: absolute;
      inset-block-start: 0.75em;
      inset-inline-start: var(--space-2);
      width: var(--space-2);
      height: var(--space-2);
      border-radius: var(--radius-full);
      background: var(--color-accent);
    }
    .studio-wiki-page__callout {
      display: flex;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--accent-line);
      border-radius: var(--radius-lg);
      background: var(--accent-soft);
      color: var(--color-text);
      padding: var(--space-3) var(--space-4);
    }
    .studio-wiki-page__links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-6);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-4);
    }
    .studio-wiki-page__links-title {
      flex-basis: 100%;
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .studio-wiki-page__links-title small {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      color: var(--color-text-muted);
    }
    .studio-wiki-page__links span {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs);
    }
    .studio-wiki-propose {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .studio-wiki-propose__hint {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-wiki-propose__field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .studio-wiki-propose__field span {
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .studio-wiki-propose__error {
      margin: 0;
      color: var(--color-danger, #c46a72);
      font-size: var(--text-sm);
    }`
}

// Aggregate of every shared Studio surface stylesheet. Both apps consume this so
// new surfaces are picked up by desktop and Cloud Web from one place.
export function channelsSurfaceCss(): string {
  return String.raw`
.studio-channels-surface {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-4);
  color: var(--color-text);
}

.studio-channel-header-meta,
.studio-channel-panel__head,
.studio-channel-card__head,
.studio-channel-card__meta,
.studio-channel-actions,
.studio-channel-watch,
.studio-channel-delivery-row,
.studio-channel-summary .row,
.studio-channel-checkboxes label,
.studio-channel-chip {
  display: flex;
  align-items: center;
}

.studio-channel-header-meta {
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.studio-channel-dashboard,
.studio-channel-grid,
.studio-channel-form__grid {
  display: grid;
  gap: var(--space-3);
}

.studio-channel-dashboard {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
}

.studio-channel-panel,
.studio-channel-card,
.studio-channel-form,
.studio-channel-notice {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
  box-shadow: var(--shadow-1), var(--specular);
}

.studio-channel-panel {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
}

.studio-channel-panel--summary {
  align-self: stretch;
}

.studio-channel-panel__head {
  justify-content: space-between;
  gap: var(--space-3);
}

.studio-channel-panel__head h2,
.studio-channel-form h3,
.studio-channel-card h3,
.studio-channel-watch h3,
.studio-channel-delivery-row h3 {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-md);
  line-height: var(--lh-md);
}

.studio-channel-panel__head p,
.studio-channel-card p,
.studio-channel-watch p,
.studio-channel-delivery-row p,
.studio-channel-watch small {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
}

.studio-channel-card__icon {
  display: inline-flex;
  flex: none;
  width: var(--control-h-md);
  height: var(--control-h-md);
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  /* Paint comes from the co-applied .entity-tile (per-provider identity chroma). */
}

.studio-channel-grid {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.studio-channel-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
}

.studio-channel-card__head {
  align-items: flex-start;
  gap: var(--space-3);
}

.studio-channel-card__head > div {
  min-width: 0;
}

.studio-channel-card__meta,
.studio-channel-actions {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.studio-channel-card__meta {
  justify-content: space-between;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.studio-channel-actions {
  justify-content: flex-end;
}

.studio-channel-list {
  display: grid;
  gap: var(--space-2);
}

.studio-channel-summary {
  display: grid;
  gap: var(--space-2);
}

.studio-channel-summary .row,
.studio-channel-watch,
.studio-channel-delivery-row {
  justify-content: space-between;
  gap: var(--space-3);
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: var(--space-2) var(--space-3);
}

.studio-channel-summary .row span {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.studio-channel-watch__copy {
  min-width: 0;
}

.studio-channel-chip {
  width: fit-content;
  min-height: var(--control-h-xs);
  gap: var(--space-1);
  border: var(--border-width-1) solid var(--accent-line);
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-text);
  padding: 0 var(--space-2);
  font-size: var(--text-2xs);
  font-weight: 600;
}

.studio-channel-form {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
}

.studio-channel-form__grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.studio-channel-form__grid .span,
.studio-channel-form .span {
  grid-column: 1 / -1;
}

.studio-channel-form label,
.studio-channel-checkboxes {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.studio-channel-form input,
.studio-channel-form select {
  min-height: var(--control-h-md);
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  padding: var(--space-2) var(--space-3);
  font: inherit;
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.studio-channel-checkboxes {
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  padding: var(--space-3);
}

.studio-channel-checkboxes legend {
  padding: 0 var(--space-1);
}

.studio-channel-checkboxes label {
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.studio-channel-checkboxes input {
  min-height: auto;
  accent-color: var(--color-accent);
}

.studio-channel-notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}

.studio-channel-notice[data-tone="success"] {
  border-color: color-mix(in srgb, var(--color-green) 34%, var(--color-border) 66%);
  color: var(--color-green);
}

.studio-channel-notice[data-tone="warning"] {
  border-color: color-mix(in srgb, var(--color-amber) 38%, var(--color-border) 62%);
  color: var(--color-amber);
}

@media (max-width: 1080px) {
  .studio-channel-dashboard {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .studio-channel-panel__head,
  .studio-channel-watch,
  .studio-channel-delivery-row {
    display: grid;
  }

  .studio-channel-form__grid {
    grid-template-columns: 1fr;
  }
}

.studio-channel-row__meta {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
`
}

export function projectsSurfaceCss(): string {
  return String.raw`
.studio-kanban-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: var(--space-3);
}

.studio-kanban-column {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-3);
}

.studio-kanban-column--over {
  border-color: var(--accent-line);
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface) 93%);
}

.studio-kanban-column__head,
.studio-kanban-task-card__top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.studio-kanban-column__head h3 {
  margin: 0;
  flex: 1;
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: var(--lh-2xs);
  text-transform: uppercase;
}

.studio-kanban-column__head span {
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.studio-kanban-column__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.studio-kanban-column__empty {
  border: var(--border-width-1) dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  margin: 0;
  padding: var(--space-4) var(--space-2);
  text-align: center;
}

.studio-kanban-task-card {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-elevated) 90%, var(--color-base) 10%);
  box-shadow: var(--shadow-1), var(--specular);
  padding: var(--space-3);
  transition: transform var(--dur-2) var(--ease-out), border-color var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}

.studio-kanban-task-card:hover,
.studio-kanban-task-card--dragging {
  transform: translateY(calc(-1 * var(--space-1)));
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-2), var(--specular-strong);
}

.studio-kanban-task-card__priority {
  width: var(--space-2);
  height: var(--space-2);
  flex: none;
  margin-top: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--studio-priority);
}

.studio-kanban-task-card__foot {
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.studio-kanban-task-card__foot .studio-coworker-avatar {
  width: var(--space-6);
  height: var(--space-6);
}

.studio-project-progress {
  display: grid;
  gap: var(--space-2);
}

.studio-project-progress em {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-style: normal;
}

.studio-projects-layout {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: var(--space-4);
}

.studio-projects-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-3);
}

.studio-projects-list .studio-object-card {
  cursor: pointer;
}

.studio-projects-list .studio-object-card:focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
}

.studio-projects-list .studio-object-card[data-selected="true"] {
  border-color: var(--accent-line);
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-elevated) 93%);
  box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular);
}

.studio-project-board {
  min-width: 0;
}

.studio-project-board-header,
.studio-project-create,
.studio-plan-form,
.studio-task-drawer,
.studio-project-notice {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
  box-shadow: var(--shadow-1), var(--specular);
}

.studio-project-board-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
}

.studio-project-board-header__copy {
  display: grid;
  min-width: 0;
  gap: var(--space-2);
}

.studio-project-board-header h2,
.studio-task-drawer h2 {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  line-height: var(--lh-xl);
}

.studio-project-board-header p,
.studio-task-drawer p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.studio-project-board-header__meta,
.studio-project-board-header__actions,
.studio-team-avatars,
.studio-project-create__actions,
.studio-task-actions,
.studio-stage-chips,
.studio-hand-to {
  display: flex;
  align-items: center;
}

.studio-project-board-header__meta {
  flex-wrap: wrap;
  gap: var(--space-4);
}

.studio-project-board-header__meta .studio-project-progress {
  min-width: 180px;
}

.studio-project-board-header__actions,
.studio-project-create__actions,
.studio-task-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.studio-team-avatars {
  gap: 0;
}

.studio-team-avatars .studio-coworker-avatar + .studio-coworker-avatar {
  margin-inline-start: calc(-1 * var(--space-2));
}

.studio-project-create,
.studio-plan-form {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  /* "Plan with Cleo" is the accent-emphasised plan panel (prototype .plan-panel):
     accent-line border + a 3px accent-soft glow ring (a sanctioned accent glow). */
  border-radius: var(--radius-2xl);
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-1), var(--specular);
}

.studio-project-create__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.studio-project-create .span,
.studio-project-create__grid .span {
  grid-column: 1 / -1;
}

.studio-project-create label,
.studio-plan-form label,
.studio-select-row,
.studio-hand-to {
  display: grid;
  gap: var(--space-1);
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.studio-project-create input,
.studio-project-create textarea,
.studio-plan-form input,
.studio-plan-form textarea,
.studio-select-row select,
.studio-hand-to select {
  min-height: var(--control-h-md);
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  padding: var(--space-2) var(--space-3);
  font: inherit;
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.studio-project-create textarea,
.studio-plan-form textarea {
  resize: vertical;
}

.studio-project-board__main {
  display: grid;
  min-height: 520px;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  margin-top: var(--space-4);
}

.studio-project-board__main .studio-kanban-board {
  grid-template-columns: repeat(5, minmax(180px, 1fr));
  align-items: start;
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.studio-kanban-task-button {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  text-align: start;
}

.studio-kanban-task-button:focus-visible {
  outline: none;
  outline-offset: var(--space-1);
  border-radius: var(--radius-md);
  box-shadow: var(--ring-focus);
}

.studio-kanban-task-button[data-selected="true"] .studio-kanban-task-card {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular);
}

.studio-task-drawer {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-4);
  align-self: start;
}

.studio-task-drawer__header,
.studio-task-drawer__section {
  display: grid;
  gap: var(--space-2);
}

.studio-task-drawer__section h3 {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.studio-stage-chips {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.studio-stage-chips button {
  min-height: var(--control-h-sm);
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: 700;
}

.studio-stage-chips button:focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
}

.studio-stage-chips button[data-active="true"] {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.studio-hand-to {
  grid-template-columns: auto minmax(120px, 1fr);
  align-items: center;
}

.studio-project-notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}

.studio-project-notice[data-tone="success"] {
  border-color: color-mix(in srgb, var(--color-green) 34%, var(--color-border) 66%);
  color: var(--color-green);
}

.studio-project-notice[data-tone="warning"] {
  border-color: color-mix(in srgb, var(--color-amber) 38%, var(--color-border) 62%);
  color: var(--color-amber);
}

@media (max-width: 1180px) {
  .studio-projects-layout,
  .studio-project-board__main {
    grid-template-columns: 1fr;
  }

  .studio-projects-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

@media (max-width: 720px) {
  .studio-project-board-header,
  .studio-project-create__grid {
    grid-template-columns: 1fr;
  }
  .studio-project-board-header {
    display: grid;
  }
}
`
}

// Shared interaction-control styles for the cross-app primitive controls
// (Button, Input, Textarea, Select, MenuButton, SegmentedControl). The input /
// textarea / select-trigger / menu-trigger / segmented-option / field / popover
// rules previously lived ONLY in the desktop globals.css, so those controls
// rendered fully styled on desktop but with raw browser defaults on web. Single-
// sourced here (verbatim from the desktop globals, the design reference) so both
// apps render them identically.
//
// IMPORTANT — `.ui-button--primary` is deliberately NOT included here. The desktop
// (gradient `--accent-action-fill` / `--accent-line` / `--accent-action-foreground`)
// and the website (flat `--color-accent` / `--color-accent-hover`) render the
// primary button differently today, so each app keeps its own `.ui-button--primary`
// (and `:hover`) rule locally — moving either into the shared module would be a
// visual change. Every other button declaration is byte-identical across the apps,
// so the base interaction group, sizes, focus/active/disabled, the icon button, the
// secondary/ghost/danger variants, and the primary sheen `::after` are shared here.
export function controlsSurfaceCss(): string {
  return `
.ui-button,
.ui-icon-button,
.ui-input,
.ui-textarea,
.ui-select-trigger,
.ui-menu-trigger,
.ui-segmented-option {
  border: var(--border-width-1) solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out),
    transform var(--dur-2) var(--ease-out);
}

.ui-button,
.ui-icon-button,
.ui-select-trigger,
.ui-menu-trigger,
.ui-segmented-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-weight: 560;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.ui-button:focus-visible,
.ui-icon-button:focus-visible,
.ui-input:focus-visible,
.ui-textarea:focus-visible,
.ui-select-trigger:focus-visible,
.ui-menu-trigger:focus-visible,
.ui-segmented-option:focus-visible,
.ui-popover-item:focus-visible,
.ui-dialog:focus-visible {
  /* Solid, high-contrast focus ring (WCAG 2.2 SC 1.4.11, >=3:1). The transparent
     outline is invisible in normal rendering but is swapped for a system colour in
     forced-colors / Windows High Contrast mode, where box-shadows are dropped. */
  outline: 2px solid transparent;
  outline-offset: 2px;
  box-shadow: var(--ring-focus);
}

.ui-button:active:not(:disabled),
.ui-icon-button:active:not(:disabled),
.ui-select-trigger:active:not(:disabled),
.ui-menu-trigger:active:not(:disabled),
.ui-segmented-option:active:not(:disabled) {
  filter: brightness(0.92);
}

.ui-button:disabled,
.ui-icon-button:disabled,
.ui-input:disabled,
.ui-textarea:disabled,
.ui-select-trigger:disabled,
.ui-menu-trigger:disabled,
.ui-segmented-option:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.ui-button--sm {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
}

.ui-button--md {
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-button--lg {
  min-height: var(--control-h-lg);
  padding: 0 var(--space-4);
  font-size: var(--text-md);
  line-height: var(--lh-md);
}

.ui-button--full {
  width: 100%;
}

.ui-button--primary {
  position: relative;
  overflow: hidden;
  background: var(--accent-action-fill);
  color: var(--accent-action-foreground);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-button--primary::after {
  content: "";
  position: absolute;
  inset-block: -35%;
  inset-inline-start: -70%;
  width: 42%;
  transform: skewX(-18deg) translateX(0);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, #fff 42%, transparent), transparent);
  opacity: 0;
  pointer-events: none;
}

.ui-button--primary > *,
.ui-icon-button > * {
  position: relative;
  z-index: 1;
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--accent-action-fill);
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-button--primary:hover:not(:disabled)::after {
  opacity: 1;
  animation: ui-primary-sheen var(--dur-4) var(--ease-out) both;
}

.ui-button--secondary {
  background: var(--color-elevated);
  color: var(--color-text);
  border-color: var(--color-border);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-icon-button--secondary {
  background: var(--color-elevated);
  color: var(--color-text);
  border-color: var(--color-border);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-button--secondary:hover:not(:disabled),
.ui-icon-button--secondary:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-button--ghost,
.ui-icon-button--ghost {
  background: transparent;
  color: var(--color-text-secondary);
  border-color: transparent;
}

.ui-button--ghost:hover:not(:disabled),
.ui-icon-button--ghost:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.ui-button--danger,
.ui-icon-button--danger {
  background: color-mix(in srgb, var(--color-red) 12%, transparent);
  color: var(--color-red);
  border-color: color-mix(in srgb, var(--color-red) 34%, transparent);
}

.ui-button--danger:hover:not(:disabled),
.ui-icon-button--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-red) 18%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--color-red) 18%, transparent), var(--shadow-1);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-icon-button--primary {
  background: var(--accent-action-fill);
  color: var(--accent-action-foreground);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-icon-button--primary:hover:not(:disabled) {
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-icon-button {
  flex: none;
  padding: 0;
  position: relative;
}

.ui-icon-button--sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
}

.ui-icon-button--md {
  width: var(--control-h-md);
  height: var(--control-h-md);
}

.ui-icon-button--lg {
  width: var(--control-h-lg);
  height: var(--control-h-lg);
}

.ui-icon-button__badge {
  position: absolute;
  inset-block-start: calc(-1 * var(--space-1));
  inset-inline-end: calc(-1 * var(--space-1));
  display: inline-flex;
  min-width: var(--space-4);
  height: var(--space-4);
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-accent-foreground);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ui-field__chrome {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.ui-input,
.ui-textarea {
  width: 100%;
  background: color-mix(in srgb, var(--color-base) 70%, var(--color-elevated) 30%);
  border-color: var(--color-border-subtle);
  color: var(--color-text);
  font-family: var(--font-ui);
}

.ui-input::placeholder,
.ui-textarea::placeholder {
  color: var(--color-text-muted);
}

.ui-input:hover:not(:disabled),
.ui-textarea:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.ui-input[aria-invalid="true"],
.ui-textarea[aria-invalid="true"] {
  border-color: color-mix(in srgb, var(--color-red) 58%, var(--color-border));
}

.ui-input--sm {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
}

.ui-input--md {
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-input--lg {
  min-height: var(--control-h-lg);
  padding: 0 var(--space-4);
  font-size: var(--text-md);
  line-height: var(--lh-md);
}

.ui-field__left-icon {
  position: absolute;
  inset-inline-start: var(--space-3);
  color: var(--color-text-muted);
  pointer-events: none;
}

.ui-input--with-left-icon {
  padding-inline-start: calc(var(--space-6) + var(--space-3));
}

.ui-input--clearable {
  padding-inline-end: calc(var(--space-6) + var(--space-3));
}

.ui-input__clear {
  position: absolute;
  inset-inline-end: var(--space-1);
  color: var(--color-text-muted);
}

.ui-field__message {
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
  color: var(--color-text-muted);
}

.ui-field__message--error {
  color: var(--color-red);
}

.ui-textarea {
  min-height: calc(var(--control-h-lg) + var(--space-4));
  max-height: var(--ui-textarea-max-height, none);
  resize: vertical;
  padding: var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-popover-root {
  position: relative;
  display: inline-block;
  min-width: 0;
}

.ui-select-trigger,
.ui-menu-trigger {
  width: 100%;
  min-height: var(--control-h-md);
  justify-content: space-between;
  background: color-mix(in srgb, var(--color-base) 70%, var(--color-elevated) 30%);
  border-color: var(--color-border-subtle);
  color: var(--color-text);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-select-trigger:hover:not(:disabled),
.ui-menu-trigger:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.ui-popover {
  position: absolute;
  inset-block-start: calc(100% + var(--space-1));
  inset-inline-start: 0;
  z-index: var(--z-dropdown);
  min-width: 100%;
  max-height: min(var(--primitive-popover-max-h), calc(100vh - var(--space-12)));
  overflow: auto;
  border: var(--border-width-1) solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-3), var(--specular-strong);
  padding: var(--space-1);
  transform-origin: top left;
  animation: ui-popover-in var(--dur-2) var(--ease-spring) both;
}

.ui-popover-item {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  text-align: start;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

/* Two-line variant: a 40px row for menu items that carry a sublabel under the
   primary label. Top-aligns the content so the label/sublabel pair reads as a
   block, and adds vertical padding so the taller row keeps the same inset. */
.ui-popover-item--two-line {
  align-items: flex-start;
  min-height: var(--control-h-lg);
  padding: var(--space-2) var(--space-3);
}

.ui-popover-item:hover:not(:disabled),
.ui-popover-item[data-active="true"] {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

/* Selected = the current choice. listbox/option menus express this with
   aria-selected; menu/menuitem menus (where aria-selected is invalid) use
   aria-current. Both drive the same inset accent ring so every popover menu
   signals "selected" identically. */
.ui-popover-item[aria-selected="true"],
.ui-popover-item[aria-current="true"] {
  color: var(--color-text);
  box-shadow: var(--ring-selected);
}

/* Destructive action row (e.g. Delete). Keeps the red text through rest and
   hover so the affordance reads as dangerous, while sharing the row geometry
   and muted hover background of every other popover item. */
.ui-popover-item--danger,
.ui-popover-item--danger:hover:not(:disabled),
.ui-popover-item--danger[data-active="true"] {
  color: var(--color-red);
}

.ui-popover-item__content {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
}

.ui-popover-item__label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.ui-popover-item__hint {
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-popover-item:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

/* Segmented control — pill track with a sliding active thumb. Track radius
   --radius-sm (7px); the track wraps the --control-h-xs options to an outer
   height that lines up with sibling md controls. */
.ui-segmented-control {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-1);
  overflow: hidden;
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-base) 64%, var(--color-elevated) 36%);
  box-shadow: var(--specular);
  padding: var(--space-1);
}

.ui-segmented-thumb {
  position: absolute;
  inset-block: var(--space-1);
  inset-inline-start: var(--space-1);
  width: calc((100% - (var(--space-1) * (var(--ui-segment-count) + 1))) / var(--ui-segment-count));
  border-radius: var(--radius-sm);
  background: var(--color-surface-active);
  box-shadow: var(--shadow-1), var(--specular);
  transform: translateX(calc(var(--ui-segment-index) * (100% + var(--space-1))));
  transition:
    transform var(--dur-3) var(--ease-out),
    width var(--dur-3) var(--ease-spring),
    background var(--dur-2) var(--ease-out),
    box-shadow var(--dur-2) var(--ease-out);
  pointer-events: none;
}

.ui-segmented-option {
  position: relative;
  z-index: 1;
  min-height: var(--control-h-xs);
  background: transparent;
  color: var(--color-text-muted);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

/* Visible helper text for the active segmented option (on-screen guidance for
   consequential choices, instead of an invisible title tooltip). */
.ui-segmented-description {
  display: block;
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-segmented-option:hover:not(:disabled) {
  color: var(--color-text-secondary);
}

.ui-segmented-option[aria-checked="true"] {
  background: transparent;
  color: var(--color-text);
  box-shadow: none;
}

/* Canonical on/off toggle (the <Switch> primitive). Geometry is token-derived:
   the thumb fills the track height minus a 1-step inset on each side, and the
   "on" travel equals track width minus track height. */
.ui-switch {
  --ui-switch-inset: var(--space-1);
  position: relative;
  width: var(--space-10);
  height: var(--space-5);
  border-radius: var(--radius-full);
  background: var(--color-border);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.ui-switch:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ui-switch--on {
  background: var(--color-accent);
}

.ui-switch__thumb {
  position: absolute;
  inset-block-start: var(--ui-switch-inset);
  inset-inline-start: var(--ui-switch-inset);
  width: calc(var(--space-5) - 2 * var(--ui-switch-inset));
  height: calc(var(--space-5) - 2 * var(--ui-switch-inset));
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%);
  transition: transform var(--dur-1) var(--ease-out);
}

.ui-switch--on .ui-switch__thumb {
  transform: translateX(calc(var(--space-10) - var(--space-5)));
}
`
}

// Shared base styles for the cross-app UI primitives (EmptyState, Skeleton). These
// were previously defined only in the desktop globals.css, so the shared EmptyState /
// Skeleton components rendered fully styled on desktop but as bare unstyled <div>s on
// web. Single-sourced here so both apps render them identically.
export function primitivesSurfaceCss(): string {
  return `
/* Cooled warm semantics: the warning/danger hues lean toward the cool palette so
   amber/pink chips stop screaming against the indigo surfaces. These chip tokens
   (and the --color-warning/--color-danger aliases routed through them) back the
   tonal badge recipe below and the semantic status pills consumed by components. */
:root {
  --chip-warning: color-mix(in srgb, var(--color-amber) 70%, var(--color-info));
  --chip-danger: color-mix(in srgb, var(--color-red) 80%, var(--color-info));
  --color-warning: var(--chip-warning);
  --color-danger: var(--chip-danger);
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
export function sharedKeyframesCss(): string {
  return `
@keyframes ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes studio-status-heartbeat {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 45%, transparent); }
  70%, 100% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-accent) 0%, transparent); }
}

@keyframes ui-popover-in {
  from { opacity: 0; transform: translateY(calc(-1 * var(--space-1))) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes ui-view-transition-in {
  from { opacity: 0; transform: translateY(var(--space-2)); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes ui-view-transition-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(calc(-1 * var(--space-1))); }
}

::view-transition-old(root) {
  animation: ui-view-transition-out var(--dur-2) var(--ease-out) both;
}

::view-transition-new(root) {
  animation: ui-view-transition-in var(--dur-3) var(--ease-spring) both;
}

@keyframes ui-dialog-in {
  from { opacity: 0; transform: translateX(-50%) translateY(var(--space-3)) scale(0.985); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}

@keyframes ui-drawer-in {
  from { opacity: 0.6; transform: translateX(var(--space-6)); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes ui-drawer-left-in {
  from { opacity: 0.6; transform: translateX(calc(-1 * var(--space-6))); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes ui-primary-sheen {
  from { transform: skewX(-18deg) translateX(0); }
  to { transform: skewX(-18deg) translateX(430%); }
}

@keyframes ui-status-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

@keyframes ui-progress-shimmer {
  from { background-position: 220% 0; }
  to { background-position: -220% 0; }
}

@keyframes ui-stream-shimmer {
  to { background-position: -220% 0; }
}

@keyframes ui-stream-caret {
  50% { opacity: 0; }
}

@keyframes ui-polish-row-in {
  from { opacity: 0; transform: translateX(calc(-1 * var(--space-2))); }
  to { opacity: 1; transform: translateX(0); }
}
`
}

export function studioSurfaceStyles(): string {
  return [sharedKeyframesCss(), controlsSurfaceCss(), primitivesSurfaceCss(), artifactsSurfaceCss(), knowledgeGraphCss(), approvalsSurfaceCss(), wikiSurfaceCss(), channelsSurfaceCss(), projectsSurfaceCss()].join('\n')
}
