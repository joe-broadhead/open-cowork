export function cloudWebsiteKnowledgeStyles() {
  return String.raw`    .knowledge-route-shell {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .knowledge-layout {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr) minmax(260px, 340px);
      gap: var(--space-4);
      align-items: start;
    }
    .knowledge-rail,
    .knowledge-reader,
    .knowledge-side > .panel {
      min-width: 0;
    }
    .knowledge-rail {
      position: sticky;
      top: var(--space-4);
      max-height: calc(100vh - 180px);
      overflow: auto;
    }
    .knowledge-rail-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .knowledge-reader {
      min-height: 560px;
      padding: 0;
      overflow: hidden;
    }
    .knowledge-reader .studio-wiki-page {
      border: 0;
      border-radius: 0;
      min-height: 560px;
    }
    .knowledge-side {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      min-width: 0;
    }
    .knowledge-panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
      color: var(--text);
      font-size: var(--text-sm);
    }
    .knowledge-review-list,
    .knowledge-history-list,
    .knowledge-graph-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .knowledge-proposal-card,
    .knowledge-history-row {
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      padding: var(--space-3);
      color: var(--text);
    }
    .knowledge-proposal-card__head,
    .knowledge-proposal-card__actions,
    .knowledge-history-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .knowledge-proposal-card p {
      margin: var(--space-2) 0 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .knowledge-proposal-card small,
    .knowledge-history-row small,
    .knowledge-history-row span {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    .knowledge-proposal-card__actions {
      justify-content: flex-end;
      margin-top: var(--space-3);
    }
    @media (max-width: 1180px) {
      .knowledge-layout {
        grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      }
      .knowledge-side {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (max-width: 820px) {
      .knowledge-layout,
      .knowledge-side {
        grid-template-columns: 1fr;
      }
      .knowledge-rail {
        position: static;
        max-height: none;
      }
      .knowledge-reader,
      .knowledge-reader .studio-wiki-page {
        min-height: 0;
      }
    }`
}
