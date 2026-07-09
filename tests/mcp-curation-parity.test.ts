import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type OpenWikiInventory = {
  read: string[]
  proposal: string[]
  write: string[]
}

type GatewayInventory = {
  read: string[]
  operate: string[]
  admin: string[]
}

type ConfigTool = {
  id: string
  allowPatterns?: string[]
  askPatterns?: string[]
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function firstColumnTools(text: string, prefix: string) {
  const tools: string[] = []
  for (const line of text.split('\n')) {
    const match = line.match(/^\| `([^`]+)` \|/)
    const tool = match?.[1]
    if (tool?.startsWith(prefix)) tools.push(tool)
  }
  return tools
}

function parseOpenWikiTools(path: string): OpenWikiInventory {
  const text = readFileSync(path, 'utf-8')
  const sectionTools = (heading: string) => {
    const start = text.indexOf(`## ${heading}`)
    assert.notEqual(start, -1, `Missing OpenWiki inventory section ${heading}`)
    const end = text.indexOf('\n## ', start + 1)
    return firstColumnTools(text.slice(start, end === -1 ? undefined : end), 'wiki.')
  }
  return {
    read: sectionTools('Read Mode Tools'),
    proposal: sectionTools('Proposal Mode Tools'),
    write: sectionTools('Write Mode Tools'),
  }
}

function parseGatewayTools(path: string): GatewayInventory {
  const inventory: GatewayInventory = { read: [], operate: [], admin: [] }
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const match = line.match(/^\| `(gateway_[^`]+)` \| (read|operate|admin) \|/)
    if (!match) continue
    inventory[match[2] as keyof GatewayInventory].push(match[1]!)
  }
  return inventory
}

function loadInventory<T>(fixturePath: string, siblingPath: string, parseSibling: (path: string) => T) {
  const fixture = readJson<T & { source?: string }>(fixturePath)
  const { source: _source, ...fixtureInventory } = fixture
  if (!existsSync(siblingPath)) return fixtureInventory as T
  const sibling = parseSibling(siblingPath)
  assert.deepEqual(
    sibling,
    fixtureInventory,
    `${siblingPath} changed; update the MCP curation fixture and open-cowork.config.json together.`,
  )
  return sibling
}

function prefixed(namespace: 'openwiki' | 'opencode-gateway', tools: string[]) {
  return tools.map((tool) => `mcp__${namespace}__${tool}`)
}

function assertAbsent(label: string, values: string[], forbidden: string[]) {
  const present = forbidden.filter((tool) => values.includes(tool))
  assert.deepEqual(present, [], `${label} must not expose ${present.join(', ')}`)
}

function configuredTool(id: string) {
  const config = readJson<{ tools: ConfigTool[] }>('open-cowork.config.json')
  const tool = config.tools.find((entry) => entry.id === id)
  assert.ok(tool, `Missing configured tool ${id}`)
  return tool
}

test('bundled OpenWiki MCP curation matches proposal-mode upstream inventory', () => {
  const inventory = loadInventory<OpenWikiInventory>(
    'tests/fixtures/mcp-curation/openwiki-tools.json',
    resolve('../open-wiki/docs/reference/mcp-tools.md'),
    parseOpenWikiTools,
  )
  const tool = configuredTool('openwiki')
  const allow = tool.allowPatterns || []
  const ask = tool.askPatterns || []

  assert.deepEqual(allow, prefixed('openwiki', inventory.read))
  assert.deepEqual(ask, prefixed('openwiki', inventory.proposal))
  assertAbsent('OpenWiki allowPatterns', allow, prefixed('openwiki', inventory.proposal))
  assertAbsent('OpenWiki allowPatterns', allow, prefixed('openwiki', inventory.write))
  assertAbsent('OpenWiki askPatterns', ask, prefixed('openwiki', inventory.write))
})

test('bundled opencode-gateway MCP curation matches operate-tier upstream inventory', () => {
  const inventory = loadInventory<GatewayInventory>(
    'tests/fixtures/mcp-curation/opencode-gateway-tools.json',
    resolve('../opencode-gateway/docs/api/mcp-tools.md'),
    parseGatewayTools,
  )
  const tool = configuredTool('opencode-gateway')
  const allow = tool.allowPatterns || []
  const ask = tool.askPatterns || []

  assert.deepEqual(allow, prefixed('opencode-gateway', inventory.read))
  assert.deepEqual(ask, prefixed('opencode-gateway', inventory.operate))
  assertAbsent('opencode-gateway allowPatterns', allow, prefixed('opencode-gateway', inventory.operate))
  assertAbsent('opencode-gateway allowPatterns', allow, prefixed('opencode-gateway', inventory.admin))
  assertAbsent('opencode-gateway askPatterns', ask, prefixed('opencode-gateway', inventory.admin))
})
