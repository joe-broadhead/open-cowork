// @open-cowork/runtime-host — the Node + OpenCode-SDK runtime substrate shared by
// the Electron main process and the cloud server. Unlike @open-cowork/shared (which
// stays browser-safe) this package may depend on @opencode-ai/sdk and Node built-ins;
// it is one of the test-sanctioned SDK "runtime authority" packages
// (tests/opencode-sdk-boundary.test.ts) and ships in the cloud Docker image.
export * from './opencode-adapter.js'
export * from './opencode-v2.js'
export * from './opencode-durable-session-events.js'
export * from './runtime-managed-server-protocol.js'
export * from './runtime-managed-server-output.js'
export * from './runtime-managed-server-core.js'

// Config substrate (Electron-free). config-loader-core itself is the `/config`
// subpath; these are its supporting modules, consumed directly across the app.
export * from './config-public.js'
export * from './config-layer-utils.js'
export * from './config-normalizer.js'
export * from './config-schema.js'
export * from './provider-catalog.js'
export * from './model-info-utils.js'
export * from './branding-assets.js'
export * from './jsonc.js'
export * from './inflight-dedup.js'
export * from './bounded-map.js'
export * from './e2e-remote-debugging.js'
