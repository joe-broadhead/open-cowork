export function cloudWebsiteLaunchpadStyles() {
  return String.raw`    .cloud-launchpad-home {
      width: min(100%, 900px);
      display: grid;
      gap: var(--space-5);
      margin: var(--space-3) auto var(--space-8);
      min-width: 0;
    }
    body[data-chat-state="thread"] .cloud-launchpad-home {
      display: none;
    }
    .cloud-launchpad-suggestions {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-3);
      min-width: 0;
    }
    .cloud-launchpad-suggestion {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
      min-height: 118px;
      padding: var(--space-4);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 76%, transparent);
      color: var(--text);
      text-align: left;
      box-shadow: var(--shadow-card), var(--surface-highlight);
    }
    .cloud-launchpad-suggestion:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, var(--color-border) 70%);
      background: var(--color-surface-hover);
      transform: translateY(-1px);
    }
    .cloud-launchpad-suggestion__icon {
      display: inline-grid;
      place-items: center;
      width: var(--control-h-sm);
      height: var(--control-h-sm);
      border-radius: var(--radius-sm);
      background: var(--color-surface-active);
      color: var(--accent-text);
      font-size: var(--text-sm);
      font-weight: 800;
      box-shadow: var(--specular);
    }
    .cloud-launchpad-suggestion__text {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }
    .cloud-launchpad-suggestion__text strong {
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
      overflow-wrap: anywhere;
    }
    .cloud-launchpad-suggestion__text span,
    .cloud-launchpad-suggestion__text small {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      overflow-wrap: anywhere;
    }
    .cloud-launchpad-suggestion__text small {
      color: var(--color-text-secondary);
      font-weight: 650;
    }
    .cloud-launchpad-motion {
      display: grid;
      gap: var(--space-3);
      min-width: 0;
    }
    .cloud-launchpad-motion__head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: var(--space-3);
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
      font-weight: 800;
      letter-spacing: var(--tracking-wide);
      line-height: var(--lh-xs);
      text-transform: uppercase;
    }
    .cloud-launchpad-motion__head > span[aria-hidden="true"] {
      height: 1px;
      background: linear-gradient(90deg, var(--color-border), transparent);
    }
    .cloud-launchpad-motion-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-3);
      min-width: 0;
    }
    .cloud-launchpad-motion-col {
      display: grid;
      gap: var(--space-3);
      min-width: 0;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 78%, transparent);
      padding: var(--space-3);
      box-shadow: var(--shadow-card), var(--surface-highlight);
    }
    .cloud-launchpad-motion-col__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-width: 0;
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
    }
    .cloud-launchpad-motion-list {
      display: grid;
      gap: var(--space-2);
      min-width: 0;
    }
    .cloud-launchpad-motion-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--space-2);
      min-height: 58px;
      padding: var(--space-2);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-surface) 72%, transparent);
      color: var(--text);
      text-align: left;
    }
    .cloud-launchpad-motion-row:hover {
      border-color: color-mix(in srgb, var(--accent) 26%, var(--color-border) 74%);
      background: var(--color-surface-hover);
    }
    .cloud-launchpad-motion-row__icon {
      display: inline-grid;
      place-items: center;
      width: var(--control-h-xs);
      height: var(--control-h-xs);
      border-radius: var(--radius-xs);
      background: var(--color-surface-active);
      color: var(--accent-text);
      font-size: var(--text-xs);
      font-weight: 800;
    }
    .cloud-launchpad-motion-row__text {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .cloud-launchpad-motion-row__title,
    .cloud-launchpad-motion-row__meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cloud-launchpad-motion-row__title {
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
    }
    .cloud-launchpad-motion-row__meta,
    .cloud-launchpad-motion-row__badge,
    .cloud-launchpad-motion-empty {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .cloud-launchpad-motion-row__badge {
      max-width: 92px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      padding: 2px var(--space-2);
      background: color-mix(in srgb, var(--color-elevated) 66%, transparent);
      color: var(--color-text-secondary);
      font-weight: 750;
    }
    .cloud-launchpad-motion-empty {
      min-height: 58px;
      display: grid;
      place-items: center;
      border: var(--border-width-1) dashed var(--color-border-subtle);
      border-radius: var(--radius-sm);
      text-align: center;
    }
    .cloud-launchpad-team-strip {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      min-height: var(--control-h-lg);
      min-width: 0;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-full);
      background: color-mix(in srgb, var(--color-elevated) 70%, transparent);
      color: var(--color-text-secondary);
      box-shadow: var(--shadow-card), var(--surface-highlight);
      font-size: var(--text-xs);
      font-weight: 750;
      padding: 0 var(--space-4);
    }
    .cloud-launchpad-team-strip:hover {
      border-color: color-mix(in srgb, var(--accent) 30%, var(--color-border) 70%);
      background: var(--color-surface-hover);
      color: var(--text);
    }
    .cloud-launchpad-team-strip__avatars {
      display: flex;
      align-items: center;
      min-width: 0;
    }
    .cloud-launchpad-team-strip__avatars span {
      display: inline-grid;
      place-items: center;
      width: var(--control-h-sm);
      height: var(--control-h-sm);
      margin-left: -6px;
      border: var(--border-width-1) solid var(--color-base);
      border-radius: var(--radius-full);
      background: var(--accent-gradient);
      color: var(--accent-action-foreground);
      font-size: 10px;
      font-weight: 850;
      box-shadow: var(--specular);
    }
    .cloud-launchpad-team-strip__avatars span:first-child {
      margin-left: 0;
    }
    @media (max-width: 920px) {
      .cloud-launchpad-suggestions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .cloud-launchpad-motion-grid {
        grid-template-columns: 1fr;
      }
      .cloud-launchpad-team-strip {
        flex-wrap: wrap;
        border-radius: var(--radius-lg);
        justify-content: flex-start;
        padding: var(--space-3);
      }
    }
    @media (max-width: 640px) {
      .cloud-launchpad-suggestions {
        grid-template-columns: 1fr;
      }
    }`
}
