// Back-compat re-export of the shared logger core (@open-cowork/shared/node).
// The log destination (data dir + brand prefix) is wired into the core's injected
// storage seam by the entries — the desktop via desktop-electron-hosts.ts (loaded
// first by index.ts) and the cloud via scripts/open-cowork-cloud.ts — so this
// module carries no config-loader dependency and substrate modules can import the
// core directly. Kept as a thin re-export so existing desktop importers are unchanged.
export { log, getLogFilePath, closeLogger, pruneLogDirectory } from '@open-cowork/shared/node'
