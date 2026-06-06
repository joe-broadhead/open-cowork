export function cloudWebsiteAgentProfileStyles() {
  return String.raw`    .agent-capability-profile {
      border: var(--border-width-1) solid var(--glass-border);
      border-radius: var(--radius-lg);
      background:
        radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 58%),
        var(--color-elevated);
      box-shadow: var(--shadow-1), var(--specular);
      padding: var(--space-3);
    }
    .agent-capability-profile__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-2);
    }
    .agent-capability-profile__eyebrow {
      font-size: var(--text-2xs);
      line-height: var(--line-tight);
      text-transform: uppercase;
      color: var(--color-text-muted);
    }
    .agent-capability-profile__label {
      margin-top: var(--space-1);
      font-size: var(--text-sm);
      line-height: var(--line-tight);
      font-weight: 650;
      color: var(--color-text);
    }
    .agent-capability-profile__score {
      display: flex;
      align-items: baseline;
      gap: 2px;
      color: var(--accent);
      text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 28%, transparent);
    }
    .agent-capability-profile__score span {
      font-family: var(--font-display);
      font-size: var(--text-2xl);
      line-height: 1;
      font-weight: 760;
    }
    .agent-capability-profile__score small {
      font-size: var(--text-xs);
      color: var(--color-text-muted);
    }
    .agent-capability-profile__radar {
      width: 100%;
      height: auto;
      display: block;
      overflow: visible;
    }
    .agent-capability-profile__ring {
      fill: transparent;
      stroke: color-mix(in srgb, var(--accent) 18%, var(--color-border-subtle));
      stroke-width: 1;
    }
    .agent-capability-profile__axis {
      stroke: color-mix(in srgb, var(--color-text-muted) 20%, transparent);
      stroke-width: 1;
    }
    .agent-capability-profile__axis-label {
      fill: var(--color-text-muted);
      font-size: 8px;
      font-weight: 600;
    }
    .agent-capability-profile__shape {
      fill: color-mix(in srgb, var(--accent) 22%, transparent);
      stroke: var(--accent);
      stroke-width: 1.6;
      filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 26%, transparent));
    }
    .agent-capability-profile__dot {
      fill: var(--accent);
      stroke: var(--color-accent-foreground);
      stroke-width: 1;
    }
    .agent-capability-profile__legend {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .agent-capability-profile__legend-row {
      display: grid;
      grid-template-columns: minmax(48px, 0.8fr) minmax(56px, 1fr) minmax(60px, 1fr);
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      line-height: var(--line-tight);
    }
    .agent-capability-profile__legend-row > span:last-child {
      color: var(--color-text-muted);
      text-align: end;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agent-capability-profile__meter {
      height: 4px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--color-text-muted) 16%, transparent);
    }
    .agent-capability-profile__meter i {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-strong));
      box-shadow: var(--glow-soft);
    }`
}
