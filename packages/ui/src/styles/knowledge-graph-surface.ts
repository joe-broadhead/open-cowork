// Domain: knowledge-graph-surface
// Ownership: packages/ui Studio surface CSS (Knowledge graph surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

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
