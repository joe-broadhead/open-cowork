// The single runtime-detection leaf. The same renderer is wrapped two ways: the
// Electron shell injects `window.coworkApi` (the IPC bridge); the browser build
// installs a browser CoworkAPI shim as `window.coworkApi` AND sets
// `__coworkBrowserRuntime`. Both have window.coworkApi, so desktop is "coworkApi
// present AND not the browser shim". Components call window.coworkApi directly
// (the real, fully-typed seam) and branch desktop-vs-cloud behaviour on this —
// so the delta stays auditable in one place.
export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { coworkApi?: unknown; __coworkBrowserRuntime?: boolean }
  return w.coworkApi != null && w.__coworkBrowserRuntime !== true
}
