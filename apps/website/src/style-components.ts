export function cloudWebsiteComponentStyles() {
  return String.raw`    a {
      color: var(--accent-text);
      text-decoration: none;
      transition: color var(--dur-1) var(--ease-out);
    }
    a:hover {
      color: var(--accent-text);
      text-decoration: underline;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .cloud-confirm-body {
      margin: 0;
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      color: var(--color-text-secondary);
    }
    button {
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-elevated);
      color: var(--text);
      padding: 0 var(--space-4);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      cursor: pointer;
      font-size: var(--text-sm);
      font-weight: 650;
      line-height: var(--lh-sm);
      white-space: nowrap;
      user-select: none;
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-1) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
      border-color: var(--color-border-strong);
    }
    button:active:not(:disabled) {
      transform: scale(0.96);
    }
    .ui-progress-shimmer {
      background-image: linear-gradient(
        90deg,
        color-mix(in srgb, var(--accent) 56%, transparent),
        var(--accent),
        color-mix(in srgb, var(--accent) 56%, transparent)
      ) !important;
      background-size: 220% 100% !important;
      box-shadow: var(--glow-soft);
      animation: ui-progress-shimmer 1.25s linear infinite;
    }
    button.primary {
      position: relative;
      overflow: hidden;
      background: var(--accent-action-fill);
      border-color: var(--accent-line);
      color: var(--accent-action-foreground);
      box-shadow: var(--shadow-1), var(--specular);
    }
    button.primary::after {
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
    button.primary > * {
      position: relative;
      z-index: 1;
    }
    button.primary:hover:not(:disabled) {
      background: var(--accent-action-fill);
      border-color: var(--accent-line);
      box-shadow: var(--shadow-2), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    button.primary:hover:not(:disabled)::after {
      opacity: 1;
      animation: ui-primary-sheen var(--dur-4) var(--ease-out) both;
    }
    button.secondary {
      background: var(--color-elevated);
      color: var(--accent-text);
      box-shadow: var(--shadow-1), var(--specular);
    }
    button.ghost {
      background: transparent;
      border-color: transparent;
      color: var(--color-text-secondary);
    }
    button.ghost:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--text);
    }
    button.danger {
      background: var(--tone-danger-bg);
      border-color: var(--tone-danger-border);
      color: var(--danger);
    }
    button.danger:hover:not(:disabled) {
      background: color-mix(in srgb, var(--color-red) 18%, var(--color-elevated) 82%);
    }
    button:disabled, input:disabled, select:disabled, textarea:disabled {
      opacity: 0.52;
      cursor: not-allowed;
    }
    input, select, textarea {
      width: 100%;
      min-width: 0;
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid var(--field-border);
      border-radius: var(--radius-sm);
      background: var(--field-bg);
      color: var(--text);
      padding: 0 var(--space-3);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-1) var(--ease-out);
    }
    input:hover:not(:disabled), select:hover:not(:disabled), textarea:hover:not(:disabled) {
      border-color: var(--color-border);
    }
    input::placeholder, textarea::placeholder {
      color: var(--color-text-muted);
    }
    textarea {
      min-height: 112px;
      padding: var(--space-3);
      resize: vertical;
      line-height: var(--lh-sm);
    }
    input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    label {
      display: grid;
      gap: var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      min-width: 0;
    }
    label span {
      color: var(--text);
      font-size: var(--text-sm);
      font-weight: 650;
      line-height: var(--lh-sm);
    }
    .panel {
      min-width: 0;
      display: grid;
      gap: var(--gap);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      color: var(--text);
      padding: calc(var(--row-pad) + var(--space-2));
      box-shadow: var(--shadow-2), var(--specular);
    }
    .panel h3 {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--text-md);
      font-weight: 650;
      letter-spacing: var(--tracking-display);
      line-height: var(--lh-md);
    }
    .parity-grid,
    .surface-grid {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--gap);
      min-width: 0;
    }
    .parity-card,
    .surface-card {
      min-width: 0;
      display: grid;
      gap: calc(var(--gap) * 0.5);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-surface) 76%, transparent);
      padding: calc(var(--row-pad) + var(--space-1));
    }
    .agent-card,
    .capability-card {
      position: relative;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--gap);
      align-items: start;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      padding: calc(var(--row-pad) + var(--space-1));
      box-shadow: var(--shadow-2), var(--specular);
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-2) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    .agent-card:hover,
    .capability-card:hover {
      border-color: var(--color-border-strong);
      background: color-mix(in srgb, var(--color-elevated) 74%, var(--color-surface-hover) 26%);
      box-shadow: var(--shadow-3), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    .capability-card {
      grid-template-columns: 1fr;
    }
    .surface-card-main {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }
    .surface-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-width: 0;
    }
    .surface-card-header strong {
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-card .surface-card-header {
      justify-content: flex-start;
    }
    .agent-card .surface-card-header strong {
      flex: 1;
    }
    .surface-card-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
    }
    .parity-card[data-parity-availability="intentionally-unavailable"],
    .parity-card[data-parity-availability="desktop-only"] {
      background: color-mix(in srgb, var(--color-amber) 8%, var(--color-surface) 92%);
      border-color: var(--tone-warn-border);
    }
    .parity-card p,
    .surface-card p {
      margin: 0;
      color: var(--text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      align-items: end;
      min-width: 0;
    }
    .form-grid .span {
      grid-column: 1 / -1;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: end;
      min-width: 0;
    }
    .toolbar label {
      flex: 1 1 150px;
    }
    .check-row {
      display: flex;
      gap: var(--space-3);
      flex-wrap: wrap;
      align-items: center;
    }
    .check-row label {
      display: flex;
      grid-template-columns: none;
      align-items: center;
      flex-direction: row;
      gap: var(--space-2);
      color: var(--text);
      font-size: var(--text-sm);
    }
    .check-row input {
      width: auto;
      min-height: 0;
    }
    .list {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }
    .table-shell {
      display: grid;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-2), var(--specular);
      min-width: 0;
    }
    .table-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.4fr) minmax(90px, 0.6fr) minmax(110px, 0.7fr) minmax(120px, 0.7fr);
      gap: var(--gap);
      min-height: calc(var(--control-h-sm) + (var(--row-pad) * 2));
      align-items: center;
      padding: 0 var(--space-3);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .table-row:first-child {
      border-top: 0;
    }
    .table-head {
      min-height: var(--control-h-md);
      background: var(--color-surface-hover);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
    }
        .table-row > [role="cell"] {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .thread-list-panel .table-shell {
          border-radius: var(--radius-lg);
          background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
        }
        .thread-list-panel .table-row {
          grid-template-columns: minmax(0, 1fr) auto;
          min-width: 0;
        }
        .thread-row {
          position: relative;
          width: 100%;
          text-align: left;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-radius: 0;
      background: transparent;
      color: var(--text);
    }
    .thread-row:hover:not(:disabled) {
      background: var(--color-surface-hover);
      transform: translateX(var(--space-1));
    }
        .thread-row[data-selected="true"] {
          background: var(--color-surface-active);
          box-shadow: inset 3px 0 0 var(--accent);
        }
        .thread-row-meta {
          display: block;
          margin-top: 1px;
          overflow: hidden;
          color: var(--color-text-muted);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
    .row-link {
      min-height: 0;
      width: 100%;
      border: 0;
      border-radius: var(--radius-xs);
      background: transparent;
      color: inherit;
      display: block;
      padding: var(--space-1) 0;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .row-link:hover {
      color: var(--accent-text);
      border-color: transparent;
      background: transparent;
      text-decoration: underline;
    }
    .empty-row {
      color: var(--color-text-muted);
    }
    .row {
      position: relative;
      min-height: calc(var(--control-h-md) + (var(--row-pad) * 2));
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--row-pad) var(--space-3);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--gap);
      align-items: center;
      background: var(--color-surface);
      min-width: 0;
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-2) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    .row:hover {
      background: var(--color-surface-hover);
      border-color: var(--color-border-strong);
      transform: translateX(var(--space-1));
    }
    .ui-polish-list-row,
    .thread-row,
    .sidebar-thread-row,
    .row {
      position: relative;
      transition:
        background var(--dur-1) var(--ease-out),
        border-color var(--dur-1) var(--ease-out),
        color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-2) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
    }
    .ui-polish-list-row::before,
    .thread-row::before,
    .sidebar-thread-row::before,
    .row::before {
      content: "";
      position: absolute;
      inset-block: var(--space-2);
      inset-inline-start: 0;
      width: 2px;
      border-radius: var(--radius-full);
      background: var(--accent-gradient);
      box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 42%, transparent);
      opacity: 0;
      transform: scaleY(0);
      transform-origin: center;
      transition:
        opacity var(--dur-2) var(--ease-out),
        transform var(--dur-2) var(--ease-spring);
      pointer-events: none;
    }
    .ui-polish-list-row:hover:not(:disabled)::before,
    .thread-row:hover:not(:disabled)::before,
    .sidebar-thread-row:hover:not(:disabled)::before,
    .row:hover::before,
    .ui-polish-list-row[aria-pressed="true"]::before,
    .ui-polish-list-row[data-selected="true"]::before,
    .thread-row[data-selected="true"]::before,
    .sidebar-thread-row[data-selected="true"]::before {
      opacity: 1;
      transform: scaleY(1);
    }
    .ui-polish-list-row[data-polish-stagger] {
      animation: ui-polish-row-in var(--dur-4) var(--ease-spring) both;
      animation-delay: calc(var(--polish-row-index, 0) * 24ms);
    }
    .row.compact {
      min-height: calc(var(--control-h-sm) + var(--space-2));
    }
    .row-actions {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pill {
      min-height: var(--control-h-sm);
      display: inline-flex;
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      padding: 0 var(--space-3);
      color: var(--color-text-secondary);
      background: var(--tone-neutral-bg);
      font-size: var(--text-xs);
      font-weight: 650;
      line-height: var(--lh-xs);
      white-space: nowrap;
    }
    .pill[data-kind="ok"] {
      color: var(--ok);
      border-color: var(--tone-ok-border);
      background: var(--tone-ok-bg);
    }
    .pill[data-kind="warn"] {
      color: var(--warn);
      border-color: var(--tone-warn-border);
      background: var(--tone-warn-bg);
    }
    .pill[data-kind="danger"] {
      color: var(--danger);
      border-color: var(--tone-danger-border);
      background: var(--tone-danger-bg);
    }
    .pill[data-kind="info"] {
      color: var(--color-info);
      border-color: var(--tone-info-border);
      background: var(--tone-info-bg);
    }
    .pill[data-kind="accent"] {
      color: var(--accent-action-foreground);
      border-color: transparent;
      background: var(--accent-action-fill);
    }
    .notice {
      border: var(--border-width-1) solid var(--tone-warn-border);
      border-radius: var(--radius-sm);
      background: var(--tone-warn-bg);
      color: var(--warn);
      padding: var(--space-3);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .empty {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    [data-provider-field][hidden] {
      display: none;
    }
    @media (max-width: 920px) {
      .table-shell {
        overflow-x: auto;
      }
      .table-row {
        min-width: 620px;
      }
      .thread-list-panel .table-row {
        min-width: 0;
      }
      .form-grid {
        grid-template-columns: 1fr;
      }
      .parity-grid,
      .surface-grid {
        grid-template-columns: 1fr;
      }
      .row {
        grid-template-columns: 1fr;
      }
      .agent-card,
      .capability-card {
        grid-template-columns: 1fr;
      }
      .row-actions {
        justify-content: flex-start;
      }
      .surface-card-actions {
        justify-content: flex-start;
      }
    }`
}
