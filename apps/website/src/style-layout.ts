export function cloudWebsiteLayoutStyles() {
  return String.raw`    .shell {
      position: relative;
      z-index: 1;
      height: 100vh;
      min-height: 100vh;
      display: grid;
      grid-template-columns: var(--cloud-shell-sidebar-w) minmax(0, 1fr);
      background: color-mix(in srgb, var(--color-base) 94%, var(--color-elevated) 6%);
      overflow: hidden;
    }
    .nav {
      position: sticky;
      top: 0;
      align-self: start;
      min-height: 100vh;
      max-height: 100vh;
      background: color-mix(in srgb, var(--color-base) 88%, var(--color-elevated) 12%);
      border-right: var(--border-width-1) solid var(--color-border-subtle);
      padding: var(--row-pad);
      display: flex;
      flex-direction: column;
      gap: var(--gap);
      box-shadow: inset -1px 0 0 var(--color-border-subtle);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
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
      background: var(--accent-action-fill);
      color: var(--accent-action-foreground);
      font-family: var(--font-display);
      font-weight: 800;
      box-shadow: var(--glow-soft), var(--specular);
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
      font-weight: 650;
      letter-spacing: var(--tracking-display);
    }
    .brand-title {
      overflow: hidden;
      font-size: var(--text-md);
      line-height: var(--lh-md);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    h1 {
      font-size: var(--text-lg);
      line-height: var(--lh-lg);
    }
    h2 {
      font-size: var(--text-xl);
      letter-spacing: var(--tracking-tight);
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
    .workspace-card,
    .role-card {
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--surface-highlight);
      padding: var(--row-pad);
      min-width: 0;
    }
    .workspace-card-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-width: 0;
    }
    .workspace-card strong,
    .role-card strong {
      overflow: hidden;
      color: var(--text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sidebar-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2);
    }
    .sidebar-actions button {
      width: 100%;
    }
    .sidebar-utility {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-3);
    }
    .sidebar-utility button {
      min-height: var(--control-h-sm);
      padding: 0 var(--space-2);
      font-size: var(--text-xs);
    }
    .sidebar-search {
      display: grid;
      gap: var(--space-1);
    }
    .sidebar-search input {
      min-height: var(--control-h-sm);
      border-radius: var(--radius-lg);
      background: var(--color-elevated);
      font-size: var(--text-xs);
    }
    .sidebar-thread-pane {
      min-height: 120px;
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-2);
      overflow: hidden;
    }
    .sidebar-pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      font-size: var(--text-2xs);
      font-weight: 750;
      line-height: var(--lh-2xs);
      padding: 0 var(--space-2);
      text-transform: uppercase;
    }
    .sidebar-thread-list {
      display: grid;
      gap: var(--space-1);
      overflow: auto;
      padding-right: var(--space-1);
    }
    .sidebar-thread-row {
      width: 100%;
      min-height: calc(var(--control-h-sm) + var(--space-2));
      justify-content: space-between;
      border-color: transparent;
      background: transparent;
      padding: var(--row-pad) var(--space-2);
      text-align: left;
    }
    .sidebar-thread-row:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .sidebar-thread-row[data-selected="true"] {
      background: var(--color-surface-active);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .sidebar-thread-main {
      display: grid;
      min-width: 0;
      gap: 1px;
    }
    .sidebar-thread-main strong,
    .sidebar-thread-main small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sidebar-empty {
      padding: var(--space-2);
      text-align: center;
    }
    .nav-sections {
      display: grid;
      gap: var(--space-3);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-3);
    }
    .nav-group {
      display: grid;
      gap: var(--space-2);
    }
    .admin-nav {
      margin-top: auto;
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-3);
    }
    .admin-nav summary {
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-elevated) 56%, transparent);
      color: var(--color-text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--text-sm);
      font-weight: 650;
      line-height: var(--lh-sm);
      list-style: none;
      padding: calc(var(--space-2) - var(--border-width-1)) var(--space-3);
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        color var(--dur-1) var(--ease-out);
    }
    .admin-nav summary::-webkit-details-marker {
      display: none;
    }
    .admin-nav summary:hover {
      background: var(--color-surface-hover);
      color: var(--text);
    }
    .admin-nav summary:focus-visible {
      outline: 0;
      box-shadow: var(--ring-focus);
    }
    .admin-nav summary::after {
      content: '+';
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .admin-nav[open] summary {
      background: var(--color-surface-active);
      border-color: var(--color-border-strong);
      color: var(--text);
    }
    .admin-nav[open] summary::after {
      content: '-';
      color: var(--accent-text);
    }
    .admin-nav .nav-links {
      margin-top: var(--space-2);
    }
    .admin-nav:not([open]) .nav-links {
      display: none;
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
      border-color: var(--color-border-strong);
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
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .main {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .topbar {
      min-height: 52px;
      border-bottom: var(--border-width-1) solid var(--color-border);
      background: color-mix(in srgb, var(--color-elevated) 84%, var(--color-base) 16%);
      padding: 0 var(--space-4);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      box-shadow: var(--surface-highlight);
      z-index: var(--z-sticky);
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .cloud-theme-controls {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .cloud-theme-switcher {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 650;
    }
    .cloud-theme-switcher select {
      min-height: var(--control-h-sm);
      max-width: 150px;
    }
    .cloud-theme-switcher select:disabled {
      opacity: 0.72;
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
      min-height: 0;
      overflow: auto;
      padding: var(--space-4);
      display: grid;
      align-content: stretch;
    }
    .section {
      border-top: 0;
      padding-top: 0;
      display: grid;
      gap: var(--space-4);
      min-width: 0;
      min-height: 0;
    }
    [data-route-panel][hidden], [data-route-link][hidden] {
      display: none;
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
      grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
      gap: var(--space-3);
      align-items: start;
      min-width: 0;
    }
    body[data-surface="workbench"] .parity-grid {
      display: none;
    }
    body[data-surface="admin"] .sidebar-search,
    body[data-surface="admin"] .sidebar-thread-pane,
    body[data-surface="admin"] [data-thread-search-focus="true"] {
      display: none;
    }
    body[data-surface="admin"] .sidebar-actions {
      grid-template-columns: 1fr;
    }
    [data-route-panel="chat"] {
      grid-template-rows: minmax(0, 1fr);
      height: 100%;
    }
    .cloud-chat-workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
      min-width: 0;
      min-height: 0;
      height: 100%;
      align-items: stretch;
    }
    .cloud-chat-workbench .parity-grid {
      display: none;
    }
    body[data-chat-state="thread"] .cloud-chat-workbench[data-review-open="true"] {
      grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    }
    body:not([data-chat-state="thread"]) .cloud-chat-workbench,
    body[data-chat-state="empty"] .cloud-chat-workbench {
      grid-template-columns: minmax(0, 1fr);
    }
    body:not([data-chat-state="thread"]) .chat-inspector,
    body[data-chat-state="empty"] .chat-inspector {
      display: none;
    }
    @media (max-width: 920px) {
      .shell {
        height: auto;
        min-height: 100vh;
        grid-template-columns: 1fr;
        overflow: auto;
      }
      .nav {
        position: static;
        min-height: 0;
        max-height: none;
        border-right: 0;
        border-bottom: var(--border-width-1) solid var(--color-border-subtle);
      }
      .grid, .form-grid, .workbench-split, .cloud-chat-workbench {
        grid-template-columns: 1fr;
      }
      .sidebar-thread-pane {
        max-height: 280px;
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
