export function cloudWebsiteStudioUiStyles() {
  return String.raw`    .studio-shell {
      display: grid;
      min-height: min(720px, calc(100vh - var(--space-12)));
      overflow: hidden;
      grid-template-columns: minmax(220px, var(--studio-shell-sidebar-w)) minmax(0, 1fr);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-xl);
      background: color-mix(in srgb, var(--color-base) 88%, var(--color-elevated) 12%);
      box-shadow: var(--shadow-3), var(--specular);
    }
    .studio-shell__sidebar,
    .studio-shell__workspace,
    .studio-shell__main,
    .studio-nav,
    .studio-nav__section,
    .studio-nav__items,
    .studio-page-header__copy,
    .studio-coworker-card,
    .studio-composer,
    .studio-task-lane,
    .studio-task-lane__items,
    .studio-task-lane__item,
    .studio-review-panel,
    .studio-review-panel__body,
    .studio-decision-card__copy,
    .studio-object-card__copy {
      display: flex;
      min-width: 0;
      flex-direction: column;
    }
    .studio-shell__sidebar {
      gap: var(--space-5);
      border-inline-end: var(--border-width-1) solid var(--color-border-subtle);
      background: color-mix(in srgb, var(--color-elevated) 72%, var(--color-base) 28%);
      padding: var(--space-4);
    }
    .studio-shell__brand,
    .studio-coworker-card__header,
    .studio-object-card,
    .studio-object-card__title-row,
    .studio-decision-card,
    .studio-actions {
      display: flex;
      align-items: center;
    }
    .studio-shell__brand,
    .studio-coworker-card__header,
    .studio-object-card,
    .studio-object-card__title-row,
    .studio-decision-card {
      gap: var(--space-3);
    }
    .studio-shell__mark,
    .studio-coworker-avatar,
    .studio-object-card__icon,
    .studio-decision-card__icon {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--studio-tone, var(--color-accent)) 18%, var(--color-elevated) 82%);
      color: var(--studio-tone, var(--color-accent));
      box-shadow: inset 0 0 0 var(--border-width-1) color-mix(in srgb, currentColor 34%, transparent);
    }
    .studio-shell__mark {
      width: var(--control-h-lg);
      height: var(--control-h-lg);
      color: var(--color-accent);
      font-weight: 750;
    }
    .studio-shell__brand-name,
    .studio-page-header h1,
    .studio-coworker-card h3,
    .studio-task-lane h3,
    .studio-review-panel h2,
    .studio-decision-card h3,
    .studio-object-card h3 {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-display);
    }
    .studio-shell__brand-subtitle,
    .studio-page-header p,
    .studio-coworker-card p,
    .studio-task-lane p,
    .studio-review-panel p,
    .studio-decision-card p,
    .studio-object-card p,
    .studio-empty-line {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-nav,
    .studio-nav__section,
    .studio-nav__items,
    .studio-coworker-card,
    .studio-task-lane__items,
    .studio-review-panel,
    .studio-object-card__copy {
      gap: var(--space-2);
    }
    .studio-nav__section-label {
      margin: 0 0 var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      font-weight: 750;
      line-height: var(--lh-2xs);
      text-transform: uppercase;
    }
    .studio-nav__item {
      display: flex;
      min-height: var(--control-h-md);
      width: 100%;
      align-items: center;
      gap: var(--space-2);
      border: var(--border-width-1) solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      font: inherit;
      padding: 0 var(--space-3);
      text-decoration: none;
    }
    .studio-nav__item:hover,
    .studio-nav__item[data-active="true"] {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .studio-nav__item[data-active="true"] {
      border-color: color-mix(in srgb, var(--color-accent) 42%, transparent);
      box-shadow: inset 3px 0 0 var(--color-accent);
    }
    .studio-nav__label,
    .studio-coworker-card__identity {
      min-width: 0;
      flex: 1;
    }
    .studio-nav__label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .studio-nav__badge {
      color: var(--color-accent);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .studio-shell__topbar {
      border-block-end: var(--border-width-1) solid var(--color-border-subtle);
      background: color-mix(in srgb, var(--color-elevated) 62%, transparent);
      padding: var(--space-5);
    }
    .studio-shell__workspace {
      min-height: 0;
    }
    .studio-shell__main {
      gap: var(--space-4);
      overflow: auto;
      padding: var(--space-5);
    }
    .studio-page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .studio-page-header__copy {
      gap: var(--space-2);
    }
    .studio-page-header h1 {
      font-size: var(--text-2xl);
      line-height: var(--lh-2xl);
    }
    .studio-actions {
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .studio-preview-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
    }
    .studio-coworker-card,
    .studio-composer,
    .studio-task-lane,
    .studio-review-panel,
    .studio-decision-card {
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-2), var(--specular);
      padding: var(--space-4);
    }
    .studio-coworker-card {
      border-color: color-mix(in srgb, var(--studio-tone, var(--color-border)) 32%, var(--color-border) 68%);
    }
    .studio-coworker-avatar--sm {
      width: var(--control-h-md);
      height: var(--control-h-md);
      font-size: var(--text-xs);
    }
    .studio-coworker-avatar--md {
      width: var(--control-h-lg);
      height: var(--control-h-lg);
      font-size: var(--text-sm);
    }
    .studio-coworker-avatar--lg {
      width: var(--control-h-xl);
      height: var(--control-h-xl);
      font-size: var(--text-md);
    }
    .studio-chip-list,
    .studio-composer__footer {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .studio-chip-list {
      flex-wrap: wrap;
    }
    .studio-composer {
      gap: var(--space-3);
    }
    .studio-composer__label {
      display: grid;
      gap: var(--space-2);
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
      font-weight: 700;
    }
    .studio-composer textarea {
      min-height: var(--studio-composer-min-h);
      resize: vertical;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--color-base) 72%, var(--color-elevated) 28%);
      color: var(--color-text);
      padding: var(--space-3);
    }
    .studio-composer textarea:focus-visible,
    .studio-nav__item:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-composer__footer {
      justify-content: space-between;
    }
    .studio-composer__toolbar,
    .studio-object-card__meta,
    .studio-decision-card__meta,
    .studio-task-lane__meta {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .studio-task-lane {
      border-color: color-mix(in srgb, var(--studio-lane-tone) 32%, var(--color-border) 68%);
    }
    .studio-task-lane__header,
    .studio-review-panel__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .studio-task-lane__count {
      display: inline-flex;
      min-width: var(--control-h-sm);
      height: var(--control-h-sm);
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-full);
      background: color-mix(in srgb, var(--studio-lane-tone) 16%, transparent);
      color: var(--studio-lane-tone);
      font-size: var(--text-xs);
      font-weight: 750;
    }
    .studio-task-lane__items {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .studio-task-lane__item {
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      padding: var(--space-3);
    }
    .studio-task-lane__item h4 {
      margin: 0;
      color: var(--color-text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-review-panel__body {
      gap: var(--space-3);
    }
    .studio-decision-card--danger {
      border-color: color-mix(in srgb, var(--color-red) 38%, var(--color-border) 62%);
    }
    .nav-alert-count:empty {
      display: none;
    }
    .nav-alert-count {
      margin-inline-start: auto;
      min-width: 1.375rem;
      border-radius: var(--radius-full);
      background: var(--accent-action-fill);
      color: var(--accent-action-foreground);
      font-size: var(--text-2xs);
      font-weight: 750;
      line-height: 1.375rem;
      text-align: center;
    }
    .studio-object-card__copy {
      flex: 1;
    }
    @media (max-width: 920px) {
      .ui-workbench-layout,
      .ui-workbench-layout--with-review {
        grid-template-columns: 1fr;
      }
      .ui-workbench-layout--with-left,
      .ui-workbench-layout--with-left.ui-workbench-layout--with-review {
        grid-template-columns: 1fr;
      }
      .ui-workbench-layout__review:not([hidden]) {
        position: fixed;
        inset: var(--space-3);
        z-index: var(--z-modal);
        width: auto;
        max-height: calc(100dvh - var(--space-6));
        outline: none;
      }
      body[data-chat-state="thread"] .chat-inspector:not([hidden]) {
        position: fixed;
        inset: var(--space-3);
        z-index: var(--z-modal);
        max-height: calc(100dvh - var(--space-6));
        border: var(--border-width-1) solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-elevated);
        box-shadow: var(--shadow-elevated);
      }
      .ui-diff-view__file {
        grid-template-columns: 1fr;
      }
      .ui-diff-view__file-meta {
        justify-content: flex-start;
      }
      .studio-shell,
      .studio-preview-grid {
        grid-template-columns: 1fr;
      }
      .studio-shell__sidebar {
        border-block-end: var(--border-width-1) solid var(--color-border-subtle);
        border-inline-end: 0;
      }
      .studio-page-header,
      .studio-composer__footer {
        align-items: stretch;
        flex-direction: column;
      }
    }`
}
