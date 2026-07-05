// Injected desktop-shell seam for the handful of Electron UI/app-control calls
// (open a URL in the OS browser, set launch-at-login) that a few substrate modules
// make in DESKTOP-ONLY code paths. The cloud server reaches those modules but never
// calls these functions (no browser, no login item); injecting the surface here
// keeps the modules Electron-free and package-resolvable. The desktop wires real
// `shell`/`app` implementations at startup (desktop-electron-hosts.ts); the cloud
// leaves the host unset and the desktop-only callers no-op / throw if ever invoked.
export type DesktopShellHost = {
  openExternal(url: string): Promise<void> | void
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
  // Best-effort broadcast to every renderer window's webContents (desktop-only;
  // the cloud has no windows and provides a no-op).
  broadcastToRenderers(channel: string, ...args: unknown[]): void
}

let desktopShellHost: DesktopShellHost | null = null

export function setDesktopShellHost(host: DesktopShellHost | null) {
  desktopShellHost = host
}

export function getDesktopShellHost(): DesktopShellHost | null {
  return desktopShellHost
}
