export function cloudWebsiteLayoutStyles() {
  return String.raw`    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: var(--cloud-shell-sidebar-w) minmax(0, 1fr);
      background: color-mix(in srgb, var(--color-base) 94%, var(--color-elevated) 6%);
    }
    .nav {
      position: sticky;
      top: 0;
      align-self: start;
      min-height: 100vh;
      background: color-mix(in srgb, var(--color-base) 88%, var(--color-elevated) 12%);
      border-right: var(--border-width-1) solid var(--color-border-subtle);
      padding: var(--space-5) var(--space-4);
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      box-shadow: inset -1px 0 0 var(--color-border-subtle);
      z-index: var(--z-sticky);
    }
    .brand {
      display: grid;
      grid-template-columns: var(--control-h-lg) minmax(0, 1fr);
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
    }
    .mark, .brand-logo {
      width: var(--control-h-lg);
      height: var(--control-h-lg);
      border-radius: var(--radius-sm);
      flex: 0 0 auto;
    }
    .mark {
      display: grid;
      place-items: center;
      background: var(--accent);
      color: var(--color-accent-foreground);
      font-family: var(--font-display);
      font-weight: 800;
      box-shadow: var(--ring-selected);
    }
    .brand-logo {
      object-fit: contain;
      background: var(--color-surface);
      border: var(--border-width-1) solid var(--line);
    }
    .brand-title, h1, h2, h3 {
      margin: 0;
      color: var(--text);
      font-family: var(--font-display);
      font-weight: 750;
      letter-spacing: 0;
    }
    .brand-title {
      overflow: hidden;
      font-size: var(--text-md);
      line-height: var(--lh-md);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    h1 {
      font-size: var(--text-2xl);
      line-height: var(--lh-2xl);
    }
    h2 {
      font-size: var(--text-xl);
      line-height: var(--lh-xl);
    }
    h3 {
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .meta, small {
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .nav-sections {
      display: grid;
      gap: var(--space-4);
    }
    .nav-group {
      display: grid;
      gap: var(--space-2);
    }
    .nav-heading {
      color: var(--muted);
      font-size: var(--text-2xs);
      font-weight: 750;
      letter-spacing: 0.08em;
      line-height: var(--lh-2xs);
      padding: 0 var(--space-3);
      text-transform: uppercase;
    }
    .nav-links {
      display: grid;
      gap: var(--space-1);
    }
    .nav-links a {
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid transparent;
      border-radius: var(--radius-sm);
      padding: calc(var(--space-2) - var(--border-width-1)) var(--space-3);
      color: var(--color-text-secondary);
      display: flex;
      align-items: center;
      font-size: var(--text-sm);
      font-weight: 650;
      line-height: var(--lh-sm);
      text-decoration: none;
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-1) var(--ease-out);
    }
    .nav-links a:hover {
      background: var(--color-surface-hover);
      color: var(--text);
    }
    .nav-links a[data-active="true"] {
      background: var(--color-surface-active);
      border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border) 70%);
      box-shadow: var(--ring-selected);
      color: var(--text);
    }
    .nav-links a[data-active="true"]:focus-visible {
      box-shadow: var(--ring-selected), var(--ring-focus);
    }
    .nav-links a[data-locked="true"] {
      color: var(--muted);
    }
    .brand-links {
      margin-top: auto;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .topbar {
      min-height: 72px;
      border-bottom: var(--border-width-1) solid var(--color-border-subtle);
      background: color-mix(in srgb, var(--color-elevated) 84%, var(--color-base) 16%);
      padding: var(--space-4) var(--space-6);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      box-shadow: 0 1px 0 var(--color-border-subtle), 0 10px 28px rgba(0, 0, 0, 0.12);
      z-index: var(--z-sticky);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .status {
      min-height: var(--control-h-sm);
      display: inline-flex;
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      background: var(--tone-neutral-bg);
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 650;
      line-height: var(--lh-xs);
      padding: 0 var(--space-3);
    }
    .status[data-kind="error"] {
      background: var(--tone-danger-bg);
      border-color: var(--tone-danger-border);
      color: var(--danger);
    }
    .status[data-kind="warn"] {
      background: var(--tone-warn-bg);
      border-color: var(--tone-warn-border);
      color: var(--warn);
    }
    .status[data-kind="ok"] {
      background: var(--tone-ok-bg);
      border-color: var(--tone-ok-border);
      color: var(--ok);
    }
    .content {
      min-width: 0;
      overflow: auto;
      padding: var(--space-6);
      display: grid;
      gap: var(--space-5);
      align-content: start;
    }
    .section {
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-5);
      display: grid;
      gap: var(--space-4);
      min-width: 0;
    }
    [data-route-panel][hidden], [data-route-link][hidden] {
      display: none;
    }
    .section:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .section-header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      min-width: 0;
    }
    .workbench-split {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
      gap: var(--space-3);
      align-items: start;
      min-width: 0;
    }
    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .nav {
        position: static;
        min-height: 0;
        border-right: 0;
        border-bottom: var(--border-width-1) solid var(--color-border-subtle);
      }
      .grid, .form-grid, .workbench-split {
        grid-template-columns: 1fr;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
        padding: var(--space-4);
      }
      .topbar-actions {
        justify-content: flex-start;
      }
      .content {
        padding: var(--space-4);
      }
    }`
}
