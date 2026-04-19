// Short-TTL cache for the runtime tool list returned by OpenCode's
// SDK. Runtime tool enumeration round-trips to the opencode binary,
// which introspects every configured MCP. With a busy downstream (e.g.
// the Google Workspace bundle has 11 MCPs) this can land in the
// multi-second range — slow enough to feel broken when a user enters
// the Capabilities page expecting a grid of tools right away. We cache
// per (directory, provider, model) for a short window so subsequent UI
// navigation (detail view, back, search) is instant. Isolated in its
// own module so callers (catalog-handlers, mcp auth/connect/disconnect)
// can invalidate it without pulling in the rest of ipc-handlers.ts,
// which transitively imports the MCP SDK client packages and isn't
// test-environment friendly.
export const RUNTIME_TOOL_CACHE_TTL_MS = 30_000
export type RuntimeToolCacheEntry = { expiresAt: number; tools: unknown[] }
export const runtimeToolCache = new Map<string, RuntimeToolCacheEntry>()

export function invalidateRuntimeToolCache() {
  runtimeToolCache.clear()
}
