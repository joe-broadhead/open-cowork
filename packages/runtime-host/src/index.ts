// @open-cowork/runtime-host — the Node + OpenCode-SDK runtime substrate shared by
// the Electron main process and the cloud server. Unlike @open-cowork/shared (which
// stays browser-safe) this package may depend on @opencode-ai/sdk and Node built-ins;
// it is one of the test-sanctioned SDK "runtime authority" packages
// (tests/opencode-sdk-boundary.test.ts) and ships in the cloud Docker image.
export * from './opencode-adapter.js'
