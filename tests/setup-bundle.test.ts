import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CustomMcpConfig, SetupBundle } from '@open-cowork/shared'
import {
  SETUP_BUNDLE_FORMAT,
  agentToExtensionDescriptor,
  buildSetupBundle,
  mcpToExtensionDescriptor,
  planSetupBundleImport,
  skillToExtensionDescriptor,
  stringifySetupBundle,
  summarizeImportItems,
  validateSetupBundle,
} from '@open-cowork/shared'

function sampleBundle(): SetupBundle {
  const mcp: CustomMcpConfig = {
    scope: 'machine',
    directory: null,
    name: 'tickets',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret' },
  }
  return buildSetupBundle({
    now: '2026-01-01T00:00:00.000Z',
    exportedBy: 'Example Cowork',
    mcps: [mcpToExtensionDescriptor(mcp)],
    skills: [skillToExtensionDescriptor({
      scope: 'machine', directory: null, name: 'reports', content: '# reports',
    })],
    agents: [agentToExtensionDescriptor({
      scope: 'machine', directory: null, name: 'reviewer', description: 'd', instructions: 'i',
      skillNames: [], toolIds: ['read'], enabled: true, color: 'accent',
    })],
  })
}

describe('buildSetupBundle', () => {
  it('emits a versioned bundle with grouped descriptors', () => {
    const bundle = sampleBundle()
    assert.equal(bundle.format, SETUP_BUNDLE_FORMAT)
    assert.equal(bundle.version, 1)
    assert.equal(bundle.exportedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(bundle.exportedBy, 'Example Cowork')
    assert.equal(bundle.mcps.length, 1)
    assert.equal(bundle.skills.length, 1)
    assert.equal(bundle.agents.length, 1)
    assert.ok(stringifySetupBundle(bundle).endsWith('\n'))
  })
})

describe('validateSetupBundle', () => {
  it('accepts a well-formed bundle', () => {
    const result = validateSetupBundle(JSON.parse(stringifySetupBundle(sampleBundle())))
    assert.equal(result.ok, true)
  })

  it('rejects a wrong format', () => {
    const result = validateSetupBundle({ format: 'nope', version: 1, exportedAt: 'x', skills: [], mcps: [], agents: [] })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.match(result.error, /Unsupported bundle format/)
  })

  it('rejects an unknown version', () => {
    const bundle = { ...sampleBundle(), version: 99 }
    const result = validateSetupBundle(bundle)
    assert.equal(result.ok, false)
  })

  it('rejects a malformed descriptor array', () => {
    const bundle = { ...sampleBundle(), mcps: [{ not: 'a descriptor' }] }
    const result = validateSetupBundle(bundle)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unreachable')
    assert.match(result.error, /mcps.*malformed/)
  })

  it('defaults missing arrays to empty', () => {
    const result = validateSetupBundle({ format: SETUP_BUNDLE_FORMAT, version: 1, exportedAt: 'x' })
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('unreachable')
    assert.deepEqual(result.bundle.mcps, [])
  })
})

describe('planSetupBundleImport', () => {
  const bundle = sampleBundle()

  it('marks an item with unmet required secrets as needs-secret', () => {
    const plan = planSetupBundleImport(bundle, { existing: { skills: [], mcps: [], agents: [] } })
    const mcpItem = plan.items.find((i) => i.id === 'mcp:tickets')
    assert.equal(mcpItem?.status, 'needs-secret')
    assert.equal(mcpItem?.missingSecrets.length, 1)
    // Skill/agent have no secrets → apply.
    assert.equal(plan.items.find((i) => i.id === 'skill:reports')?.status, 'applied')
    assert.equal(plan.items.find((i) => i.id === 'agent:reviewer')?.status, 'applied')
  })

  it('applies an item once its secret is supplied', () => {
    const plan = planSetupBundleImport(bundle, {
      existing: { skills: [], mcps: [], agents: [] },
      secretValues: { 'mcp:tickets': { 'header:Authorization': 'Bearer restored' } },
    })
    assert.equal(plan.items.find((i) => i.id === 'mcp:tickets')?.status, 'applied')
  })

  it('is idempotent — existing names are skipped as conflicts, not overwritten', () => {
    const plan = planSetupBundleImport(bundle, {
      existing: { skills: ['reports'], mcps: ['tickets'], agents: ['reviewer'] },
      secretValues: { 'mcp:tickets': { 'header:Authorization': 'x' } },
    })
    assert.ok(plan.items.every((i) => i.status === 'skipped-conflict'))
  })

  it('overwrite=true re-applies existing items when secrets are present', () => {
    const plan = planSetupBundleImport(bundle, {
      existing: { skills: ['reports'], mcps: ['tickets'], agents: ['reviewer'] },
      overwrite: true,
      secretValues: { 'mcp:tickets': { 'header:Authorization': 'x' } },
    })
    assert.ok(plan.items.every((i) => i.status === 'applied'))
  })

  it('conflict takes priority over needs-secret for idempotency', () => {
    const plan = planSetupBundleImport(bundle, {
      existing: { skills: [], mcps: ['tickets'], agents: [] },
    })
    // tickets exists → skipped-conflict even though its secret is unmet.
    assert.equal(plan.items.find((i) => i.id === 'mcp:tickets')?.status, 'skipped-conflict')
  })
})

describe('summarizeImportItems', () => {
  it('tallies the outcome buckets', () => {
    const bundle = sampleBundle()
    const plan = planSetupBundleImport(bundle, { existing: { skills: [], mcps: [], agents: [] } })
    const summary = summarizeImportItems(plan.version, plan.items)
    assert.equal(summary.appliedCount, 2)
    assert.equal(summary.needsSecretCount, 1)
    assert.equal(summary.skippedCount, 0)
  })
})
