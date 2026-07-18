import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyBlueprint, previewBlueprint, type BlueprintDefinition } from '../blueprints.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest } from '../work-store.js'

describe('blueprint registry', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-blueprints-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const opencodeDir = path.join(testDir, 'opencode-profile')
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_CONFIG_DIR'] = opencodeDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(opencodeDir, 'skills', 'warehouse-skill'), { recursive: true })
    fs.mkdirSync(path.join(opencodeDir, 'tools'), { recursive: true })
    fs.writeFileSync(path.join(opencodeDir, 'skills', 'warehouse-skill', 'SKILL.md'), '# Warehouse Skill\n')
    fs.writeFileSync(path.join(opencodeDir, 'tools', 'warehouse_query.ts'), 'export default {}\n')
    fs.writeFileSync(path.join(opencodeDir, 'opencode.jsonc'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      agent: { 'warehouse-agent': { mode: 'all' } },
      mcp: { warehouse: { type: 'local', command: ['node', 'warehouse.js'] } },
      skills: { paths: ['./skills'] },
    }, null, 2))
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_CONFIG_DIR']
    clearConfigCacheForTest()
  })

  it('validates a profile/team blueprint and previews Gateway config changes', () => {
    const preview = previewBlueprint(validBlueprint())

    expect(preview.ok).toBe(true)
    expect(preview.normalized.profiles['warehouse']).toMatchObject({ agent: 'warehouse-agent', skills: ['warehouse-skill'], mcpServers: ['warehouse'] })
    expect(preview.normalized.teams['warehouse']!.roles).toMatchObject({ default: 'warehouse', implement: 'warehouse', verify: 'verifier' })
    expect(preview.diff).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'profile', name: 'warehouse', action: 'create', owner: 'gateway' }),
      expect.objectContaining({ target: 'agentTeam', name: 'warehouse', action: 'create', owner: 'gateway' }),
      expect.objectContaining({ target: 'opencodeAgent', name: 'warehouse-agent', action: 'noop', owner: 'opencode' }),
    ]))
    expect(preview.apply).toMatchObject({ mode: 'proposal', safe: true })
  })

  it('detects missing OpenCode assets and unresolved MCP/tool references', () => {
    const blueprint = validBlueprint()
    blueprint.requiredOpenCode = { agents: ['missing-agent'], skills: ['missing-skill'], mcpServers: ['missing-mcp'], tools: ['missing-tool'] }
    blueprint.profiles!['warehouse'] = { ...blueprint.profiles!['warehouse']!, agent: 'missing-agent', skills: ['missing-skill'], mcpServers: ['unlisted-mcp'], tools: ['unlisted-tool'] }

    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(false)
    expect(preview.validation.errors.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'missing_opencode_agent',
      'missing_opencode_skill',
      'missing_opencode_mcp',
      'missing_opencode_tool',
      'unresolved_mcp_reference',
      'unresolved_tool_reference',
    ]))
  })

  it('fails closed for unknown Gateway-prefixed tool references', () => {
    const blueprint = validBlueprint()
    blueprint.requiredOpenCode = { ...blueprint.requiredOpenCode, tools: ['gateway_not_real'] }
    blueprint.profiles!['warehouse'] = { ...blueprint.profiles!['warehouse']!, mcpServers: ['gateway'], tools: ['gateway_not_real'] }

    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(false)
    expect(preview.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_opencode_tool', path: 'requiredOpenCode.tools.gateway_not_real' }),
    ]))
  })

  it('detects unsafe permission grants and missing required permissions', () => {
    const blueprint = validBlueprint()
    blueprint.profiles!['warehouse'] = {
      ...blueprint.profiles!['warehouse']!,
      permission: { credential_token: 'allow', bash: 'allow' },
    }

    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(false)
    expect(preview.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_permission', path: 'profiles.warehouse.permission.read' }),
      expect.objectContaining({ code: 'unsafe_permission', path: 'profiles.warehouse.permission.credential_token' }),
    ]))
    expect(preview.validation.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_permission', path: 'profiles.warehouse.permission.bash' }),
    ]))
  })

  it('detects duplicate grants and unsafe broad permission grants', () => {
    const blueprint = validBlueprint()
    blueprint.requiredOpenCode = { ...blueprint.requiredOpenCode!, skills: ['warehouse-skill', 'warehouse-skill'], tools: ['warehouse_query', 'warehouse_query'] }
    blueprint.profiles!['warehouse'] = {
      ...blueprint.profiles!['warehouse']!,
      skills: ['warehouse-skill', 'warehouse-skill'],
      tools: ['warehouse_query', 'warehouse_query'],
      permission: { read: 'allow', '*': 'allow', 'gateway_*': 'allow', warehouse_query: 'allow' },
    }

    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(false)
    expect(preview.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_grant', path: 'requiredOpenCode.skills.warehouse-skill' }),
      expect.objectContaining({ code: 'duplicate_grant', path: 'profiles.warehouse.skills.warehouse-skill' }),
      expect.objectContaining({ code: 'unsafe_permission', path: 'profiles.warehouse.permission.*' }),
      expect.objectContaining({ code: 'unsafe_permission', path: 'profiles.warehouse.permission.gateway_*' }),
    ]))
  })

  it('detects environment gaps before dispatch', () => {
    const blueprint = validBlueprint()
    blueprint.environments = ['missing-env']
    blueprint.profiles!['warehouse'] = { ...blueprint.profiles!['warehouse']!, environment: 'missing-env' }

    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(false)
    expect(preview.validation.errors.map(issue => issue.code)).toEqual(expect.arrayContaining(['missing_environment', 'environment_gap']))
  })

  it('applies valid blueprint proposals through existing profile and team config paths', () => {
    const result = applyBlueprint(validBlueprint())

    expect(result.applied).toBe(true)
    expect(result.receipt).toMatchObject({ blueprint: { name: 'warehouse', version: '1.0.0' }, changed: expect.any(Array) })
    expect(getConfig().profiles['warehouse']).toMatchObject({ agent: 'warehouse-agent', skills: ['warehouse-skill'] })
    expect(getConfig().profiles['warehouse']!.version).toBe('1.0.0')
    expect(getConfig().profiles['warehouse']!.updatedAt).toBeDefined()
    expect(getConfig().agentTeams['warehouse']).toMatchObject({ roles: { default: 'warehouse', implement: 'warehouse', verify: 'verifier' } })
    expect(getConfig().agentTeams['warehouse']!.updatedAt).toBeDefined()
  })

  it('blocks apply when previewed profile or team revisions have changed', () => {
    updateConfig({
      profiles: { warehouse: validBlueprint().profiles!['warehouse'] },
      agentTeams: { warehouse: validBlueprint().teams!['warehouse'] },
    } as any)
    const blueprint = validBlueprint()
    const preview = previewBlueprint(blueprint)
    const profileRevision = preview.diff.find(entry => entry.target === 'profile' && entry.name === 'warehouse')?.beforeRevision
    const teamRevision = preview.diff.find(entry => entry.target === 'agentTeam' && entry.name === 'warehouse')?.beforeRevision

    updateConfig({
      profiles: { warehouse: { ...getConfig().profiles['warehouse'], description: 'Changed by another operator' } },
      agentTeams: { warehouse: { ...getConfig().agentTeams['warehouse'], description: 'Changed by another operator' } },
    } as any)
    blueprint.expected = { profiles: { warehouse: profileRevision! }, teams: { warehouse: teamRevision! } }

    const conflict = previewBlueprint(blueprint)

    expect(conflict.ok).toBe(false)
    expect(conflict.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'version_conflict', path: 'expected.profiles.warehouse' }),
      expect.objectContaining({ code: 'version_conflict', path: 'expected.teams.warehouse' }),
    ]))
    expect(() => applyBlueprint(blueprint)).toThrow(/version_conflict|changed since preview/)
  })

  it('records rollback metadata for prior versions and deprecation targets', () => {
    updateConfig({
      profiles: {
        warehouse: {
          ...validBlueprint().profiles!['warehouse'],
          description: 'Old warehouse profile',
          promotionState: 'deprecated',
        },
      },
      agentTeams: {
        warehouse: {
          version: '0.9.0',
          promotionState: 'deprecated',
          roles: { default: 'warehouse' },
          qualitySpecDefaults: { evidenceRequirements: ['old proof'] },
        },
      },
    } as any)

    const blueprint = validBlueprint()
    blueprint.rollback = { replaces: ['warehouse'], deprecates: ['warehouse'], rollbackTargets: ['warehouse'], notes: 'Use warehouse@0.9.0 if 1.0.0 fails.' }
    const preview = previewBlueprint(blueprint)

    expect(preview.ok).toBe(true)
    expect(preview.blueprint.rollback).toMatchObject({ deprecates: ['warehouse'], rollbackTargets: ['warehouse'] })
    expect(preview.rollback).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'profile', name: 'warehouse', previous: expect.objectContaining({ description: 'Old warehouse profile' }) }),
      expect.objectContaining({ target: 'agentTeam', name: 'warehouse', previousVersion: '0.9.0' }),
    ]))
    expect(preview.diff).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'profile', name: 'warehouse', action: 'update' }),
      expect.objectContaining({ target: 'agentTeam', name: 'warehouse', action: 'update' }),
    ]))
  })
})

function validBlueprint(): BlueprintDefinition {
  return {
    name: 'warehouse',
    version: '1.0.0',
    metadata: { title: 'Warehouse delivery team', owner: 'data-platform' },
    requiredOpenCode: {
      agents: ['warehouse-agent'],
      skills: ['warehouse-skill'],
      mcpServers: ['warehouse'],
      tools: ['warehouse_query'],
    },
    environments: ['local-process'],
    profiles: {
      warehouse: {
        description: 'Warehouse implementer profile',
        model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
        agent: 'warehouse-agent',
        skills: ['warehouse-skill'],
        mcpServers: ['warehouse'],
        tools: ['warehouse_query'],
        permission: { read: 'allow', grep: 'allow', warehouse_query: 'allow', edit: 'ask', bash: 'ask' },
        heartbeatMs: 0,
        maxTokens: 100000,
        role: 'execution',
        environment: 'local-process',
        capabilities: ['warehouse', 'sql'],
        budget: { maxTokens: 100000, retryLimit: 1, humanGate: 'on-risk' },
        outputContract: { format: 'stage-result', requiredEvidence: ['query result'], failureClass: true },
        promotionState: 'evaluated',
      },
    },
    teams: {
      warehouse: {
        version: '1.0.0',
        promotionState: 'evaluated',
        roles: { implement: 'warehouse', verify: 'verifier' },
        capabilityRequirements: { implement: ['warehouse', 'warehouse_query'], verify: ['gateway-review-gate'] },
        qualitySpecDefaults: { evidenceRequirements: ['warehouse query output'], verificationCommands: ['npm test'] },
      },
    },
    qualityDefaults: { evidenceRequirements: ['query output'] },
    rollback: { replaces: [], deprecates: [], rollbackTargets: [] },
  }
}
