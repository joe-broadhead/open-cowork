export function cloudWebsiteChatStyles() {
  return String.raw`    .runtime-summary {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      padding: var(--space-2) var(--space-3);
      min-width: 0;
    }
    .runtime-card {
      display: grid;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-elevated) 72%, transparent);
      padding: var(--space-3);
      max-width: 880px;
      min-width: 0;
    }
    .runtime-card[data-kind="approval"], .runtime-card[data-kind="question"] {
      border-color: var(--tone-warn-border);
      background: var(--tone-warn-bg);
    }
    .runtime-card-header {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      min-width: 0;
    }
    .runtime-card-header strong {
      overflow-wrap: anywhere;
    }
    .question-block {
      display: grid;
      gap: var(--space-2);
    }
    .question-block p {
      margin: 0;
      line-height: var(--lh-sm);
    }
    .choice-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .runtime-detail {
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-elevated) 72%, transparent);
      padding: var(--space-2) var(--space-3);
      max-width: 880px;
      min-width: 0;
    }
    .runtime-detail summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: var(--control-h-sm);
      color: var(--color-text-secondary);
      font-weight: 650;
    }
    .runtime-detail pre {
      overflow: auto;
      margin: var(--space-2) 0 0;
      padding: var(--space-3);
      border-radius: var(--radius-xs);
      background: color-mix(in srgb, var(--color-base) 68%, var(--color-elevated) 32%);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .runtime-error {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      max-width: 880px;
    }
    .chat-shell {
      grid-template-rows: auto minmax(280px, 1fr);
      min-height: 540px;
      align-content: stretch;
    }
    .timeline {
      display: grid;
      gap: var(--space-3);
      align-content: start;
      overflow: auto;
      max-height: 58vh;
      padding-right: var(--space-1);
      min-width: 0;
    }
    .message-bubble {
      max-width: 880px;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xl) var(--radius-xs);
      padding: var(--space-3) var(--space-4);
      background: color-mix(in srgb, var(--color-elevated) 72%, transparent);
      color: var(--text);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.16);
      min-width: 0;
    }
    .message-bubble[data-role="assistant"] {
      background: var(--color-surface-hover);
    }
    .message-bubble[data-role="user"] {
      justify-self: end;
      border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border) 68%);
      border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xs) var(--radius-xl);
      background: var(--color-surface-active);
    }
    .message-bubble[data-role="system"] {
      border-style: dashed;
      background: color-mix(in srgb, var(--color-info) 8%, var(--color-surface) 92%);
    }
    .message-bubble[data-role="error"] {
      border-color: var(--tone-danger-border);
      background: var(--tone-danger-bg);
    }
    .message-heading {
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
      margin-bottom: var(--space-2);
    }
    .message-bubble p {
      margin: 0;
      white-space: pre-wrap;
      line-height: var(--lh-md);
      overflow-wrap: anywhere;
    }
    .wait-banner, .activity-row {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-elevated) 72%, transparent);
      padding: var(--space-2) var(--space-3);
      min-width: 0;
    }
    .activity-block {
      display: grid;
      gap: var(--space-2);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-3);
    }
    .activity-block h4 {
      margin: 0;
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .secret-reveal {
      border: var(--border-width-1) solid var(--tone-ok-border);
      border-radius: var(--radius-sm);
      background: var(--tone-ok-bg);
      padding: var(--space-3);
      display: grid;
      gap: var(--space-2);
    }
    .secret-reveal input {
      font-family: var(--font-mono);
    }`
}
