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
      box-shadow: var(--shadow-2), var(--specular);
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
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
      box-shadow: var(--specular);
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
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
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      align-content: stretch;
      padding: 0 var(--space-5);
      overflow: hidden;
    }
    body[data-chat-state="empty"] .chat-shell {
      max-width: 900px;
      width: 100%;
      margin: 0 auto;
      grid-template-rows: auto auto auto;
      justify-content: stretch;
      align-content: start;
      overflow: auto;
      padding-top: var(--space-7);
      padding-bottom: var(--space-8);
    }
    .chat-session-header {
      width: min(100%, 900px);
      margin: 0 auto;
      padding: var(--space-4) 0 var(--space-3);
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: var(--space-4);
      min-width: 0;
    }
    body[data-chat-state="empty"] .chat-session-header {
      display: grid;
      justify-items: center;
      text-align: center;
      padding: 0 0 var(--space-6);
    }
    .home-eyebrow {
      margin-bottom: var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: 700;
      line-height: var(--lh-xs);
    }
    body[data-chat-state="empty"] #chat-session-title {
      font-size: var(--text-hero);
      letter-spacing: var(--tracking-display);
      line-height: var(--lh-hero);
    }
    .chat-inspector-toggle {
      flex: 0 0 auto;
    }
    .chat-session-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      min-width: 0;
      flex-wrap: wrap;
    }
    body[data-chat-state="empty"] .chat-inspector-toggle {
      display: none;
    }
    body[data-chat-state="empty"] .chat-session-actions {
      display: none;
    }
    .timeline {
      width: min(100%, 900px);
      margin: 0 auto;
      display: grid;
      gap: var(--space-4);
      align-content: start;
      overflow: auto;
      max-height: none;
      padding: var(--space-2) 0 var(--space-4);
      min-width: 0;
    }
    .timeline[hidden] {
      display: none;
    }
    .cloud-composer {
      width: min(100%, 900px);
      display: grid;
      gap: 0;
      margin: 0 auto var(--space-4);
      border: var(--border-width-1) solid var(--color-border-strong);
      border-radius: 18px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--color-elevated) 84%, var(--color-base) 16%), color-mix(in srgb, var(--color-elevated) 64%, var(--color-base) 36%));
      box-shadow: var(--shadow-3), var(--specular-strong);
      overflow: hidden;
      transition:
        border-color var(--dur-1) var(--ease-out),
        box-shadow var(--dur-1) var(--ease-out);
    }
    .cloud-composer:focus-within {
      border-color: color-mix(in srgb, var(--color-accent) 34%, var(--color-border) 66%);
      box-shadow: var(--shadow-3), var(--ring-focus), var(--specular-strong);
    }
    .composer-input-chrome {
      padding: var(--space-4) var(--space-4) var(--space-3);
    }
    .composer-lead-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-height: var(--control-h-md);
      border-bottom: var(--border-width-1) solid var(--color-border-subtle);
      background: color-mix(in srgb, var(--color-surface) 46%, transparent);
      color: var(--color-text-secondary);
      padding: var(--space-2) var(--space-4);
      font-size: var(--text-xs);
      font-weight: 650;
      line-height: var(--lh-xs);
    }
    .composer-lead-row[data-has-lead="true"] {
      color: var(--text);
    }
    .cloud-composer textarea {
      min-height: 28px;
      max-height: 220px;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      padding: 0;
      resize: none;
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .cloud-composer textarea:focus {
      box-shadow: none;
    }
    .composer-agent-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      padding: 0 var(--space-3) var(--space-3);
    }
    .agent-chip {
      min-height: var(--control-h-sm);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      padding: 0 var(--space-3);
    }
    .agent-chip[data-active="true"] {
      border-color: color-mix(in srgb, var(--color-accent) 36%, var(--color-border) 64%);
      background: var(--color-surface-active);
      color: var(--text);
    }
    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      background: linear-gradient(180deg, color-mix(in srgb, var(--color-elevated) 72%, var(--color-base) 28%), color-mix(in srgb, var(--color-elevated) 60%, var(--color-base) 40%));
      padding: var(--space-2) var(--space-3);
      min-width: 0;
    }
    .composer-toolbar-group {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      min-width: 0;
      flex-wrap: wrap;
    }
    .composer-select-label {
      width: auto;
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .composer-select-label select {
      width: auto;
      min-height: var(--control-h-sm);
      max-width: 190px;
      border-color: transparent;
      background: transparent;
      padding-right: var(--space-6);
    }
    .toolbar-pill {
      min-height: var(--control-h-sm);
      border-radius: var(--radius-lg);
      padding: 0 var(--space-2);
      color: var(--color-text-secondary);
      font-size: var(--text-xs);
    }
    .toolbar-status {
      display: inline-flex;
      align-items: center;
      color: var(--color-text-muted);
    }
    .icon-button,
    .composer-send {
      width: var(--control-h-sm);
      min-width: var(--control-h-sm);
      min-height: var(--control-h-sm);
      padding: 0;
      border-radius: var(--radius-sm);
    }
    .icon-button[data-composer-attach="true"]::before {
      content: "\1F4CE ";
      font-size: var(--text-sm);
    }
    .composer-send::before {
      content: "\2191 ";
      font-size: var(--text-lg);
      line-height: 1;
    }
    .composer-send:not(:disabled) {
      background: var(--accent-action-fill);
      border-color: var(--accent-line);
      color: var(--accent-action-foreground);
      box-shadow: var(--specular);
    }
    .chat-inspector {
      min-width: 0;
      align-content: start;
      height: 100%;
      overflow: auto;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      box-shadow: var(--shadow-card), var(--surface-highlight);
      padding: var(--space-4);
    }
    .chat-inspector[hidden] {
      display: none;
    }
    .cloud-specialist-lane {
      max-width: 880px;
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
    }
    .cloud-specialist-lane > summary {
      cursor: pointer;
      list-style: none;
    }
    .cloud-specialist-lane > summary::-webkit-details-marker {
      display: none;
    }
    .cloud-specialist-lane__identity {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
    }
    .cloud-specialist-lane__identity h3,
    .cloud-specialist-lane__identity p {
      margin: 0;
    }
    .cloud-specialist-lane__identity h3 {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .cloud-specialist-lane__subline, .cloud-conversation-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
    .studio-handoff-chip, .cloud-conversation-meta__context { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; max-width: 100%; border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-full); background: color-mix(in srgb, var(--color-elevated) 84%, transparent); color: var(--color-text-muted); font-size: var(--text-2xs); line-height: var(--lh-2xs); padding: var(--space-1) var(--space-2); }
    .studio-handoff-chip span, .cloud-conversation-meta__context span { overflow: hidden; max-width: 160px; color: var(--text); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .cloud-conversation-meta__summary { color: var(--color-text-muted); }
    .cloud-conversation-meta__board { min-height: var(--control-h-sm); padding: 0 var(--space-2); font-size: var(--text-2xs); }
    .cloud-specialist-lane__tools {
      display: grid;
      gap: var(--space-2);
    }
    .cloud-specialist-lane .runtime-detail {
      max-width: 100%;
      box-shadow: none;
    }
    .cloud-review-summary {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-4);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 74%, transparent);
      box-shadow: var(--shadow-card);
    }
    .cloud-review-summary__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .cloud-review-summary h3,
    .cloud-review-summary p {
      margin: 0;
    }
    .cloud-review-summary h3 {
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .cloud-review-summary p,
    .cloud-review-summary__list {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .cloud-review-summary__list {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .cloud-review-summary__list li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-width: 0;
    }
    .cloud-deliverables-approval { margin: 0; padding: var(--space-2) var(--space-3); border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-elevated) 82%, transparent); color: var(--text); font-size: var(--text-xs); line-height: var(--lh-xs); }
    .inspector-header {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      align-items: start;
      margin-bottom: var(--space-3);
    }
    .inspector-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-1);
      margin-bottom: var(--space-3);
    }
    .inspector-tabs button {
      min-height: var(--control-h-sm);
      font-size: var(--text-xs);
    }
    .inspector-tabs button[data-active="true"] {
      background: var(--color-surface-active);
      border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border) 70%);
      color: var(--text);
    }
    .message-bubble {
      max-width: 880px;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xl) var(--radius-xs);
      padding: var(--row-pad) var(--space-4);
      background: color-mix(in srgb, var(--color-elevated) 72%, transparent);
      color: var(--text);
      box-shadow: var(--shadow-1), var(--specular);
      min-width: 0;
      animation: ui-popover-in var(--dur-3) var(--ease-spring) both;
    }
    .message-bubble[data-role="assistant"] {
      border-color: transparent;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      padding: 0;
      justify-self: start;
    }
    .message-bubble[data-role="user"] {
      justify-self: end;
      max-width: min(80%, 720px);
      border-color: var(--color-border-strong);
      border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xs) var(--radius-xl);
      background: var(--color-surface-active);
      box-shadow: var(--shadow-2), var(--specular);
    }
    .message-bubble[data-streaming="true"] {
      border-color: color-mix(in srgb, var(--accent) 34%, var(--color-border) 66%);
      box-shadow: var(--shadow-2), var(--specular-strong);
    }
    .message-bubble[data-role="assistant"][data-streaming="true"] {
      border-radius: var(--radius-xl) var(--radius-xl) var(--radius-xl) var(--radius-xs);
      background: color-mix(in srgb, var(--color-elevated) 58%, transparent);
      padding: var(--row-pad) var(--space-4);
    }
    .message-bubble[data-streaming="true"] p:last-of-type {
      background: linear-gradient(100deg, var(--text) 30%, var(--accent) 50%, var(--text) 70%);
      background-size: 220% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: ui-stream-shimmer 2.4s linear infinite;
    }
    .message-bubble[data-streaming="true"] p:last-of-type::after {
      content: "";
      display: inline-block;
      width: var(--space-2);
      height: 1em;
      margin-inline-start: var(--space-1);
      transform: translateY(0.16em);
      border-radius: var(--radius-xs);
      background: var(--accent);
      animation: ui-stream-caret 1s steps(2, start) infinite;
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
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      font-weight: 750;
      line-height: var(--lh-xs);
      margin-bottom: var(--space-2);
    }
    .message-bubble[data-role="assistant"] .message-heading {
      display: none;
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
    }
    @media (max-width: 920px) {
      .chat-shell {
        min-height: 620px;
        padding: 0;
      }
      body[data-chat-state="empty"] #chat-session-title {
        font-size: var(--text-3xl);
        letter-spacing: var(--tracking-display);
        line-height: var(--lh-3xl);
      }
      .composer-toolbar {
        align-items: stretch;
        flex-direction: column;
      }
      .composer-toolbar-group {
        justify-content: space-between;
      }
      .chat-session-header {
        align-items: start;
      }
      .chat-session-actions {
        justify-content: flex-start;
      }
      .message-bubble[data-role="user"] {
        max-width: 92%;
      }
    }`
}
