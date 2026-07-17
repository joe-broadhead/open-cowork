// Domain: shared-keyframes
// Ownership: packages/ui Studio surface CSS (Cross-app animation keyframes shared by desktop + cloud web.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function sharedKeyframesCss(): string {
  return `
@keyframes ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes studio-status-heartbeat {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 45%, transparent); }
  70%, 100% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-accent) 0%, transparent); }
}

@keyframes ui-popover-in {
  from { opacity: 0; transform: translateY(calc(-1 * var(--space-1))) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes ui-view-transition-in {
  from { opacity: 0; transform: translateY(var(--space-2)); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes ui-view-transition-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(calc(-1 * var(--space-1))); }
}

::view-transition-old(root) {
  animation: ui-view-transition-out var(--dur-2) var(--ease-out) both;
}

::view-transition-new(root) {
  animation: ui-view-transition-in var(--dur-3) var(--ease-spring) both;
}

@keyframes ui-dialog-in {
  from { opacity: 0; transform: translateX(-50%) translateY(var(--space-3)) scale(0.985); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}

@keyframes ui-drawer-in {
  from { opacity: 0.6; transform: translateX(var(--space-6)); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes ui-drawer-left-in {
  from { opacity: 0.6; transform: translateX(calc(-1 * var(--space-6))); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes ui-primary-sheen {
  from { transform: skewX(-18deg) translateX(0); }
  to { transform: skewX(-18deg) translateX(430%); }
}

@keyframes ui-status-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

@keyframes ui-progress-shimmer {
  from { background-position: 220% 0; }
  to { background-position: -220% 0; }
}

@keyframes ui-stream-shimmer {
  to { background-position: -220% 0; }
}

@keyframes ui-stream-caret {
  50% { opacity: 0; }
}

@keyframes ui-polish-row-in {
  from { opacity: 0; transform: translateX(calc(-1 * var(--space-2))); }
  to { opacity: 1; transform: translateX(0); }
}
`
}
