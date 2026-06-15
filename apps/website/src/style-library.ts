export function cloudWebsiteLibraryStyles() {
  return String.raw`    .segmented-control {
      display: inline-flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      align-items: center;
      max-width: 100%;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-base) 62%, var(--color-elevated) 38%);
      padding: var(--space-1);
    }
    .segmented-control button {
      min-height: var(--control-h-sm);
      border-color: transparent;
      background: transparent;
      color: var(--muted);
      padding: 0 var(--space-3);
    }
    .segmented-control button[aria-selected="true"] {
      border-color: var(--accent-line);
      background: var(--color-surface-active);
      color: var(--text);
      box-shadow: var(--glow-soft), var(--specular);
    }
    .agent-config-spec {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
      min-width: 0;
    }
    .agent-config-spec span {
      min-width: 0;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-base) 52%, transparent);
      padding: var(--space-2);
    }
    .agent-config-spec strong,
    .agent-config-spec em {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-style: normal;
    }
    .agent-config-spec strong {
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .agent-config-spec em {
      margin-top: var(--space-1);
      color: var(--text);
      font-size: var(--text-sm);
      font-weight: 650;
      line-height: var(--lh-sm);
    }
    .workflow-step-list {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .workflow-step {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-base) 52%, transparent);
      padding: var(--space-3);
    }
    .workflow-step-index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--control-h-sm);
      height: var(--control-h-sm);
      border: var(--border-width-1) solid var(--accent-line);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent-text);
      font-size: var(--text-xs);
      font-weight: 800;
    }
    .workflow-step strong,
    .workflow-step small {
      display: block;
      min-width: 0;
    }
    .workflow-step strong {
      color: var(--text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .workflow-step small {
      margin-top: var(--space-1);
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    @media (max-width: 760px) {
      .agent-config-spec {
        grid-template-columns: 1fr;
      }
    }`
}
