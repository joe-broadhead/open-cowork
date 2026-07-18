import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { assembleBoundedTeam } from '../team-assembly.js'
import { clearConfigCacheForTest, updateConfig, type AgentProfile } from '../config.js'
import type { OpenCodeAssetAvailability } from '../access-inspection.js'
import { clearWorkStateForTest } from '../work-store.js'

describe('bounded team assembly', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-team-assembly-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const blueprintDir = path.join(testDir, 'blueprints')
  const now = new Date('2026-06-15T12:00:00.000Z')
  const availability: OpenCodeAssetAvailability = {
    agents: new Set(),
    skills: new Set(),
    mcpServers: new Set(),
    tools: new Set(),
    source: 'provided',
  }

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(blueprintDir, { recursive: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('assembles a promoted blueprint team with stable ordering, IDs, versions, and grants', () => {
    writeBlueprint(promotedBlueprint())

    const first = assembleBoundedTeam({
      idempotencyKey: 'team:req:delivery:1',
      objective: 'Ship a bounded delivery task.',
      blueprint: { name: 'delivery', version: '1.0.0' },
      teamName: 'delivery',
      roles: [
        { role: 'verify', requiredCapabilities: ['review'] },
        { role: 'implement', requiredCapabilities: ['repo-write'] },
      ],
      grants: [
        { role: 'implement', skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'], permission: { read: 'allow', edit: 'ask' }, reason: 'Implement needs scoped repo edits and task updates.' },
        { role: 'verify', skills: ['gateway-stage', 'gateway-review-gate'], mcpServers: ['gateway'], tools: ['gateway_task_update'], permission: { read: 'allow', bash: 'ask' }, reason: 'Verify needs review-gate inspection and validation evidence.' },
      ],
      budget: { maxTokens: 250000, maxConcurrentRoles: 2 },
      gates: [{ gate: 'review_pass', requiredBefore: 'complete' }],
      evidenceRequirements: [{ id: 'E1', type: 'command', summary: 'validation output' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const second = assembleBoundedTeam({
      idempotencyKey: 'team:req:delivery:1',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      team: { preferredTeam: 'delivery', roles: [{ role: 'implement' }, { role: 'verify' }] },
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(first.ok).toBe(true)
    expect(first.receipt).toMatchObject({
      status: 'accepted',
      selectedBlueprint: { name: 'delivery', version: '1.0.0' },
      selectedTeam: { name: 'delivery', version: '1.0.0', promotionState: 'promoted' },
      budget: { gatesPlaceholder: expect.any(String), enforcementPlaceholder: expect.any(String) },
      evidenceRequirements: [{ id: 'E1', type: 'command', summary: 'validation output' }],
    })
    expect(first.receipt.members.map(member => member.role)).toEqual(['implement', 'verify'])
    expect(first.receipt.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'implement', profile: 'implementer-bounded', profileVersion: '1.0.0', promotionState: 'promoted', grants: expect.objectContaining({ tools: ['gateway_task_update'] }) }),
      expect.objectContaining({ role: 'verify', profile: 'verifier-bounded', profileVersion: '1.0.0', promotionState: 'promoted', grants: expect.objectContaining({ skills: ['gateway-review-gate', 'gateway-stage'] }) }),
    ]))
    expect(second.receipt.selectedTeam.id).toBe(first.receipt.selectedTeam.id)
    expect(second.receipt.members.map(member => member.memberId)).toEqual(first.receipt.members.map(member => member.memberId))
  })

  it('omits generated default when implicit assembly has concrete stages', () => {
    const blueprint = promotedBlueprint()
    ;(blueprint.teams!.delivery as any).roles = { default: 'implementer-bounded', ...blueprint.teams!.delivery.roles }
    writeBlueprint(blueprint)

    const result = assembleBoundedTeam({
      idempotencyKey: 'team:req:implicit-stages',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(true)
    expect(result.receipt.members.map(member => member.role)).toEqual(['implement', 'verify'])
    expect(result.receipt.members.map(member => member.role)).not.toContain('default')
  })

  it('rejects invalid explicit roles instead of assembling default fallback', () => {
    const blueprint = promotedBlueprint()
    ;(blueprint.teams!.delivery as any).roles = { default: 'implementer-bounded', ...blueprint.teams!.delivery.roles }
    writeBlueprint(blueprint)

    const result = assembleBoundedTeam({
      idempotencyKey: 'team:req:invalid-role',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'bad role!' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.status).toBe('rejected')
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_role', path: 'roles.0.role', action: expect.stringContaining('letters') }),
    ]))
    expect(result.receipt.members).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'invalid', profile: 'implementer-bounded', rejectionReasons: [] }),
      expect.objectContaining({ role: 'invalid-1', profile: 'implementer-bounded', rejectionReasons: [] }),
    ]))
    expect(result.receipt.members).toEqual([
      expect.objectContaining({ role: 'invalid-1', profile: 'missing', rejectionReasons: expect.arrayContaining([expect.objectContaining({ code: 'invalid_role' })]) }),
    ])
  })

  it('fails closed when a blueprint team references a missing profile', () => {
    const blueprint = promotedBlueprint()
    delete (blueprint.profiles as Record<string, unknown>)['implementer-bounded']
    writeBlueprint(blueprint)

    const result = assembleBoundedTeam({ idempotencyKey: 'team:req:missing-profile', blueprintName: 'delivery', blueprintVersion: '1.0.0', teamName: 'delivery' }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.status).toBe('rejected')
    expect(result.receipt.rejectionReasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['blueprint_invalid_team', 'team_not_found']))
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'blueprint_invalid_team', action: expect.stringContaining('Fix') }),
    ]))
  })

  it('fails closed when a requested grant exceeds the selected profile', () => {
    writeBlueprint(promotedBlueprint())

    const result = assembleBoundedTeam({
      idempotencyKey: 'team:req:unsafe-grant',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'verify' }],
      grants: [{ role: 'verify', tools: ['*'], permission: { edit: 'allow' }, reason: 'Try to escalate.' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'wildcard_grant_denied', path: 'grants.verify.tools' }),
      expect.objectContaining({ code: 'grant_escalates_profile', path: 'grants.verify.permission.edit' }),
    ]))
  })

  it('records governed package identity in deterministic team assembly receipts', () => {
    writeBlueprint(promotedBlueprint())

    const first = assembleBoundedTeam({
      idempotencyKey: 'team:req:package:delivery',
      packageRef: {
        id: 'package:delivery-team',
        version: '1.0.0',
        fingerprint: 'abcdef1234567890',
        trustTier: 'gateway_shipped',
      },
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'implement' }, { role: 'verify' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const second = assembleBoundedTeam({
      idempotencyKey: 'team:req:package:delivery',
      packageRef: {
        id: 'package:delivery-team',
        version: '1.0.0',
        fingerprint: 'abcdef1234567890',
        trustTier: 'gateway_shipped',
      },
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'verify' }, { role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(first.ok).toBe(true)
    expect(first.receipt.selectedPackage).toEqual({
      id: 'package:delivery-team',
      version: '1.0.0',
      fingerprint: 'abcdef1234567890',
      trustTier: 'gateway_shipped',
    })
    expect(first.receipt.audit.selectionInputs).toContain('package:package:delivery-team@1.0.0#abcdef1234567890')
    expect(second.receipt.id).toBe(first.receipt.id)
    expect(second.receipt.selectedTeam.id).toBe(first.receipt.selectedTeam.id)
    expect(second.receipt.members.map(member => member.grantHash)).toEqual(first.receipt.members.map(member => member.grantHash))
  })

  it('fails closed for malformed governed package references', () => {
    writeBlueprint(promotedBlueprint())

    const result = assembleBoundedTeam({
      idempotencyKey: 'team:req:package:bad',
      packageRef: { id: 'package:delivery-team' },
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'package_ref_invalid', path: 'packageRef' }),
    ]))
  })

  it('fails closed for unpromoted profile or team versions by default', () => {
    const blueprint = promotedBlueprint()
    blueprint.profiles!['implementer-bounded'].promotionState = 'evaluated'
    ;(blueprint.teams!.delivery as any).promotionState = 'evaluated'
    writeBlueprint(blueprint)

    const result = assembleBoundedTeam({ idempotencyKey: 'team:req:unpromoted', blueprintName: 'delivery', blueprintVersion: '1.0.0', teamName: 'delivery', roles: [{ role: 'implement' }] }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'team_unpromoted' }),
      expect.objectContaining({ code: 'profile_unpromoted' }),
    ]))
  })

  it('fails closed for unsafe profile access in config teams', () => {
    const unsafeProfile = {
      ...profile('unsafe-implementer', ['repo-write']),
      permission: { read: 'allow', credential_token: 'allow' },
      promotionState: 'promoted',
    }
    updateConfig({
      profiles: { 'unsafe-implementer': unsafeProfile },
      agentTeams: { unsafe: { version: '1.0.0', promotionState: 'promoted', roles: { implement: 'unsafe-implementer' }, capabilityRequirements: {}, qualitySpecDefaults: {} } },
    } as any)

    const result = assembleBoundedTeam({ idempotencyKey: 'team:req:unsafe-profile', teamName: 'unsafe', roles: [{ role: 'implement' }] }, { availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_team_access', message: expect.stringContaining('credential_token') }),
    ]))
  })

  function writeBlueprint(blueprint: ReturnType<typeof promotedBlueprint>): void {
    fs.writeFileSync(path.join(blueprintDir, `${blueprint.name}.json`), JSON.stringify(blueprint, null, 2))
  }
})

function promotedBlueprint() {
  return {
    name: 'delivery',
    version: '1.0.0',
    requiredOpenCode: {
      agents: ['gateway-implementer', 'gateway-verifier'],
      skills: ['gateway-stage', 'gateway-review-gate'],
      mcpServers: ['gateway'],
      tools: ['gateway_task_update'],
    },
    profiles: {
      'implementer-bounded': profile('gateway-implementer', ['repo-write'], { edit: 'ask', bash: 'ask' }),
      'verifier-bounded': {
        ...profile('gateway-verifier', ['review'], { edit: 'deny', bash: 'ask' }),
        skills: ['gateway-stage', 'gateway-review-gate'],
      },
    },
    teams: {
      delivery: {
        version: '1.0.0',
        promotionState: 'promoted' as const,
        roles: { implement: 'implementer-bounded', verify: 'verifier-bounded' },
        capabilityRequirements: { implement: ['repo-write'], verify: ['review'] },
        qualitySpecDefaults: { evidenceRequirements: ['validation output'] },
      },
    },
  }
}

function profile(agent: string, capabilities: string[], permission: Record<string, string> = {}): AgentProfile {
  return {
    model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
    agent,
    skills: ['gateway-stage'],
    mcpServers: ['gateway'],
    tools: ['gateway_task_update'],
    permission: { read: 'allow', gateway_task_update: 'allow', ...permission },
    heartbeatMs: 0,
    maxTokens: 100000,
    role: 'execution',
    capabilities,
    promotionState: 'promoted',
  }
}
