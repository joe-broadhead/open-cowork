import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

type ConfigMcp = {
  name: string
  authMode: string
  command?: string[]
  envSettings?: Array<{ env: string; key: string }>
  credentials?: Array<{ key: string; required?: boolean }>
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

type InventorySource = {
  source?: string
  sourceRevision?: string
  sourcePath?: string
}

function tableTools(text: string, heading: string, prefix: string) {
  const start = text.indexOf(`## ${heading}`)
  assert.notEqual(start, -1, `Missing upstream inventory section ${heading}`)
  const end = text.indexOf('\n## ', start + 1)
  const tools: Array<{ name: string; readOnly: boolean }> = []
  for (const line of text.slice(start, end === -1 ? undefined : end).split('\n')) {
    const match = line.match(/^\| `([^`]+)` \|.*\| (yes|no) \|$/)
    const tool = match?.[1]
    if (tool?.startsWith(prefix)) tools.push({ name: tool, readOnly: match?.[2] === 'yes' })
  }
  return tools
}

function parseOpenWikiTools(text: string): OpenWikiInventory {
  // Current OpenWiki profiles are complete inventories rather than cumulative
  // deltas. Split the proposal profile by its authoritative read-only hint and
  // treat everything exclusive to write-full as outside this integration.
  const proposalProfile = tableTools(text, 'Proposal Mode Tools', 'wiki.')
  const proposalNames = new Set(proposalProfile.map((tool) => tool.name))
  return {
    read: proposalProfile.filter((tool) => tool.readOnly).map((tool) => tool.name),
    proposal: proposalProfile.filter((tool) => !tool.readOnly).map((tool) => tool.name),
    write: tableTools(text, 'Write Full Mode Tools', 'wiki.')
      .map((tool) => tool.name)
      .filter((tool) => !proposalNames.has(tool)),
  }
}

function parseGatewayTools(text: string): GatewayInventory {
  const inventory: GatewayInventory = { read: [], operate: [], admin: [] }
  for (const line of text.split('\n')) {
    const match = line.match(/^\| `(gateway_[^`]+)` \| (read|operate|admin) \|/)
    if (!match) continue
    inventory[match[2] as keyof GatewayInventory].push(match[1]!)
  }
  return inventory
}

function loadInventory<T>(fixturePath: string, siblingRoot: string, parseSibling: (text: string) => T) {
  const fixture = readJson<T & InventorySource>(fixturePath)
  const {
    source: _source,
    sourceRevision,
    sourcePath,
    ...fixtureInventory
  } = fixture
  if (!existsSync(siblingRoot)) return fixtureInventory as T

  let upstreamText: string | null = null
  if (sourceRevision && sourcePath) {
    let defaultRevision: string | null = null
    try {
      defaultRevision = execFileSync('git', ['-C', siblingRoot, 'rev-parse', 'origin/HEAD'], { encoding: 'utf-8' }).trim()
    } catch {
      // A sibling checkout without remote refs can still validate the pinned
      // source revision below. CI normally has no sibling and uses the fixture.
    }
    if (defaultRevision) {
      assert.equal(
        defaultRevision,
        sourceRevision,
        `${siblingRoot} default branch changed; refresh ${fixturePath} from the latest upstream contract.`,
      )
    }
    try {
      upstreamText = execFileSync('git', ['-C', siblingRoot, 'show', `${sourceRevision}:${sourcePath}`], { encoding: 'utf-8' })
    } catch {
      // The pinned commit may not exist in a shallow/offline sibling checkout.
      // The checked-in fixture remains the deterministic fallback.
    }
  }
  if (upstreamText === null && sourcePath) {
    const workingTreePath = resolve(siblingRoot, sourcePath)
    if (existsSync(workingTreePath)) upstreamText = readFileSync(workingTreePath, 'utf-8')
  }
  if (upstreamText === null) return fixtureInventory as T

  const sibling = parseSibling(upstreamText)
  assert.deepEqual(
    sibling,
    fixtureInventory,
    `${sourcePath || siblingRoot} changed; update the MCP curation fixture and open-cowork.config.json together.`,
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

function configuredMcp(name: string) {
  const config = readJson<{ mcps: ConfigMcp[] }>('open-cowork.config.json')
  const mcp = config.mcps.find((entry) => entry.name === name)
  assert.ok(mcp, `Missing configured MCP ${name}`)
  return mcp
}

test('bundled OpenWiki MCP curation matches proposal-mode upstream inventory', () => {
  const inventory = loadInventory<OpenWikiInventory>(
    'tests/fixtures/mcp-curation/openwiki-tools.json',
    resolve('../open-wiki'),
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
    resolve('../opencode-gateway'),
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

test('bundled opencode-gateway operate tier requires a least-privilege operator token file', () => {
  const mcp = configuredMcp('opencode-gateway')
  assert.equal(mcp.authMode, 'api_token')
  assert.deepEqual(mcp.command, ['opencode-gateway', 'mcp', '--tools', 'operate'])
  assert.deepEqual(mcp.envSettings, [
    { env: 'OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE', key: 'operatorTokenFile' },
  ])
  assert.deepEqual(
    mcp.credentials?.map((credential) => ({ key: credential.key, required: credential.required })),
    [{ key: 'operatorTokenFile', required: true }],
  )
  assert.equal(mcp.envSettings?.some((setting) => setting.env.includes('ADMIN')), false)
})
