// Domain: artifacts-surface
// Ownership: packages/ui Studio surface CSS (Artifacts library surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

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
