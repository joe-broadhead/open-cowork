// Playbook card styling — extracted from style-components.ts to keep that module
// under its line budget. Mirrors the desktop WorkflowsPage: each playbook reads
// as an identity-tinted card (not a table row) with an entity-tile icon plate
// (--entity-chroma), a title + status badge, an instrument-readout meta line
// (trigger · last run · next run), and the saved step list. Consumed
// (interpolated) by cloudWebsiteComponentStyles().
export function cloudWebsitePlaybookCardStyles() {
  return String.raw`    /* Playbook grid — a stack of identity-tinted cards portaled into
       #workflow-list. The grid overrides the table-row layout the shell would
       otherwise impose, and neutralises the inherited .table-head row so only
       the cards show (matching the desktop card list). */
    .table-shell:has(.playbook-grid) .table-head {
      display: none;
    }
    .table-shell:has(.playbook-grid) {
      border: 0;
      background: transparent;
      box-shadow: none;
      overflow: visible;
    }
    .playbook-grid {
      display: grid;
      gap: var(--gap);
      align-items: start;
      min-width: 0;
    }
    .playbook-card {
      position: relative;
      display: grid;
      gap: var(--space-3);
      min-width: 0;
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
    .playbook-card:hover {
      border-color: var(--color-border-strong);
      background: color-mix(in srgb, var(--color-elevated) 74%, var(--color-surface-hover) 26%);
      box-shadow: var(--shadow-3), var(--specular-strong);
      transform: translateY(calc(-1 * var(--border-width-1)));
    }
    /* Selected playbook carries the same accent spine as the desktop selection. */
    .playbook-card::after {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      width: 2px;
      background: color-mix(in srgb, var(--spine, var(--color-accent)) 60%, transparent);
      opacity: 0;
      transition: opacity var(--dur-1) var(--ease-out);
      pointer-events: none;
    }
    .playbook-card:hover::after,
    .playbook-card[data-selected="true"]::after {
      opacity: 1;
    }
    .playbook-card[data-selected="true"] {
      border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
      box-shadow: var(--ring-selected), var(--shadow-2), var(--specular);
    }
    .playbook-card-head {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      min-width: 0;
    }
    .playbook-card-icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md);
      color: var(--color-text);
    }
    .playbook-card-headings {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
      flex: 1;
    }
    /* The whole title area is the row affordance (was .row-link); keep it a flush,
       full-width button so the click target matches the old table row. */
    .playbook-card-title {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
      width: 100%;
      min-width: 0;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      text-align: start;
      cursor: pointer;
    }
    .playbook-card-title strong {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .playbook-card-title:hover strong {
      color: var(--accent-text);
    }
    /* Instrument-readout meta line — trigger · last run · next run, with dot
       separators and tabular figures, mirroring the desktop meta row. */
    .playbook-card-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      font-variant-numeric: tabular-nums;
    }
    .playbook-card-meta-item {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
    }
    .playbook-card-meta-sep {
      color: color-mix(in srgb, var(--color-text-muted) 60%, transparent);
    }`
}
