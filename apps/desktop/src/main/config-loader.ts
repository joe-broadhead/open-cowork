// Back-compat re-export of the Electron-free config core (config-loader-core.ts).
// The core resolves config/app-data paths through injected hosts instead of
// importing Electron; the Electron-backed hosts are wired once by the desktop
// entry (index.ts → desktop-electron-hosts.ts), not here, so this module — and
// therefore everything in the substrate that imports it — stays Electron-free.
// The cloud server reaches this module too, with the hosts unset, and the core
// takes its env/homedir/cwd fallbacks.
export * from '@open-cowork/runtime-host/config'
