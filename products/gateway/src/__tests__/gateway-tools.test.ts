import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATEWAY_MCP_TOOL_NAMES } from '../gateway-tools.js'

describe('Gateway MCP tool inventory', () => {
  it('matches registered MCP tool names used for access inspection', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    const sources = ['mcp.ts', 'mcp-tools-ops.ts'].map((file) =>
      fs.readFileSync(path.join(repoRoot, 'src', file), 'utf-8'),
    )
    const registered = sources
      .flatMap((source) => [...source.matchAll(new RegExp("server\\.tool\\('([^']+)'", 'g'))].map((match) => `gateway_${match[1]}`))
      .sort()

    expect([...GATEWAY_MCP_TOOL_NAMES].sort()).toEqual(registered)
  })
})
