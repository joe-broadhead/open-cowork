// Domain: controls-surface
// Ownership: packages/ui Studio surface CSS (Shared control primitives (input, select, segmented, button base).)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function controlsSurfaceCss(): string {
  return `
.ui-button,
.ui-icon-button,
.ui-input,
.ui-textarea,
.ui-select-trigger,
.ui-menu-trigger,
.ui-segmented-option {
  border: var(--border-width-1) solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background var(--dur-1) var(--ease-out),
    border-color var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out),
    transform var(--dur-2) var(--ease-out);
}

.ui-button,
.ui-icon-button,
.ui-select-trigger,
.ui-menu-trigger,
.ui-segmented-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-weight: 560;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.ui-button:focus-visible,
.ui-icon-button:focus-visible,
.ui-input:focus-visible,
.ui-textarea:focus-visible,
.ui-select-trigger:focus-visible,
.ui-menu-trigger:focus-visible,
.ui-segmented-option:focus-visible,
.ui-popover-item:focus-visible,
.ui-dialog:focus-visible {
  /* Solid, high-contrast focus ring (WCAG 2.2 SC 1.4.11, >=3:1). The transparent
     outline is invisible in normal rendering but is swapped for a system colour in
     forced-colors / Windows High Contrast mode, where box-shadows are dropped. */
  outline: 2px solid transparent;
  outline-offset: 2px;
  box-shadow: var(--ring-focus);
}

.ui-button:active:not(:disabled),
.ui-icon-button:active:not(:disabled),
.ui-select-trigger:active:not(:disabled),
.ui-menu-trigger:active:not(:disabled),
.ui-segmented-option:active:not(:disabled) {
  filter: brightness(0.92);
}

.ui-button:disabled,
.ui-icon-button:disabled,
.ui-input:disabled,
.ui-textarea:disabled,
.ui-select-trigger:disabled,
.ui-menu-trigger:disabled,
.ui-segmented-option:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.ui-button--sm {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
}

.ui-button--md {
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-button--lg {
  min-height: var(--control-h-lg);
  padding: 0 var(--space-4);
  font-size: var(--text-md);
  line-height: var(--lh-md);
}

.ui-button--full {
  width: 100%;
}

.ui-button--primary {
  position: relative;
  overflow: hidden;
  background: var(--accent-action-fill);
  color: var(--accent-action-foreground);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-button--primary::after {
  content: "";
  position: absolute;
  inset-block: -35%;
  inset-inline-start: -70%;
  width: 42%;
  transform: skewX(-18deg) translateX(0);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, #fff 42%, transparent), transparent);
  opacity: 0;
  pointer-events: none;
}

.ui-button--primary > *,
.ui-icon-button > * {
  position: relative;
  z-index: 1;
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--accent-action-fill);
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-button--primary:hover:not(:disabled)::after {
  opacity: 1;
  animation: ui-primary-sheen var(--dur-4) var(--ease-out) both;
}

.ui-button--secondary {
  background: var(--color-elevated);
  color: var(--color-text);
  border-color: var(--color-border);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-icon-button--secondary {
  background: var(--color-elevated);
  color: var(--color-text);
  border-color: var(--color-border);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-button--secondary:hover:not(:disabled),
.ui-icon-button--secondary:hover:not(:disabled) {
  background: var(--color-surface-hover);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-button--ghost,
.ui-icon-button--ghost {
  background: transparent;
  color: var(--color-text-secondary);
  border-color: transparent;
}

.ui-button--ghost:hover:not(:disabled),
.ui-icon-button--ghost:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.ui-button--danger,
.ui-icon-button--danger {
  background: color-mix(in srgb, var(--color-red) 12%, transparent);
  color: var(--color-red);
  border-color: color-mix(in srgb, var(--color-red) 34%, transparent);
}

.ui-button--danger:hover:not(:disabled),
.ui-icon-button--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-red) 18%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--color-red) 18%, transparent), var(--shadow-1);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-icon-button--primary {
  background: var(--accent-action-fill);
  color: var(--accent-action-foreground);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-1), var(--specular);
}

.ui-icon-button--primary:hover:not(:disabled) {
  box-shadow: var(--shadow-2), var(--specular-strong);
  transform: translateY(calc(-1 * var(--border-width-1)));
}

.ui-icon-button {
  flex: none;
  padding: 0;
  position: relative;
}

.ui-icon-button--sm {
  width: var(--control-h-sm);
  height: var(--control-h-sm);
}

.ui-icon-button--md {
  width: var(--control-h-md);
  height: var(--control-h-md);
}

.ui-icon-button--lg {
  width: var(--control-h-lg);
  height: var(--control-h-lg);
}

.ui-icon-button__badge {
  position: absolute;
  inset-block-start: calc(-1 * var(--space-1));
  inset-inline-end: calc(-1 * var(--space-1));
  display: inline-flex;
  min-width: var(--space-4);
  height: var(--space-4);
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-accent-foreground);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ui-field__chrome {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.ui-input,
.ui-textarea {
  width: 100%;
  background: color-mix(in srgb, var(--color-base) 70%, var(--color-elevated) 30%);
  border-color: var(--color-border-subtle);
  color: var(--color-text);
  font-family: var(--font-ui);
}

.ui-input::placeholder,
.ui-textarea::placeholder {
  color: var(--color-text-muted);
}

.ui-input:hover:not(:disabled),
.ui-textarea:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.ui-input[aria-invalid="true"],
.ui-textarea[aria-invalid="true"] {
  border-color: color-mix(in srgb, var(--color-red) 58%, var(--color-border));
}

.ui-input--sm {
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  font-size: var(--text-xs);
  line-height: var(--lh-xs);
}

.ui-input--md {
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-input--lg {
  min-height: var(--control-h-lg);
  padding: 0 var(--space-4);
  font-size: var(--text-md);
  line-height: var(--lh-md);
}

.ui-field__left-icon {
  position: absolute;
  inset-inline-start: var(--space-3);
  color: var(--color-text-muted);
  pointer-events: none;
}

.ui-input--with-left-icon {
  padding-inline-start: calc(var(--space-6) + var(--space-3));
}

.ui-input--clearable {
  padding-inline-end: calc(var(--space-6) + var(--space-3));
}

.ui-input__clear {
  position: absolute;
  inset-inline-end: var(--space-1);
  color: var(--color-text-muted);
}

.ui-field__message {
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
  color: var(--color-text-muted);
}

.ui-field__message--error {
  color: var(--color-red);
}

.ui-textarea {
  min-height: calc(var(--control-h-lg) + var(--space-4));
  max-height: var(--ui-textarea-max-height, none);
  resize: vertical;
  padding: var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-popover-root {
  position: relative;
  display: inline-block;
  min-width: 0;
}

.ui-select-trigger,
.ui-menu-trigger {
  width: 100%;
  min-height: var(--control-h-md);
  justify-content: space-between;
  background: color-mix(in srgb, var(--color-base) 70%, var(--color-elevated) 30%);
  border-color: var(--color-border-subtle);
  color: var(--color-text);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

.ui-select-trigger:hover:not(:disabled),
.ui-menu-trigger:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.ui-popover {
  position: absolute;
  inset-block-start: calc(100% + var(--space-1));
  inset-inline-start: 0;
  z-index: var(--z-dropdown);
  min-width: 100%;
  max-height: min(var(--primitive-popover-max-h), calc(100vh - var(--space-12)));
  overflow: auto;
  border: var(--border-width-1) solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-3), var(--specular-strong);
  padding: var(--space-1);
  transform-origin: top left;
  animation: ui-popover-in var(--dur-2) var(--ease-spring) both;
}

.ui-popover-item {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  min-height: var(--control-h-md);
  padding: 0 var(--space-3);
  text-align: start;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out);
}

/* Two-line variant: a 40px row for menu items that carry a sublabel under the
   primary label. Top-aligns the content so the label/sublabel pair reads as a
   block, and adds vertical padding so the taller row keeps the same inset. */
.ui-popover-item--two-line {
  align-items: flex-start;
  min-height: var(--control-h-lg);
  padding: var(--space-2) var(--space-3);
}

.ui-popover-item:hover:not(:disabled),
.ui-popover-item[data-active="true"] {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

/* Selected = the current choice. listbox/option menus express this with
   aria-selected; menu/menuitem menus (where aria-selected is invalid) use
   aria-current. Both drive the same inset accent ring so every popover menu
   signals "selected" identically. */
.ui-popover-item[aria-selected="true"],
.ui-popover-item[aria-current="true"] {
  color: var(--color-text);
  box-shadow: var(--ring-selected);
}

/* Destructive action row (e.g. Delete). Keeps the red text through rest and
   hover so the affordance reads as dangerous, while sharing the row geometry
   and muted hover background of every other popover item. */
.ui-popover-item--danger,
.ui-popover-item--danger:hover:not(:disabled),
.ui-popover-item--danger[data-active="true"] {
  color: var(--color-red);
}

.ui-popover-item__content {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
}

.ui-popover-item__label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.ui-popover-item__hint {
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-popover-item:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

/* Segmented control — pill track with a sliding active thumb. Track radius
   --radius-sm (7px); the track wraps the --control-h-xs options to an outer
   height that lines up with sibling md controls. */
.ui-segmented-control {
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: var(--space-1);
  overflow: hidden;
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-base) 64%, var(--color-elevated) 36%);
  box-shadow: var(--specular);
  padding: var(--space-1);
}

.ui-segmented-thumb {
  position: absolute;
  inset-block: var(--space-1);
  inset-inline-start: var(--space-1);
  width: calc((100% - (var(--space-1) * (var(--ui-segment-count) + 1))) / var(--ui-segment-count));
  border-radius: var(--radius-sm);
  background: var(--color-surface-active);
  box-shadow: var(--shadow-1), var(--specular);
  transform: translateX(calc(var(--ui-segment-index) * (100% + var(--space-1))));
  transition:
    transform var(--dur-3) var(--ease-out),
    width var(--dur-3) var(--ease-spring),
    background var(--dur-2) var(--ease-out),
    box-shadow var(--dur-2) var(--ease-out);
  pointer-events: none;
}

.ui-segmented-option {
  position: relative;
  z-index: 1;
  min-height: var(--control-h-xs);
  background: transparent;
  color: var(--color-text-muted);
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  line-height: var(--lh-sm);
}

/* Visible helper text for the active segmented option (on-screen guidance for
   consequential choices, instead of an invisible title tooltip). */
.ui-segmented-description {
  display: block;
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-2xs);
  line-height: var(--lh-2xs);
}

.ui-segmented-option:hover:not(:disabled) {
  color: var(--color-text-secondary);
}

.ui-segmented-option[aria-checked="true"] {
  background: transparent;
  color: var(--color-text);
  box-shadow: none;
}

/* Canonical on/off toggle (the <Switch> primitive). Geometry is token-derived:
   the thumb fills the track height minus a 1-step inset on each side, and the
   "on" travel equals track width minus track height. */
.ui-switch {
  --ui-switch-inset: var(--space-1);
  position: relative;
  width: var(--space-10);
  height: var(--space-5);
  border-radius: var(--radius-full);
  background: var(--color-border);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}

.ui-switch:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ui-switch--on {
  background: var(--color-accent);
}

.ui-switch__thumb {
  position: absolute;
  inset-block-start: var(--ui-switch-inset);
  inset-inline-start: var(--ui-switch-inset);
  width: calc(var(--space-5) - 2 * var(--ui-switch-inset));
  height: calc(var(--space-5) - 2 * var(--ui-switch-inset));
  border: var(--border-width-1) solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%);
  transition: transform var(--dur-1) var(--ease-out);
}

.ui-switch--on .ui-switch__thumb {
  transform: translateX(calc(var(--space-10) - var(--space-5)));
}
`
}

// Shared base styles for the cross-app UI primitives (EmptyState, Skeleton). These
// were previously defined only in the desktop globals.css, so the shared EmptyState /
// Skeleton components rendered fully styled on desktop but as bare unstyled <div>s on
// web. Single-sourced here so both apps render them identically.
