export function cloudWebsiteSidebarStyles() {
  return String.raw`    body[data-sidebar-rail="collapsed"] .shell {
      grid-template-columns: var(--cloud-shell-sidebar-rail-w) minmax(0, 1fr);
    }
    .sidebar-rail-toggle {
      min-width: 0;
      width: var(--control-h-sm);
      height: var(--control-h-sm);
      border-radius: var(--radius-sm);
      padding: 0;
    }
    .sidebar-presence-footer {
      display: grid;
      grid-template-columns: var(--control-h-md) minmax(0, 1fr) var(--control-h-sm);
      align-items: center;
      gap: var(--space-2);
      margin-top: auto;
      min-width: 0;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--surface-highlight);
      padding: var(--row-pad);
    }
    .sidebar-presence-avatar,
    .sidebar-presence-settings {
      display: grid;
      place-items: center;
      border-radius: var(--radius-sm);
    }
    .sidebar-presence-avatar {
      width: var(--control-h-md);
      height: var(--control-h-md);
      background: var(--accent-action-fill);
      color: var(--accent-action-foreground);
      font-family: var(--font-display);
      font-size: var(--text-xs);
      font-weight: 800;
    }
    .sidebar-presence-copy {
      display: grid;
      min-width: 0;
      gap: 1px;
    }
    .sidebar-presence-copy strong,
    .sidebar-presence-copy span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sidebar-presence-settings {
      width: var(--control-h-sm);
      height: var(--control-h-sm);
      color: var(--muted);
      text-decoration: none;
    }
    .sidebar-presence-settings:hover {
      background: var(--color-surface-hover);
      color: var(--text);
    }
    .nav-icon {
      width: var(--space-5);
      height: var(--space-5);
      border-radius: var(--radius-sm);
      display: inline-grid;
      flex: 0 0 auto;
      place-items: center;
      background: color-mix(in srgb, var(--color-surface-hover) 64%, transparent);
      color: var(--muted);
      font-family: var(--font-display);
      font-size: var(--text-2xs);
      font-weight: 800;
      line-height: 1;
    }
    .nav-icon::before {
      content: attr(data-icon);
    }
    .nav-links a[data-active="true"] .nav-icon {
      background: var(--accent-action-fill);
      color: var(--accent-action-foreground);
    }
    .nav-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .react-sidebar-thread-list,
    .sidebar-thread-project {
      display: grid;
      gap: var(--space-1);
    }
    .sidebar-thread-project__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      color: var(--muted);
      font-size: var(--text-2xs);
      font-weight: 750;
      letter-spacing: 0.08em;
      line-height: var(--lh-2xs);
      padding: var(--space-2) var(--space-2) var(--space-1);
      text-transform: uppercase;
    }
    .sidebar-thread-project__head small {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    body[data-sidebar-rail="collapsed"] .nav {
      align-items: center;
      padding-inline: var(--space-2);
    }
    body[data-sidebar-rail="collapsed"] .brand {
      grid-template-columns: var(--control-h-lg);
      justify-items: center;
    }
    body[data-sidebar-rail="collapsed"] .brand-copy,
    body[data-sidebar-rail="collapsed"] .workspace-card,
    body[data-sidebar-rail="collapsed"] .sidebar-actions .primary,
    body[data-sidebar-rail="collapsed"] .sidebar-search,
    body[data-sidebar-rail="collapsed"] .sidebar-thread-pane,
    body[data-sidebar-rail="collapsed"] .nav-heading,
    body[data-sidebar-rail="collapsed"] .nav-label,
    body[data-sidebar-rail="collapsed"] .nav-alert-count,
    body[data-sidebar-rail="collapsed"] .manage-nav summary span,
    body[data-sidebar-rail="collapsed"] .manage-nav summary small,
    body[data-sidebar-rail="collapsed"] .admin-nav summary span,
    body[data-sidebar-rail="collapsed"] .sidebar-presence-copy,
    body[data-sidebar-rail="collapsed"] .sidebar-utility,
    body[data-sidebar-rail="collapsed"] .brand-links {
      display: none;
    }
    body[data-sidebar-rail="collapsed"] .sidebar-actions {
      grid-template-columns: 1fr;
    }
    body[data-sidebar-rail="collapsed"] .sidebar-actions button,
    body[data-sidebar-rail="collapsed"] .nav-links a,
    body[data-sidebar-rail="collapsed"] .manage-nav summary,
    body[data-sidebar-rail="collapsed"] .admin-nav summary {
      justify-content: center;
      width: var(--control-h-md);
      padding-inline: 0;
    }
    body[data-sidebar-rail="collapsed"] .manage-nav summary::after {
      content: 'M';
    }
    body[data-sidebar-rail="collapsed"] .admin-nav summary::after {
      content: 'A';
    }
    body[data-sidebar-rail="collapsed"] .sidebar-presence-footer {
      grid-template-columns: var(--control-h-md);
      justify-content: center;
      padding: var(--space-2) 0;
    }
    body[data-sidebar-rail="collapsed"] .sidebar-presence-settings {
      display: none;
    }`
}
