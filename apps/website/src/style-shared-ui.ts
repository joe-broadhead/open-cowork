export function cloudWebsiteSharedUiStyles() {
  return String.raw`    .ui-workbench-layout {
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-3);
      align-items: stretch;
      position: relative;
      transition: grid-template-columns var(--dur-4) var(--ease-spring);
    }
    .ui-workbench-layout--with-review {
      grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
    }
    .ui-workbench-layout--with-left {
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    }
    .ui-workbench-layout--with-left.ui-workbench-layout--with-review {
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px);
    }
    .ui-workbench-layout__left,
    .ui-workbench-layout__main,
    .ui-workbench-layout__review {
      min-width: 0;
      min-height: 0;
    }
    .ui-workbench-layout__main {
      display: flex;
      flex-direction: column;
    }
    .ui-workbench-layout__review {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: var(--border-width-1) solid var(--glass-border);
      border-radius: var(--radius-lg);
      background: var(--glass-bg);
      backdrop-filter: var(--glass-blur);
      box-shadow: var(--shadow-3), var(--specular-strong);
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
    }
    .ui-workbench-layout__actions {
      display: flex;
      justify-content: flex-end;
      padding: var(--space-2) var(--space-3) 0;
    }
    .ui-action-cluster {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: var(--glass-bg);
      backdrop-filter: var(--glass-blur);
      box-shadow: var(--shadow-2), var(--specular);
      padding: var(--space-1);
      flex-wrap: wrap;
    }
    .ui-action-cluster__item {
      min-height: var(--control-h-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      padding: 0 var(--space-2);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .ui-action-cluster__item:hover:not(:disabled),
    .ui-action-cluster__item[aria-pressed="true"] {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .ui-action-cluster__item--primary {
      color: var(--accent-text);
    }
    .ui-action-cluster__item--danger {
      color: var(--color-red);
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .ui-workbench-layout__review,
      .ui-action-cluster {
        background: var(--color-elevated);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
    }
    .ui-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-height: var(--control-h-sm);
      border: var(--border-width-1) solid transparent;
      border-radius: var(--radius-full);
      padding: 0 var(--space-3);
      font-size: var(--text-xs);
      font-weight: 650;
      line-height: var(--lh-xs);
    }
    .ui-badge--neutral {
      background: var(--color-surface);
      border-color: var(--color-border-subtle);
      color: var(--color-text-secondary);
    }
    .ui-badge--accent {
      background: color-mix(in srgb, var(--color-accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--color-accent) 34%, transparent);
      color: var(--accent-text);
    }
    .ui-badge--success {
      background: color-mix(in srgb, var(--color-green) 14%, transparent);
      border-color: color-mix(in srgb, var(--color-green) 34%, transparent);
      color: var(--color-green);
    }
    .ui-badge--warning {
      background: color-mix(in srgb, var(--color-amber) 14%, transparent);
      border-color: color-mix(in srgb, var(--color-amber) 34%, transparent);
      color: var(--color-amber);
    }
    .ui-badge--danger {
      background: color-mix(in srgb, var(--color-red) 14%, transparent);
      border-color: color-mix(in srgb, var(--color-red) 34%, transparent);
      color: var(--color-red);
    }
    .ui-diff-view {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .ui-diff-view__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
    }
    .ui-diff-view__title {
      min-width: 0;
    }
    .ui-diff-view__title h3 {
      margin: 0;
    }
    .ui-diff-view__title p {
      margin: var(--space-1) 0 0;
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .ui-diff-view__actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .ui-diff-view__files {
      display: grid;
      gap: var(--space-2);
    }
    .ui-diff-view__file {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2);
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-surface) 76%, transparent);
      padding: var(--space-2);
    }
    .ui-diff-view__file-main,
    .ui-diff-view__file-meta {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .ui-diff-view__file-main code {
      overflow: hidden;
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ui-diff-view__file-meta {
      justify-content: flex-end;
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .ui-diff-view__plus {
      color: var(--ok);
    }
    .ui-diff-view__minus {
      color: var(--danger);
    }
    .ui-diff-view__estimate,
    .ui-diff-view__empty {
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }`
}
