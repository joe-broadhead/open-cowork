// Domain: channels-surface
// Ownership: packages/ui Studio surface CSS (Channels / gateway surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

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
