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
    .ui-button,
    .ui-icon-button {
      border: var(--border-width-1) solid transparent;
      border-radius: var(--radius-sm);
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-1) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    .ui-button,
    .ui-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      font-weight: 650;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .ui-button:focus-visible,
    .ui-icon-button:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .ui-button:active:not(:disabled),
    .ui-icon-button:active:not(:disabled) {
      transform: scale(0.96);
    }
    .ui-button:disabled,
    .ui-icon-button:disabled {
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
      padding: 0 var(--space-4);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .ui-button--lg {
      min-height: var(--control-h-lg);
      padding: 0 var(--space-5);
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .ui-button--full {
      width: 100%;
    }
    .ui-button--primary {
      position: relative;
      overflow: hidden;
      border-color: color-mix(in srgb, var(--color-accent) 82%, var(--color-text) 18%);
      background: var(--color-accent);
      color: var(--color-accent-foreground);
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
      background: var(--color-accent-hover);
      box-shadow: var(--glow-accent), var(--shadow-2), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    .ui-button--primary:hover:not(:disabled)::after {
      opacity: 1;
      animation: ui-primary-sheen var(--dur-4) var(--ease-out) both;
    }
    .ui-button--secondary,
    .ui-icon-button--secondary {
      border-color: var(--color-border);
      background: var(--color-elevated);
      color: var(--color-text);
      box-shadow: var(--shadow-1), var(--specular);
    }
    .ui-button--secondary:hover:not(:disabled),
    .ui-icon-button--secondary:hover:not(:disabled) {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
      box-shadow: var(--shadow-2), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    .ui-button--ghost,
    .ui-icon-button--ghost {
      border-color: transparent;
      background: transparent;
      color: var(--color-text-secondary);
    }
    .ui-button--ghost:hover:not(:disabled),
    .ui-icon-button--ghost:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .ui-button--danger,
    .ui-icon-button--danger {
      border-color: color-mix(in srgb, var(--color-red) 34%, transparent);
      background: color-mix(in srgb, var(--color-red) 12%, transparent);
      color: var(--color-red);
    }
    .ui-button--danger:hover:not(:disabled),
    .ui-icon-button--danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--color-red) 18%, transparent);
      box-shadow: 0 0 18px color-mix(in srgb, var(--color-red) 18%, transparent), var(--shadow-1);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    .ui-icon-button {
      position: relative;
      flex: none;
      padding: 0;
    }
    .ui-icon-button--sm {
      width: var(--control-h-sm);
      height: var(--control-h-sm);
    }
    .ui-icon-button--md {
      width: var(--control-h-md);
      height: var(--control-h-md);
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
    .ui-card {
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-2), var(--specular);
      color: var(--color-text);
    }
    .ui-card--sm { padding: var(--space-3); }
    .ui-card--md { padding: var(--space-4); }
    .ui-card--lg { padding: var(--space-6); }
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
    .ui-card--interactive:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
      box-shadow: var(--shadow-3), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }`
}
