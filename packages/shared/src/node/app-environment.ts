/// <reference types="node" />
// Injected Electron-app path-resolution seam, shared by the config core and the
// runtime/branding modules that resolve bundled-asset and user-data paths. Those
// modules historically imported `electron` only for `app.isPackaged` /
// `app.getAppPath()` / `app.getPath()`; injecting that surface here keeps them
// Electron-free (and package-resolvable). The desktop wires the real Electron app
// via the `config-loader.ts` shim at startup; the cloud server leaves it unset and
// the modules take their env/cwd/`process.resourcesPath`-guarded fallbacks —
// exactly the result the build-cloud Electron shim + nullable guards produced,
// now structural rather than shim-dependent.
export type AppPathHost = {
  readonly isPackaged?: boolean
  getAppPath?: () => string
  getPath?: (name: 'home' | 'userData') => string
}

let appPathHost: AppPathHost | null = null

export function setAppPathHost(host: AppPathHost | null) {
  appPathHost = host
}

export function getAppPathHost(): AppPathHost | null {
  return appPathHost
}
