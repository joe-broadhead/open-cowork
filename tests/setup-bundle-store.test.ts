import {
  listCustomAgents,
  listCustomMcps,
  listCustomSkills,
  removeCustomAgent,
  removeCustomMcp,
  removeCustomSkill,
  saveCustomAgent,
  saveCustomMcp,
  saveCustomSkill,
} from '@open-cowork/runtime-host/native-customizations'
import { exportSetupBundle, importSetupBundle } from '@open-cowork/runtime-host/setup-bundle-store'
import { EXTENSION_REDACTED_PLACEHOLDER } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'

function withTempUserData<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-setup-bundle-'))
  const previous = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = root
  clearConfigCaches()
  const cleanup = () => {
    if (previous === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previous
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
  let result: T | Promise<T>
  try {
    result = fn()
  } catch (error) {
    cleanup()
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(cleanup)
  }
  cleanup()
  return result
}

function seedInstalledContent() {
  saveCustomMcp({
    scope: 'machine',
    directory: null,
    name: 'tickets',
    label: 'Tickets',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer super-secret' },
  })
  saveCustomSkill({
    scope: 'machine',
    directory: null,
    name: 'reports',
    content: '---\nname: reports\ndescription: "Reports"\n---\n# Reports',
  })
  saveCustomAgent({
    scope: 'machine',
    directory: null,
    name: 'reviewer',
    description: 'Reviews diffs.',
    instructions: 'Be careful.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
  }, {})
}

test('exportSetupBundle snapshots installed content with secrets redacted', () => withTempUserData(() => {
  seedInstalledContent()
  const bundle = exportSetupBundle()
  assert.equal(bundle.format, 'open-cowork-setup-bundle')
  assert.equal(bundle.version, 1)
  assert.equal(bundle.mcps.length, 1)
  assert.equal(bundle.skills.length, 1)
  assert.equal(bundle.agents.length, 1)
  // No raw secret leaks into the exported JSON.
  assert.equal(JSON.stringify(bundle).includes('super-secret'), false)
  const mcp = bundle.mcps[0]!
  assert.equal(mcp.secrets.some((s) => s.key === 'header:Authorization'), true)
}))

test('importSetupBundle installs skills/agents, defers secret-bearing MCPs, and is idempotent', () => withTempUserData(async () => {
  seedInstalledContent()
  const bundle = exportSetupBundle()

  // Wipe the deployment so import has to reinstall from the bundle.
  removeCustomMcp({ scope: 'machine', directory: null, name: 'tickets' })
  removeCustomSkill({ scope: 'machine', directory: null, name: 'reports' })
  removeCustomAgent({ scope: 'machine', directory: null, name: 'reviewer' })
  assert.equal(listCustomMcps().length, 0)
  assert.equal(listCustomSkills().length, 0)
  assert.equal(listCustomAgents().length, 0)

  // First import WITHOUT the header secret: skill + agent apply, MCP defers.
  const first = await importSetupBundle(bundle, {})
  assert.equal(first.items.find((i) => i.id === 'mcp:tickets')?.status, 'needs-secret')
  assert.equal(first.items.find((i) => i.id === 'skill:reports')?.status, 'applied')
  assert.equal(first.items.find((i) => i.id === 'agent:reviewer')?.status, 'applied')
  assert.equal(listCustomSkills().some((s) => s.name === 'reports'), true)
  assert.equal(listCustomAgents().some((a) => a.name === 'reviewer'), true)
  // The MCP was NOT installed (never persisted with a placeholder secret).
  assert.equal(listCustomMcps().length, 0)

  // Re-import with the secret supplied: MCP applies, existing items skip.
  const second = await importSetupBundle(bundle, {
    secretValues: { 'mcp:tickets': { 'header:Authorization': 'Bearer restored' } },
  })
  assert.equal(second.items.find((i) => i.id === 'mcp:tickets')?.status, 'applied')
  assert.equal(second.items.find((i) => i.id === 'skill:reports')?.status, 'skipped-conflict')
  assert.equal(second.items.find((i) => i.id === 'agent:reviewer')?.status, 'skipped-conflict')
  const installedMcp = listCustomMcps().find((m) => m.name === 'tickets')
  assert.equal(installedMcp?.headers?.Authorization, 'Bearer restored')
  assert.notEqual(installedMcp?.headers?.Authorization, EXTENSION_REDACTED_PLACEHOLDER)

  // Fully idempotent re-import: everything is now a conflict, nothing changes.
  const third = await importSetupBundle(bundle, {
    secretValues: { 'mcp:tickets': { 'header:Authorization': 'Bearer restored' } },
  })
  assert.equal(third.appliedCount, 0)
  assert.equal(third.items.every((i) => i.status === 'skipped-conflict'), true)
  assert.equal(listCustomMcps().length, 1)
  assert.equal(listCustomSkills().length, 1)
  assert.equal(listCustomAgents().length, 1)
}))

test('importSetupBundle rejects a malformed bundle', () => withTempUserData(async () => {
  await assert.rejects(() => importSetupBundle({ format: 'nope' }), /Unsupported bundle format/)
}))
