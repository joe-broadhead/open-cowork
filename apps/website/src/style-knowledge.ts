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
    .knowledge-side > .knowledge-side-panel {
      min-width: 0;
    }
    .knowledge-rail {
      position: sticky;
      top: var(--space-4);
      max-height: calc(100vh - 180px);
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .knowledge-rail-search {
      display: flex;
      flex-direction: column;
    }
    .knowledge-rail-no-match {
      margin: 0;
      padding: 0 var(--space-1);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
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
    .knowledge-review-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .knowledge-proposal-card__head,
    .knowledge-proposal-card__actions {
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
    .knowledge-proposal-card small {
      display: block;
      margin-top: var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    .knowledge-proposal-card__actions {
      justify-content: flex-end;
      margin-top: var(--space-3);
    }
    /* Green/red +add/-del proposal diff stats (ported from desktop ReviewQueue). */
    .knowledge-diff-stat {
      font-family: var(--font-mono);
      font-size: var(--text-xs);
      font-weight: 600;
      white-space: nowrap;
    }
    .knowledge-diff-stat__add {
      color: var(--color-green);
    }
    .knowledge-diff-stat__del {
      color: var(--color-red);
    }
    .knowledge-diff-stat__sep {
      color: var(--color-text-muted);
    }
    /* Version-history timeline (ports the desktop .studio-version-* rail). */
    .knowledge-history-row__top,
    .knowledge-history-row__meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      font-size: var(--text-xs);
    }
    .knowledge-history-row__meta {
      margin-top: var(--space-1);
      color: var(--color-text-muted);
    }
    .knowledge-history-row__author {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: var(--space-2);
    }
    .knowledge-history-row__author > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .knowledge-history-row__top small {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    /* "Your access" capability chips. */
    .knowledge-access-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .knowledge-access-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
    }
    .knowledge-access-hint {
      margin: var(--space-3) 0 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-sm);
    }
    /* First-run onboarding coachmark (Capture -> Review -> Publish). */
    .knowledge-first-run {
      margin: 0 auto;
      width: 100%;
      max-width: 640px;
    }
    .knowledge-first-run__intro {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .knowledge-first-run__badge {
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: var(--radius-lg);
      border: var(--border-width-1) solid var(--color-border-subtle);
      background: var(--color-surface);
      color: var(--color-accent);
    }
    .knowledge-first-run__intro h2 {
      margin: var(--space-4) 0 0;
      font-family: var(--font-display);
      font-size: var(--text-md);
      font-weight: 650;
      color: var(--text);
    }
    .knowledge-first-run__intro p {
      margin: var(--space-2) 0 0;
      max-width: 460px;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-sm);
    }
    .knowledge-first-run__steps {
      display: grid;
      gap: var(--space-3);
      margin-top: var(--space-5);
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .knowledge-first-run__step {
      border-radius: var(--radius-md);
      border: var(--border-width-1) solid var(--color-border-subtle);
      background: var(--color-elevated);
      padding: var(--space-3);
    }
    .knowledge-first-run__step-head {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .knowledge-first-run__step-icon {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      border: var(--border-width-1) solid var(--color-border-subtle);
      background: var(--color-surface);
      color: var(--color-text-secondary);
    }
    .knowledge-first-run__step-label {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .knowledge-first-run__step h3 {
      margin: var(--space-2) 0 0;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text);
    }
    .knowledge-first-run__step p {
      margin: var(--space-1) 0 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-sm);
    }
    .knowledge-first-run__action {
      display: flex;
      justify-content: center;
      margin-top: var(--space-5);
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
    @media (max-width: 900px) {
      .knowledge-first-run__steps {
        grid-template-columns: 1fr;
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
    }
    /* Shared version-timeline rail (mirrors the desktop globals.css .studio-version-*). */
    .studio-version-timeline {
      display: flex;
      flex-direction: column;
    }
    .studio-version-row {
      display: flex;
      gap: var(--space-3);
    }
    .studio-version-rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 14px;
      flex: none;
    }
    .studio-version-dot {
      width: 11px;
      height: 11px;
      border-radius: var(--radius-full);
      background: var(--color-border-strong);
      border: 2px solid var(--color-surface);
      margin-top: 5px;
      flex: none;
    }
    .studio-version-dot.is-current {
      background: var(--color-accent);
    }
    .studio-version-connector {
      flex: 1;
      width: 2px;
      min-height: var(--space-3);
      background: var(--color-border);
      margin-top: 2px;
    }
    .studio-version-body {
      flex: 1;
      min-width: 0;
      padding-bottom: var(--space-4);
    }`
}
