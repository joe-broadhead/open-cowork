// Domain: approvals-surface
// Ownership: packages/ui Studio surface CSS (Approvals queue surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function approvalsSurfaceCss(): string {
  return `
    .studio-approvals-surface {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-4);
    }
    .studio-approvals-list,
    .studio-question-controls,
    .studio-question-block,
    .studio-question-answer {
      display: flex;
      min-width: 0;
      flex-direction: column;
    }
    .studio-approvals-list,
    .studio-question-controls {
      gap: var(--space-3);
    }
    .studio-approval-item {
      align-items: flex-start;
    }
    .studio-approval-item__identity,
    .studio-approval-item__chips,
    .studio-question-options,
    .studio-question-answer .studio-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .studio-approval-item__identity {
      color: var(--color-text-secondary);
    }
    .studio-approval-item__identity div {
      display: flex;
      min-width: 0;
      flex-direction: column;
    }
    .studio-approval-item__identity strong {
      color: var(--color-text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-approval-item__identity span {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .studio-approval-command {
      margin: 0;
      max-height: 240px;
      overflow: auto;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      padding: var(--space-3);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .studio-question-block {
      gap: var(--space-2);
    }
    .studio-question-block strong {
      color: var(--color-text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-question-option {
      min-height: var(--control-h-md);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      cursor: pointer;
      padding: var(--space-2) var(--space-3);
      text-align: start;
    }
    .studio-question-option:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-question-option:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .studio-question-option[data-selected="true"] {
      border-color: color-mix(in srgb, var(--color-accent) 62%, var(--color-border));
      background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface));
      color: var(--color-text);
    }
    .studio-question-option:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }
    .studio-question-option span,
    .studio-question-option small {
      display: block;
    }
    .studio-question-option small {
      margin-top: var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-2xs);
      line-height: var(--lh-2xs);
    }`
}
