import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATEWAY_TOOL_CATALOG, GATEWAY_TOOL_GROUPS, buildGatewayToolCatalog, formatGatewayToolCatalogText } from '../gateway-tools.js'
import { classifyGatewayTool } from '../mcp-tool-tiers.js'

/**
 * Every tool registered in src/mcp.ts, including the task_/project_ lifecycle
 * families registered via loops. The literal `server.tool('name'` matches plus
 * the two documented loop families give the full runtime surface.
 */
function registeredToolNames(): string[] {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const source = fs.readFileSync(path.join(repoRoot, 'src', 'mcp.ts'), 'utf-8')
  const names = new Set<string>()
  for (const match of source.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)) names.add(match[1]!)
  // Loop-registered families use template literals, not string literals.
  for (const match of source.matchAll(/for \(const action of \[([^\]]+)\] as const\) \{\s*server\.tool\(`([a-z]+)_\$\{action\}`/g)) {
    const actions = [...match[1]!.matchAll(/'([a-z]+)'/g)].map(m => m[1]!)
    for (const action of actions) names.add(`${match[2]}_${action}`)
  }
  return [...names].sort()
}

describe('Gateway MCP tool catalog', () => {
  it('covers exactly the tools registered in src/mcp.ts', () => {
    const catalogNames = GATEWAY_TOOL_CATALOG.map(entry => entry.name).sort()
    expect(catalogNames).toEqual(registeredToolNames())
  })

  it('has no duplicate entries', () => {
    const names = GATEWAY_TOOL_CATALOG.map(entry => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('assigns every tool to a known group', () => {
    const groupIds = new Set(GATEWAY_TOOL_GROUPS.map(group => group.id))
    for (const entry of GATEWAY_TOOL_CATALOG) expect(groupIds.has(entry.group), entry.name).toBe(true)
  })

  it('groups tools and derives the tier from the shared classifier', () => {
    const grouped = buildGatewayToolCatalog()
    const flat = grouped.flatMap(group => group.tools)
    expect(flat.length).toBe(GATEWAY_TOOL_CATALOG.length)
    for (const tool of flat) {
      expect(tool.qualifiedName).toBe(`gateway_${tool.name}`)
      expect(tool.tier).toBe(classifyGatewayTool(tool.name))
    }
  })

  it('classifies the composite workflow tools into the intended groups and tiers', () => {
    const byName = new Map(GATEWAY_TOOL_CATALOG.map(entry => [entry.name, entry]))
    expect(byName.get('plan_initiative')).toMatchObject({ group: 'workflows' })
    expect(byName.get('dispatch_now')).toMatchObject({ group: 'scheduler' })
    expect(byName.get('triage')).toMatchObject({ group: 'observability' })
    // plan_initiative/dispatch_now mutate durable state → operate; triage is read.
    expect(classifyGatewayTool('plan_initiative')).toBe('operate')
    expect(classifyGatewayTool('dispatch_now')).toBe('operate')
    expect(classifyGatewayTool('triage')).toBe('read')
  })

  it('renders discovery text listing every tool with its tier', () => {
    const text = formatGatewayToolCatalogText('admin')
    for (const entry of GATEWAY_TOOL_CATALOG) expect(text).toContain(`gateway_${entry.name}`)
    expect(text).toContain('Active tier: admin')
  })
})
