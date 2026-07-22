// Node-only entrypoint for @open-cowork/shared, exposed as `@open-cowork/shared/node`.
//
// Modules re-exported here may use Node built-ins (node:fs, node:crypto, …) and
// MUST NOT be imported from browser bundles — they are the runtime substrate
// shared by the Electron main process and the cloud server. The browser barrel
// (src/index.ts) stays Node-free; `packages/shared/tsconfig.json` sets
// `"types": []` so only files with an explicit `/// <reference types="node" />`
// see the Node globals, keeping the rest of the package browser-safe.
export * from './app-environment.js'
export * from './constant-time.js'
export * from './channel-webhook-security.js'
export * from './webhook-rate-limiter.js'
export * from './fetch-with-timeout.js'
export * from './private-host-policy.js'
export * from './safe-storage.js'
export * from './desktop-shell.js'
export * from './fs-atomic.js'
export * from './fs-read.js'
export * from './knowledge-store-helpers.js'
export * from './logger.js'
export * from './postgres-schema-integrity.js'
export * from './workflow-webhook-server.js'
