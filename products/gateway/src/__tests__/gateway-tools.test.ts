import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATEWAY_MCP_TOOL_NAMES } from '../gateway-tools.js'

describe('Gateway MCP tool inventory', () => {
  it('matches registered MCP tool names used for access inspection', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    const mcpSource = fs.readFileSync(path.join(repoRoot, 'src', 'mcp.ts'), 'utf-8')
    const registered = [...mcpSource.matchAll(new RegExp("server\\.tool\\('([^']+)'", 'g'))].map(match => `gateway_${match[1]}`).sort()

    expect([...GATEWAY_MCP_TOOL_NAMES].sort()).toEqual(registered)
  })
})
