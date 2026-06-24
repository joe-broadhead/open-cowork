// @open-cowork/runtime-host/config — the Electron-free Open Cowork configuration
// core (config-loader-core), shared by the desktop main process and the cloud
// server. App-data/config paths resolve through the injected AppPathHost
// (@open-cowork/shared/node), wired by the desktop entry and the cloud entry.
export * from './config-loader-core.js'
