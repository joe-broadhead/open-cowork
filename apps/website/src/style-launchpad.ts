export function cloudWebsiteLaunchpadStyles() {
  return String.raw`    .cloud-launchpad-home {
      position: relative;
      width: min(100%, 900px);
      display: grid;
      gap: var(--space-5);
      margin: var(--space-3) auto var(--space-8);
      min-width: 0;
    }
    /* Subtle radial-gradient depth behind the composer + cards, mirroring desktop
       Home's aurora wash. Sits behind the content (z-index 0) and never intercepts
       pointer events. */
    .cloud-launchpad-home::before {
      content: "";
      position: absolute;
      inset: calc(var(--space-6) * -1) calc(var(--space-5) * -1) auto;
      height: 420px;
      z-index: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent 62%),
        radial-gradient(circle at 16% 8%, color-mix(in srgb, var(--color-accent-2, var(--color-accent)) 9%, transparent), transparent 56%);
    }
    .cloud-launchpad-home > * {
      position: relative;
      z-index: 1;
    }
    body[data-chat-state="thread"] .cloud-launchpad-home {
      display: none;
    }
    /* On the empty Home the launchpad's greeting hero is the single canonical
       heading, and its own composer is the primary action — so suppress the
       redundant chat-session-header hero ("What shall we cowork on today?") and
       the standalone chat composer. Both remain for the active-thread state. */
    body[data-chat-state="empty"] .chat-session-header,
    body[data-chat-state="empty"] #prompt-form {
      display: none;
    }
    .cloud-launchpad-composer {
      position: relative;
      display: grid;
      gap: var(--space-3);
      min-width: 0;
      padding: var(--space-4);
      border: var(--border-width-1) solid var(--color-border-strong);
      border-radius: 18px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--color-elevated) 84%, var(--color-base) 16%), color-mix(in srgb, var(--color-elevated) 64%, var(--color-base) 36%));
      box-shadow: var(--shadow-3), var(--specular-strong);
      transition: border-color var(--dur-1) var(--ease-out), box-shadow var(--dur-1) var(--ease-out);
    }
    .cloud-launchpad-composer:focus-within {
      border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border) 66%);
      box-shadow: var(--shadow-3), var(--ring-focus), var(--specular-strong);
    }
    .cloud-launchpad-composer__assign-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
    }
    .cloud-launchpad-composer__assign-label {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: 700;
      line-height: var(--lh-xs);
    }
    .cloud-launchpad-composer__assign-pill {
      min-height: var(--control-h-sm);
      max-width: min(100%, 280px);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      background: color-mix(in srgb, var(--color-surface) 72%, transparent);
      padding: var(--space-1) var(--space-2);
      box-shadow: var(--specular);
    }
    .cloud-launchpad-composer__assign-pill:hover {
      border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border) 66%);
      background: var(--color-surface-hover);
    }
    .cloud-launchpad-composer__assign-select {
      width: auto;
      min-height: var(--control-h-sm);
      max-width: 200px;
      border-color: transparent;
      background: transparent;
      color: var(--text);
      font-size: var(--text-xs);
      padding-right: var(--space-6);
    }
    .cloud-launchpad-composer__textarea {
      min-height: 28px;
      max-height: 220px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      padding: 0;
      resize: none;
      color: var(--text);
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .cloud-launchpad-composer__textarea:focus {
      box-shadow: none;
      outline: none;
    }
    .cloud-launchpad-composer__textarea::placeholder {
      color: var(--color-text-muted);
    }
    .cloud-launchpad-composer__toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-3);
    }
    .cloud-launchpad-composer__toolbar-group {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      flex-wrap: wrap;
    }
    .cloud-launchpad-composer__model {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      min-height: var(--control-h-sm);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      background: color-mix(in srgb, var(--color-surface) 72%, transparent);
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      padding: 0 var(--space-3);
    }
    .cloud-launchpad-composer__model svg {
      display: block;
    }
    .cloud-launchpad-hero {
      display: grid;
      gap: var(--space-2);
      justify-items: center;
      text-align: center;
      min-width: 0;
    }
    .cloud-launchpad-hero__title {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--text-4xl);
      font-weight: 650;
      line-height: var(--lh-2xl);
      letter-spacing: var(--tracking-tight);
      color: var(--text);
    }
    .cloud-launchpad-hero__accent {
      color: var(--color-accent);
    }
    .cloud-launchpad-hero__subtitle {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .cloud-launchpad-suggestions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
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
      background: var(--color-accent);
      color: var(--accent-action-foreground);
      box-shadow: var(--specular);
    }
    .cloud-launchpad-suggestion__icon[data-tone="green"] { background: var(--color-green); }
    .cloud-launchpad-suggestion__icon[data-tone="amber"] { background: var(--color-amber); }
    .cloud-launchpad-suggestion__icon[data-tone="info"] { background: var(--color-info); }
    .cloud-launchpad-suggestion__icon svg,
    .cloud-launchpad-motion-col__icon svg,
    .cloud-launchpad-motion-row__icon svg {
      display: block;
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
      font-family: var(--font-display);
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
    .cloud-launchpad-motion-alert-badge {
      box-shadow: 0 0 0 var(--border-width-1) color-mix(in srgb, var(--accent) 45%, transparent);
    }
    .cloud-launchpad-motion__recovery {
      display: grid;
      justify-items: center;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
    .cloud-launchpad-motion__recovery p {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      text-align: center;
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
    .cloud-launchpad-motion-col__head > span:first-child {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
    }
    .cloud-launchpad-motion-col__icon {
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      width: var(--control-h-xs);
      height: var(--control-h-xs);
      border-radius: var(--radius-xs);
      background: var(--color-accent);
      color: var(--accent-action-foreground);
    }
    .cloud-launchpad-motion-col__icon[data-tone="green"] { background: var(--color-green); }
    .cloud-launchpad-motion-col__icon[data-tone="amber"] { background: var(--color-amber); }
    .cloud-launchpad-motion-col__icon[data-tone="info"] { background: var(--color-info); }
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
      background: var(--color-accent);
      color: var(--accent-action-foreground);
    }
    .cloud-launchpad-motion-row__icon[data-tone="green"] { background: var(--color-green); }
    .cloud-launchpad-motion-row__icon[data-tone="amber"] { background: var(--color-amber); }
    .cloud-launchpad-motion-row__icon[data-tone="info"] { background: var(--color-info); }
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
    .cloud-launchpad-review__lanes {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      min-width: 0;
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
      .cloud-launchpad-review__lanes {
        grid-template-columns: 1fr;
      }
    }`
}
