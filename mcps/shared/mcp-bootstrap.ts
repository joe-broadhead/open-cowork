/**
 * Shared MCP response helpers (audit 2026-07-18).
 *
 * Like `bridge.ts`, this module is imported by relative path and esbuild-inlined
 * into each MCP dist bundle. It must stay **dependency-free** — do not import
 * `@modelcontextprotocol/sdk` here (typecheck runs with package-local node_modules
 * only). Server construction / stdio connect stay in each MCP package.
 */

export function textResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>
} {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  }
}
