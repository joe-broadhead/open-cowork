/**
 * Shared MCP server bootstrap helpers (audit 2026-07-18).
 * Prefer these over copy-pasted textResult / stdio connect in each MCP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

export function textResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>
} {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  }
}

export function createNamedMcpServer(name: string, version: string): McpServer {
  return new McpServer({ name, version })
}

export async function connectStdioMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
