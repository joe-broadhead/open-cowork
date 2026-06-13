export function cloudWebsiteStudioPrimitiveStyles() {
  return String.raw`    .studio-shell--collapsed { grid-template-columns: var(--studio-shell-rail-w) minmax(0, 1fr); }
    .studio-shell--collapsed .studio-shell__sidebar { align-items: center; padding-inline: var(--space-3); }
    .studio-shell--collapsed .studio-shell__brand-copy,
    .studio-shell--collapsed .studio-nav__section-label,
    .studio-shell--collapsed .studio-nav__label,
    .studio-shell--collapsed .studio-nav__badge,
    .studio-shell--collapsed .studio-shell__presence-footer > :not(.studio-coworker-avatar) { display: none; }
    .studio-shell__presence-footer,
    .studio-composer__context,
    .studio-channel-row,
    .studio-person-row,
    .studio-deliverable-card__head,
    .studio-deliverable-card__captured,
    .studio-kanban-task-card__foot,
    .studio-status-live,
    .studio-status-done,
    .studio-status-waiting,
    .studio-run-pill,
    .studio-unassigned,
    .studio-handoff-chip,
    .studio-trait-slider__label,
    .studio-trait-slider__ends,
    .studio-wiki-page__head,
    .studio-wiki-page__links span { display: flex; align-items: center; }
    .studio-shell__presence-footer { gap: var(--space-3); margin-top: auto; border-top: var(--border-width-1) solid var(--color-border-subtle); padding-top: var(--space-3); }
    .studio-coworker-avatar { position: relative; font-weight: 750; }
    .studio-coworker-avatar--round { border-radius: var(--radius-full); }
    .studio-coworker-avatar--squircle { border-radius: var(--radius-lg); }
    .studio-presence-dot { position: absolute; inset-inline-end: calc(-1 * var(--space-1)); inset-block-end: calc(-1 * var(--space-1)); width: var(--space-3); height: var(--space-3); border: 2px solid var(--color-elevated); border-radius: var(--radius-full); background: var(--muted); }
    .studio-presence-dot--working { background: var(--color-accent); }
    .studio-presence-dot--available { background: var(--color-green); }
    .studio-presence-dot--offline { background: var(--muted); }
    .studio-presence-dot--pulse,
    .studio-status-live span,
    .studio-run-pill--live span { animation: ui-status-pulse 1.7s var(--ease-spring) infinite; }
    .studio-composer__context { flex-wrap: wrap; gap: var(--space-2); border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text-secondary); padding: var(--space-2) var(--space-3); font-size: var(--text-xs); line-height: var(--lh-xs); }
    .studio-conversation-lane-card,
    .studio-deliverable-card,
    .studio-permission-row,
    .studio-run-timeline,
    .studio-mini-panel,
    .studio-wiki-demo { border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%); box-shadow: var(--shadow-2), var(--specular); }
    .studio-conversation-lane-card { overflow: hidden; border-color: color-mix(in srgb, var(--studio-lane-tone) 32%, var(--color-border) 68%); }
    .studio-conversation-lane-card--live { box-shadow: 0 0 0 var(--border-width-1) color-mix(in srgb, var(--studio-lane-tone) 24%, transparent), var(--shadow-2), var(--specular); }
    .studio-conversation-lane-card__head { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); cursor: pointer; list-style: none; }
    .studio-conversation-lane-card__head::-webkit-details-marker { display: none; }
    .studio-conversation-lane-card__head:hover { background: var(--color-surface-hover); }
    .studio-conversation-lane-card__copy,
    .studio-channel-row__copy,
    .studio-person-row__copy,
    .studio-permission-row__copy { min-width: 0; flex: 1; }
    .studio-conversation-lane-card__name,
    .studio-conversation-lane-card__role,
    .studio-conversation-lane-card__task,
    .studio-kanban-task-card h4,
    .studio-channel-row h3,
    .studio-person-row h3,
    .studio-deliverable-card h3,
    .studio-permission-row h3,
    .studio-wizard-step-pane h3 { display: block; margin: 0; }
    .studio-conversation-lane-card__name,
    .studio-kanban-task-card h4,
    .studio-channel-row h3,
    .studio-person-row h3,
    .studio-deliverable-card h3,
    .studio-permission-row h3 { color: var(--color-text); font-size: var(--text-sm); font-weight: 700; line-height: var(--lh-sm); }
    .studio-conversation-lane-card__role,
    .studio-conversation-lane-card__task,
    .studio-channel-row p,
    .studio-person-row__copy div,
    .studio-permission-row p,
    .studio-kanban-task-card p { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: var(--lh-xs); }
    .studio-conversation-lane-card__task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .studio-conversation-lane-card__meta { display: inline-flex; flex: none; align-items: center; gap: var(--space-2); color: var(--muted); font-size: var(--text-xs); }
    .studio-conversation-lane-card[open] .studio-conversation-lane-card__meta > svg { transform: rotate(90deg); }
    .studio-conversation-lane-card__body { display: flex; flex-direction: column; gap: var(--space-2); border-top: var(--border-width-1) solid var(--color-border-subtle); padding: var(--space-2) var(--space-4) var(--space-4); }
    .studio-activity-list,
    .studio-kanban-column__body,
    .studio-permission-row__rules,
    .studio-working-style-bars,
    .studio-wiki-rail,
    .studio-wiki-rail__spaces,
    .studio-wiki-space div { display: flex; flex-direction: column; }
    .studio-activity-list { gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
    .studio-activity-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0; color: var(--color-text-secondary); font-size: var(--text-sm); }
    .studio-activity-row__icon,
    .studio-channel-row__icon,
    .studio-permission-row__icon,
    .studio-deliverable-card__icon { display: inline-flex; flex: none; width: var(--control-h-md); height: var(--control-h-md); align-items: center; justify-content: center; border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-md); background: var(--color-surface); color: var(--accent-text); }
    .studio-activity-row__copy { display: flex; min-width: 0; flex: 1; gap: var(--space-1); }
    .studio-activity-row__copy strong { color: var(--color-text); }
    .studio-activity-row time { color: var(--muted); font-size: var(--text-2xs); }
    .studio-activity-row--done .studio-activity-row__icon,
    .studio-status-done { color: var(--color-green); }
    .studio-status-live,
    .studio-status-done,
    .studio-status-waiting,
    .studio-run-pill { gap: var(--space-1); font-weight: 700; }
    .studio-status-live { color: var(--studio-lane-tone, var(--color-accent)); }
    .studio-status-live span,
    .studio-run-pill span { width: var(--space-2); height: var(--space-2); border-radius: var(--radius-full); background: currentColor; }
    .studio-status-waiting { color: var(--muted); }
    .studio-handoff-chip { align-self: flex-start; gap: var(--space-2); border: var(--border-width-1) solid color-mix(in srgb, var(--studio-lane-tone) 28%, transparent); border-radius: var(--radius-full); background: color-mix(in srgb, var(--studio-lane-tone) 10%, transparent); color: var(--color-text-secondary); padding: var(--space-1) var(--space-3); font-size: var(--text-xs); }
    .studio-kanban-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: var(--space-3); }
    .studio-kanban-column { border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-3); }
    .studio-kanban-column--over { border-color: var(--accent-line); background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface) 93%); }
    .studio-kanban-column__head,
    .studio-kanban-task-card__top { display: flex; align-items: flex-start; gap: var(--space-2); }
    .studio-kanban-column__head h3 { margin: 0; flex: 1; color: var(--muted); font-size: var(--text-2xs); font-weight: 750; letter-spacing: 0.08em; line-height: var(--lh-2xs); text-transform: uppercase; }
    .studio-kanban-column__head span { border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-full); color: var(--muted); padding: 0 var(--space-2); font-size: var(--text-xs); }
    .studio-kanban-column__body { gap: var(--space-2); margin-top: var(--space-2); }
    .studio-kanban-column__empty { border: var(--border-width-1) dashed var(--color-border); border-radius: var(--radius-md); color: var(--muted); margin: 0; padding: var(--space-4) var(--space-2); text-align: center; }
    .studio-kanban-task-card { border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-elevated) 90%, var(--color-base) 10%); box-shadow: var(--shadow-1), var(--specular); padding: var(--space-3); transition: transform var(--dur-2) var(--ease-spring), border-color var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out); }
    .studio-kanban-task-card:hover,
    .studio-kanban-task-card--dragging { transform: translateY(calc(-1 * var(--space-1))); border-color: var(--color-border-strong); box-shadow: var(--shadow-2), var(--specular-strong); }
    .studio-kanban-task-card__priority { width: var(--space-2); height: var(--space-2); flex: none; margin-top: var(--space-2); border-radius: var(--radius-full); background: var(--studio-priority); }
    .studio-kanban-task-card__foot { flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-3); color: var(--color-text-secondary); font-size: var(--text-xs); }
    .studio-unassigned { gap: var(--space-1); color: var(--muted); }
    .studio-run-pill { border-radius: var(--radius-full); background: var(--accent-soft); color: var(--accent-text); padding: var(--space-1) var(--space-2); font-size: var(--text-2xs); }
    .studio-run-timeline { padding: var(--space-4); }
    .studio-run-timeline__state { color: var(--color-text); font-weight: 700; }
    .studio-run-timeline__steps { display: flex; align-items: flex-start; margin: var(--space-4) 0 0; padding: 0; list-style: none; }
    .studio-run-timeline__step { position: relative; display: flex; flex: 1; flex-direction: column; align-items: center; gap: var(--space-2); color: var(--muted); font-size: var(--text-2xs); font-weight: 700; }
    .studio-run-timeline__step::before { content: ""; position: absolute; inset-block-start: calc(var(--space-2) - var(--border-width-1)); inset-inline-start: -50%; width: 100%; height: 2px; background: var(--color-border); }
    .studio-run-timeline__step:first-child::before { display: none; }
    .studio-run-timeline__dot { position: relative; z-index: 1; width: var(--space-3); height: var(--space-3); border: 2px solid var(--color-border); border-radius: var(--radius-full); background: var(--color-surface); }
    .studio-run-timeline__step--done::before,
    .studio-run-timeline__step--current::before { background: var(--color-green); }
    .studio-run-timeline__step--done .studio-run-timeline__dot { border-color: var(--color-green); background: var(--color-green); }
    .studio-run-timeline__step--current .studio-run-timeline__dot { border-color: var(--color-accent); background: var(--color-accent); box-shadow: 0 0 0 var(--space-1) var(--accent-soft); }
    .studio-run-timeline__step--done,
    .studio-run-timeline__step--current { color: var(--color-text); }
    .studio-run-timeline__meta { margin-top: var(--space-3); color: var(--muted); font-size: var(--text-xs); }
    .studio-run-timeline__meta code { border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-xs); background: var(--color-surface); color: var(--color-text-secondary); padding: 0 var(--space-1); }
    .studio-permission-row { overflow: hidden; }
    .studio-permission-row__head { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4); }
    .studio-policy-toggle { display: inline-flex; border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-sm); background: var(--color-surface); padding: var(--space-1); }
    .studio-policy-toggle__option { min-height: var(--control-h-sm); border: 0; background: transparent; color: var(--color-text-secondary); padding: 0 var(--space-2); text-transform: capitalize; }
    .studio-policy-toggle__option[data-active="true"] { background: var(--color-elevated); color: var(--color-text); box-shadow: var(--shadow-1); }
    .studio-policy-toggle__option--ask[data-active="true"] { color: var(--accent-text); }
    .studio-policy-toggle__option--deny[data-active="true"] { color: var(--color-red); }
    .studio-permission-row__rules { gap: var(--space-2); border-top: var(--border-width-1) solid var(--color-border-subtle); padding: var(--space-3) var(--space-4) var(--space-4); }
    .studio-permission-rule { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-2); }
    .studio-permission-rule span { color: var(--muted); font-size: var(--text-2xs); font-weight: 700; text-transform: uppercase; }
    .studio-permission-rule input { min-height: var(--control-h-sm); font-family: var(--font-mono); font-size: var(--text-xs); }
    .studio-deliverable-card { overflow: hidden; }
    .studio-deliverable-card__head { gap: var(--space-3); padding: var(--space-3) var(--space-4); }
    .studio-deliverable-card__icon { background: var(--accent-action-fill); color: var(--accent-action-foreground); }
    .studio-deliverable-card__head p,
    .studio-channel-row__meta,
    .studio-person-row__role span { margin: var(--space-1) 0 0; color: var(--muted); font-size: var(--text-xs); }
    .studio-deliverable-card__preview { display: grid; min-height: 96px; place-items: center; margin: 0 var(--space-4) var(--space-3); border: var(--border-width-1) dashed var(--color-border); border-radius: var(--radius-md); background: repeating-linear-gradient(135deg, var(--color-surface), var(--color-surface) 7px, transparent 7px, transparent 14px); color: var(--muted); font-family: var(--font-mono); font-size: var(--text-xs); }
    .studio-deliverable-card .studio-actions,
    .studio-deliverable-card__capture,
    .studio-deliverable-card__captured { margin: 0 var(--space-4) var(--space-3); }
    .studio-deliverable-card__capture { width: calc(100% - (var(--space-4) * 2)); border-style: dashed; }
    .studio-deliverable-card__captured { gap: var(--space-2); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-green) 12%, transparent); color: var(--color-green); padding: var(--space-2) var(--space-3); font-size: var(--text-xs); font-weight: 700; }
    .studio-project-progress { display: grid; gap: var(--space-2); }
    .studio-project-progress span,
    .studio-working-style-bars__row span:last-child { display: block; height: var(--space-2); overflow: hidden; border-radius: var(--radius-full); background: var(--color-surface); }
    .studio-project-progress i,
    .studio-working-style-bars__row i { display: block; width: var(--studio-progress); height: 100%; border-radius: inherit; background: var(--accent-gradient); }
    .studio-project-progress em { color: var(--muted); font-size: var(--text-xs); font-style: normal; }
    .studio-projects-surface { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: var(--space-4); color: var(--color-text); }
    .studio-projects-layout { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: var(--space-4); }
    .studio-projects-list { display: flex; min-width: 0; flex-direction: column; gap: var(--space-3); }
    .studio-projects-list .studio-object-card { cursor: pointer; }
    .studio-projects-list .studio-object-card[data-selected="true"] { border-color: var(--accent-line); background: color-mix(in srgb, var(--color-accent) 7%, var(--color-elevated) 93%); box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular); }
    .studio-project-board { min-width: 0; }
    .studio-project-board-header,
    .studio-project-create,
    .studio-plan-form,
    .studio-task-drawer,
    .studio-project-notice { border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%); box-shadow: var(--shadow-1), var(--specular); }
    .studio-project-board-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); padding: var(--space-4); }
    .studio-project-board-header__copy { display: grid; min-width: 0; gap: var(--space-2); }
    .studio-project-board-header h2,
    .studio-task-drawer h2 { margin: 0; color: var(--color-text); font-family: var(--font-display); font-size: var(--text-xl); line-height: var(--lh-xl); }
    .studio-project-board-header p,
    .studio-task-drawer p { margin: 0; color: var(--color-text-secondary); font-size: var(--text-sm); line-height: var(--lh-sm); }
    .studio-project-board-header__meta,
    .studio-project-board-header__actions,
    .studio-team-avatars,
    .studio-project-create__actions,
    .studio-task-actions,
    .studio-stage-chips,
    .studio-hand-to { display: flex; align-items: center; }
    .studio-project-board-header__meta { flex-wrap: wrap; gap: var(--space-4); }
    .studio-project-board-header__meta .studio-project-progress { min-width: 180px; }
    .studio-project-board-header__actions,
    .studio-project-create__actions,
    .studio-task-actions { flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
    .studio-team-avatars { gap: 0; }
    .studio-team-avatars .studio-coworker-avatar + .studio-coworker-avatar { margin-inline-start: calc(-1 * var(--space-2)); }
    .studio-team-count,
    .studio-team-empty { color: var(--muted); font-size: var(--text-xs); }
    .studio-team-count { display: inline-flex; min-width: var(--space-6); height: var(--space-6); align-items: center; justify-content: center; border: var(--border-width-1) solid var(--color-border-subtle); border-radius: var(--radius-full); background: var(--color-surface); }
    .studio-project-create,
    .studio-plan-form { display: grid; gap: var(--space-3); padding: var(--space-4); }
    .studio-project-create__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
    .studio-project-create .span,
    .studio-project-create__grid .span { grid-column: 1 / -1; }
    .studio-project-create label,
    .studio-plan-form label,
    .studio-select-row,
    .studio-hand-to { display: grid; gap: var(--space-1); color: var(--muted); font-size: var(--text-xs); font-weight: 700; }
    .studio-project-create input,
    .studio-project-create textarea,
    .studio-plan-form input,
    .studio-plan-form textarea,
    .studio-select-row select,
    .studio-hand-to select { min-height: var(--control-h-md); border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); padding: var(--space-2) var(--space-3); font: inherit; font-weight: 500; }
    .studio-project-create textarea,
    .studio-plan-form textarea { resize: vertical; }
    .studio-project-board__main { display: grid; min-height: 520px; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: var(--space-4); margin-top: var(--space-4); }
    .studio-project-board__main .studio-kanban-board { grid-template-columns: repeat(5, minmax(180px, 1fr)); align-items: start; overflow-x: auto; padding-bottom: var(--space-1); }
    .studio-kanban-task-button { display: block; width: 100%; border: 0; background: transparent; color: inherit; padding: 0; text-align: start; }
    .studio-kanban-task-button:focus-visible { outline: none; outline-offset: var(--space-1); border-radius: var(--radius-md); box-shadow: var(--ring-focus); }
    .studio-kanban-task-button[data-selected="true"] .studio-kanban-task-card { border-color: var(--accent-line); box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular); }
    .studio-task-drawer { display: flex; min-width: 0; flex-direction: column; gap: var(--space-4); align-self: start; padding: var(--space-4); }
    .studio-task-drawer__header,
    .studio-task-drawer__section { display: grid; gap: var(--space-2); }
    .studio-task-drawer__section h3 { margin: 0; color: var(--muted); font-size: var(--text-2xs); font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
    .studio-stage-chips { flex-wrap: wrap; gap: var(--space-2); }
    .studio-stage-chips button { min-height: var(--control-h-sm); border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text-secondary); padding: 0 var(--space-3); font-size: var(--text-xs); font-weight: 700; }
    .studio-stage-chips button[data-active="true"] { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-text); }
    .studio-hand-to { grid-template-columns: auto minmax(120px, 1fr); align-items: center; }
    .studio-project-notice { margin: 0; padding: var(--space-3) var(--space-4); color: var(--color-text-secondary); font-size: var(--text-sm); }
    .studio-project-notice[data-tone="success"] { border-color: color-mix(in srgb, var(--color-green) 34%, var(--color-border) 66%); color: var(--color-green); }
    .studio-project-notice[data-tone="warning"] { border-color: color-mix(in srgb, var(--color-amber) 38%, var(--color-border) 62%); color: var(--color-amber); }
    @media (max-width: 1180px) {
      .studio-projects-layout,
      .studio-project-board__main { grid-template-columns: 1fr; }
      .studio-projects-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    }
    @media (max-width: 720px) {
      .studio-project-board-header { display: grid; }
      .studio-project-create__grid { grid-template-columns: 1fr; }
    }
    .studio-channel-row,
    .studio-person-row { gap: var(--space-3); border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%); box-shadow: var(--shadow-1), var(--specular); padding: var(--space-3) var(--space-4); }
    .studio-person-row__role { display: grid; justify-items: end; gap: var(--space-1); text-align: end; }
    .studio-wizard-steps { display: flex; flex-wrap: wrap; gap: var(--space-1); border-bottom: var(--border-width-1) solid var(--color-border-subtle); background: var(--color-surface); padding: var(--space-2); }
    .studio-wizard-steps button { gap: var(--space-2); min-height: var(--control-h-md); border: 0; background: transparent; color: var(--color-text-secondary); font-size: var(--text-sm); font-weight: 700; padding: 0 var(--space-3); }
    .studio-wizard-steps button > span { display: inline-flex; width: var(--space-5); height: var(--space-5); align-items: center; justify-content: center; border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-full); background: var(--color-elevated); color: var(--muted); font-size: var(--text-2xs); }
    .studio-wizard-steps button[data-active="true"] { background: var(--color-elevated); color: var(--color-text); box-shadow: var(--shadow-1); }
    .studio-wizard-steps button[data-active="true"] > span { border-color: transparent; background: var(--color-accent); color: var(--color-accent-foreground); }
    .studio-wizard-step-pane { padding: var(--space-5); }
    .studio-wizard-step-pane h3 { color: var(--color-text); font-size: var(--text-md); font-weight: 750; }
    .studio-wizard-step-pane p { margin: var(--space-1) 0 var(--space-4); color: var(--muted); font-size: var(--text-sm); line-height: var(--lh-sm); }
    .studio-trait-slider { display: grid; gap: var(--space-2); }
    .studio-trait-slider__label,
    .studio-trait-slider__ends { justify-content: space-between; }
    .studio-trait-slider__label span { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--color-text); font-weight: 700; }
    .studio-trait-slider__label strong { color: var(--accent-text); }
    .studio-trait-slider input[type="range"] { width: 100%; min-height: auto; border: 0; background: transparent; padding: 0; accent-color: var(--color-accent); box-shadow: none; }
    .studio-trait-slider__ends { color: var(--muted); font-size: var(--text-xs); }
    .studio-working-style-bars { gap: var(--space-2); margin-top: var(--space-3); }
    .studio-working-style-bars__row { display: grid; grid-template-columns: minmax(70px, auto) minmax(0, 1fr); align-items: center; gap: var(--space-3); color: var(--muted); font-size: var(--text-2xs); font-weight: 750; text-transform: uppercase; }
    .studio-wiki-demo { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); min-height: 360px; overflow: hidden; }
    .studio-wiki-rail { min-width: 0; gap: var(--space-3); border-inline-end: var(--border-width-1) solid var(--color-border-subtle); background: var(--color-surface); padding: var(--space-3); }
    .studio-wiki-rail__spaces,
    .studio-wiki-space div { gap: var(--space-2); }
    .studio-wiki-space h3 { display: flex; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-2); color: var(--color-text-secondary); font-size: var(--text-2xs); font-weight: 750; letter-spacing: 0.06em; text-transform: uppercase; }
    .studio-wiki-space h3 span { display: inline-flex; width: var(--space-5); height: var(--space-5); align-items: center; justify-content: center; border-radius: var(--radius-sm); background: var(--accent-action-fill); color: var(--accent-action-foreground); }
    .studio-wiki-space button { justify-content: flex-start; min-height: var(--control-h-sm); overflow: hidden; border: 0; background: transparent; color: var(--color-text-secondary); padding: 0 var(--space-3); text-align: start; text-overflow: ellipsis; }
    .studio-wiki-space button:hover,
    .studio-wiki-space button[data-active="true"] { background: var(--color-elevated); color: var(--color-text); }
    .studio-wiki-page { min-width: 0; overflow: auto; padding: var(--space-6); }
    .studio-wiki-page__crumbs { color: var(--muted); font-size: var(--text-xs); }
    .studio-wiki-page__head { align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-3); }
    .studio-wiki-page__head h1 { margin: 0; color: var(--color-text); font-family: var(--font-display); font-size: var(--text-2xl); line-height: var(--lh-2xl); }
    .studio-wiki-page__body { margin-top: var(--space-5); }
    .studio-wiki-page__body h2 { margin: var(--space-5) 0 var(--space-2); color: var(--color-text); font-family: var(--font-display); font-size: var(--text-lg); }
    .studio-wiki-page__body p,
    .studio-wiki-page__body li { color: var(--color-text-secondary); font-size: var(--text-sm); line-height: var(--lh-lg); }
    .studio-wiki-page__body ul { display: grid; gap: var(--space-2); margin: var(--space-2) 0; padding: 0; list-style: none; }
    .studio-wiki-page__callout { display: flex; gap: var(--space-2); border: var(--border-width-1) solid var(--accent-line); border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--color-text); padding: var(--space-3) var(--space-4); }
    .studio-wiki-page__links { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-6); border-top: var(--border-width-1) solid var(--color-border-subtle); padding-top: var(--space-4); }
    .studio-wiki-page__links span { gap: var(--space-2); border: var(--border-width-1) solid var(--color-border); border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text-secondary); padding: var(--space-1) var(--space-3); font-size: var(--text-xs); }`
}
