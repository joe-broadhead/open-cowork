export function cloudWebsitePrimitiveStyles() {
  return String.raw`    .ui-control-stack {
      display: inline-flex;
      min-width: 0;
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-1);
    }
    .ui-disabled-reason {
      display: inline-flex;
      max-width: 100%;
      align-items: center;
      gap: var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      line-height: var(--lh-2xs);
    }
    .ui-tooltip-anchor {
      position: relative;
      display: inline-flex;
    }
    .ui-tooltip {
      position: fixed;
      z-index: var(--z-tooltip);
      max-width: min(var(--primitive-tooltip-max-w), calc(100vw - var(--space-8)));
      border: var(--border-width-1) solid var(--glass-border);
      border-radius: var(--radius-sm);
      background: var(--glass-bg);
      backdrop-filter: var(--glass-blur);
      box-shadow: var(--shadow-3), var(--specular);
      color: var(--color-text);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      padding: var(--space-2) var(--space-3);
      pointer-events: none;
      animation: ui-popover-in var(--dur-2) var(--ease-spring) both;
    }
    /* All primitive-control rules — the base interaction group, focus/active/disabled,
       button sizes, the icon button, the secondary/ghost/danger variants, and
       ui-button--primary (base + :hover + sheen ::after, the canonical Studio
       accent-action gradient fill) — are single-sourced in @open-cowork/ui
       controlsSurfaceCss() (embedded above in styles.ts), so the website renders them
       identically to the desktop. */
    .ui-card {
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-2);
      color: var(--color-text);
    }
    .ui-card--specular {
      box-shadow: var(--shadow-2), var(--specular);
    }
    .ui-card--sm { padding: calc(var(--row-pad) + var(--space-1)); }
    .ui-card--md { padding: calc(var(--row-pad) + var(--space-2)); }
    .ui-card--lg { padding: calc(var(--row-pad) + var(--space-4)); }
    .ui-card--variant-flat {
      background: var(--color-surface);
      box-shadow: none;
    }
    .ui-card--variant-tile {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
    }
    .ui-card__tile {
      display: inline-flex;
      width: var(--control-h-lg);
      height: var(--control-h-lg);
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-md);
      background: var(--accent-soft);
      color: var(--accent-text);
      box-shadow: inset 0 0 0 var(--border-width-1) var(--accent-line);
    }
    .ui-card--interactive {
      display: block;
      width: 100%;
      cursor: pointer;
      font: inherit;
      text-align: start;
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-2) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    .ui-card--interactive.ui-card--variant-tile {
      display: grid;
    }
    .ui-card--interactive:hover,
    .ui-card--hover-lift:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
      box-shadow: var(--shadow-3), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    /* The Dialog surface (.ui-dialog + backdrop/drawer variants + __header,
       __title, __body, __footer) is single-sourced in @open-cowork/ui
       primitivesSurfaceCss(), embedded after this block in styles.ts, so the
       website renders it identically to the desktop. */`
}
