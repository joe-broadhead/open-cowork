// Domain: projects-surface
// Ownership: packages/ui Studio surface CSS (Projects kanban surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function projectsSurfaceCss(): string {
  return String.raw`
.studio-kanban-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: var(--space-3);
}

.studio-kanban-column {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-3);
}

.studio-kanban-column--over {
  border-color: var(--accent-line);
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-surface) 93%);
}

.studio-kanban-column__head,
.studio-kanban-task-card__top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.studio-kanban-column__head h3 {
  margin: 0;
  flex: 1;
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  line-height: var(--lh-2xs);
  text-transform: uppercase;
}

.studio-kanban-column__head span {
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.studio-kanban-column__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.studio-kanban-column__empty {
  border: var(--border-width-1) dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  margin: 0;
  padding: var(--space-4) var(--space-2);
  text-align: center;
}

.studio-kanban-task-card {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-elevated) 90%, var(--color-base) 10%);
  box-shadow: var(--shadow-1), var(--specular);
  padding: var(--space-3);
  transition: transform var(--dur-2) var(--ease-out), border-color var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}

.studio-kanban-task-card:hover,
.studio-kanban-task-card--dragging {
  transform: translateY(calc(-1 * var(--space-1)));
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-2), var(--specular-strong);
}

.studio-kanban-task-card__priority {
  width: var(--space-2);
  height: var(--space-2);
  flex: none;
  margin-top: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--studio-priority);
}

.studio-kanban-task-card__foot {
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
  color: var(--color-text-secondary);
  font-size: var(--text-xs);
}

.studio-kanban-task-card__foot .studio-coworker-avatar {
  width: var(--space-6);
  height: var(--space-6);
}

.studio-project-progress {
  display: grid;
  gap: var(--space-2);
}

.studio-project-progress em {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-style: normal;
}

.studio-projects-layout {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: var(--space-4);
}

.studio-projects-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-3);
}

.studio-projects-list .studio-object-card {
  cursor: pointer;
}

.studio-projects-list .studio-object-card:focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
}

.studio-projects-list .studio-object-card[data-selected="true"] {
  border-color: var(--accent-line);
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-elevated) 93%);
  box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular);
}

.studio-project-board {
  min-width: 0;
}

.studio-project-board-header,
.studio-project-create,
.studio-plan-form,
.studio-task-drawer,
.studio-project-notice {
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
  box-shadow: var(--shadow-1), var(--specular);
}

.studio-project-board-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
}

.studio-project-board-header__copy {
  display: grid;
  min-width: 0;
  gap: var(--space-2);
}

.studio-project-board-header h2,
.studio-task-drawer h2 {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  line-height: var(--lh-xl);
}

.studio-project-board-header p,
.studio-task-drawer p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.studio-project-board-header__meta,
.studio-project-board-header__actions,
.studio-team-avatars,
.studio-project-create__actions,
.studio-task-actions,
.studio-stage-chips,
.studio-hand-to {
  display: flex;
  align-items: center;
}

.studio-project-board-header__meta {
  flex-wrap: wrap;
  gap: var(--space-4);
}

.studio-project-board-header__meta .studio-project-progress {
  min-width: 180px;
}

.studio-project-board-header__actions,
.studio-project-create__actions,
.studio-task-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.studio-team-avatars {
  gap: 0;
}

.studio-team-avatars .studio-coworker-avatar + .studio-coworker-avatar {
  margin-inline-start: calc(-1 * var(--space-2));
}

.studio-project-create,
.studio-plan-form {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  /* "Plan with Cleo" is the accent-emphasised plan panel (prototype .plan-panel):
     accent-line border + a 3px accent-soft glow ring (a sanctioned accent glow). */
  border-radius: var(--radius-2xl);
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-1), var(--specular);
}

.studio-project-create__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.studio-project-create .span,
.studio-project-create__grid .span {
  grid-column: 1 / -1;
}

.studio-project-create label,
.studio-plan-form label,
.studio-select-row,
.studio-hand-to {
  display: grid;
  gap: var(--space-1);
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.studio-project-create input,
.studio-project-create textarea,
.studio-plan-form input,
.studio-plan-form textarea,
.studio-select-row select,
.studio-hand-to select {
  min-height: var(--control-h-md);
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  padding: var(--space-2) var(--space-3);
  font: inherit;
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}

.studio-project-create textarea,
.studio-plan-form textarea {
  resize: vertical;
}

.studio-project-board__main {
  display: grid;
  min-height: 520px;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  margin-top: var(--space-4);
}

.studio-project-board__main .studio-kanban-board {
  grid-template-columns: repeat(5, minmax(180px, 1fr));
  align-items: start;
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.studio-kanban-task-button {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  text-align: start;
}

.studio-kanban-task-button:focus-visible {
  outline: none;
  outline-offset: var(--space-1);
  border-radius: var(--radius-md);
  box-shadow: var(--ring-focus);
}

.studio-kanban-task-button[data-selected="true"] .studio-kanban-task-card {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 var(--border-width-1) var(--accent-line), var(--shadow-2), var(--specular);
}

.studio-task-drawer {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-4);
  align-self: start;
}

.studio-task-drawer__header,
.studio-task-drawer__section {
  display: grid;
  gap: var(--space-2);
}

.studio-task-drawer__section h3 {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.studio-stage-chips {
  flex-wrap: wrap;
  gap: var(--space-2);
}

.studio-stage-chips button {
  min-height: var(--control-h-sm);
  border: var(--border-width-1) solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  font-weight: 700;
}

.studio-stage-chips button:focus-visible {
  outline: none;
  box-shadow: var(--ring-focus);
}

.studio-stage-chips button[data-active="true"] {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.studio-hand-to {
  grid-template-columns: auto minmax(120px, 1fr);
  align-items: center;
}

.studio-project-notice {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
}

.studio-project-notice[data-tone="success"] {
  border-color: color-mix(in srgb, var(--color-green) 34%, var(--color-border) 66%);
  color: var(--color-green);
}

.studio-project-notice[data-tone="warning"] {
  border-color: color-mix(in srgb, var(--color-amber) 38%, var(--color-border) 62%);
  color: var(--color-amber);
}

@media (max-width: 1180px) {
  .studio-projects-layout,
  .studio-project-board__main {
    grid-template-columns: 1fr;
  }

  .studio-projects-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
}

@media (max-width: 720px) {
  .studio-project-board-header,
  .studio-project-create__grid {
    grid-template-columns: 1fr;
  }
  .studio-project-board-header {
    display: grid;
  }
}
`
}

// Shared interaction-control styles for the cross-app primitive controls
// (Button, Input, Textarea, Select, MenuButton, SegmentedControl). The input /
// textarea / select-trigger / menu-trigger / segmented-option / field / popover
// rules previously lived ONLY in the desktop globals.css, so those controls
// rendered fully styled on desktop but with raw browser defaults on web. Single-
// sourced here (verbatim from the desktop globals, the design reference) so both
// apps render them identically.
//
// IMPORTANT — `.ui-button--primary` is deliberately NOT included here. The desktop
// (gradient `--accent-action-fill` / `--accent-line` / `--accent-action-foreground`)
// and the website (flat `--color-accent` / `--color-accent-hover`) render the
// primary button differently today, so each app keeps its own `.ui-button--primary`
// (and `:hover`) rule locally — moving either into the shared module would be a
// visual change. Every other button declaration is byte-identical across the apps,
// so the base interaction group, sizes, focus/active/disabled, the icon button, the
// secondary/ghost/danger variants, and the primary sheen `::after` are shared here.
