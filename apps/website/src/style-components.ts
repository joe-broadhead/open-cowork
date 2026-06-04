export function cloudWebsiteComponentStyles() {
  return String.raw`    a {
      color: var(--accent);
      text-decoration: none;
      transition: color var(--dur-1) var(--ease-out);
    }
    a:hover {
      color: var(--accent-strong);
      text-decoration: underline;
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
        transform var(--dur-1) var(--ease-out);
    }
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
      border-color: var(--color-border);
    }
    button:active:not(:disabled) {
      transform: translateY(var(--border-width-1));
    }
    button.primary {
      background: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 82%, var(--text) 18%);
      color: var(--color-accent-foreground);
    }
    button.primary:hover:not(:disabled) {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }
    button.secondary {
      background: var(--color-elevated);
      color: var(--accent);
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
      color: var(--muted);
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
      color: var(--muted);
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
      gap: var(--space-3);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 78%, transparent);
      color: var(--text);
      padding: var(--space-4);
      box-shadow: var(--shadow);
    }
    .panel h3 {
      margin: 0;
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .parity-grid,
    .surface-grid {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
      min-width: 0;
    }
    .parity-card,
    .surface-card {
      min-width: 0;
      display: grid;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-surface) 76%, transparent);
      padding: var(--space-3);
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
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: color-mix(in srgb, var(--color-elevated) 74%, transparent);
      min-width: 0;
    }
    .table-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.4fr) minmax(90px, 0.6fr) minmax(110px, 0.7fr) minmax(120px, 0.7fr);
      gap: var(--space-3);
      min-height: 44px;
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
      min-height: 36px;
      background: var(--color-surface-hover);
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
    }
    .table-row > [role="cell"] {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thread-row {
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
    }
    .thread-row[data-selected="true"] {
      background: var(--color-surface-active);
      box-shadow: inset 3px 0 0 var(--accent);
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
      color: var(--accent);
      border-color: transparent;
      background: transparent;
      text-decoration: underline;
    }
    .empty-row {
      color: var(--muted);
    }
    .row {
      min-height: 52px;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
      align-items: center;
      background: var(--color-surface);
      min-width: 0;
    }
    .row.compact {
      min-height: 44px;
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
      color: var(--muted);
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
      .row-actions {
        justify-content: flex-start;
      }
    }`
}
