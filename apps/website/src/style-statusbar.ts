// Global session status footer — the cloud port of the desktop StatusBar.
//
// Visual treatment mirrors the desktop StatusBar (status dot + label on the
// left, a clickable token/cost cluster on the right that expands a session-usage
// breakdown). The cloud session projection only carries status/isGenerating,
// sessionCost, and the sessionTokens breakdown, so this row shows those honestly
// and omits the desktop-only context meter, model name, and all-sessions total.
// Reuses the shared design tokens and the shared .studio-status-dot dot, so it
// reads identically to the desktop chrome.
export function cloudWebsiteStatusBarStyles() {
  return String.raw`    .statusbar-root {
      min-height: 26px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: 0 var(--space-4);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      background: color-mix(in srgb, var(--color-base) 92%, var(--color-elevated) 8%);
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      line-height: var(--lh-2xs);
      user-select: none;
      z-index: var(--z-sticky);
    }
    .statusbar-slot {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
    }
    .statusbar-inner {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
    }
    .statusbar-status {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
    }
    .statusbar-status-label {
      color: var(--color-text-secondary);
      font-weight: 560;
    }
    .statusbar-usage {
      position: relative;
    }
    .statusbar-usage-summary {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      cursor: pointer;
      list-style: none;
      transition: color var(--dur-1) var(--ease-out);
    }
    .statusbar-usage-summary::-webkit-details-marker { display: none; }
    .statusbar-usage-summary:hover { color: var(--color-text-secondary); }
    .statusbar-divider { color: var(--color-border); }
    .statusbar-detail {
      position: absolute;
      bottom: calc(100% + var(--space-2));
      right: 0;
      z-index: var(--z-popover);
      width: 224px;
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%);
      box-shadow: var(--shadow-2), var(--specular);
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
    }
    .statusbar-detail-title {
      margin-bottom: var(--space-1);
      font-size: var(--text-2xs);
      font-weight: 750;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-text-muted);
    }
    .statusbar-detail-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .statusbar-detail-label { color: var(--color-text-muted); }
    .statusbar-detail-value {
      color: var(--color-text);
      font-family: var(--font-mono);
    }`
}
