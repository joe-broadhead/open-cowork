import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyGatewayTool, mcpModeAllowsHttpCapability, minimumMcpTierForHttpCapability, resolveMcpToolMode, toolEnabledForMode } from '../mcp-tool-tiers.js'
import { httpCapabilityForRequest } from '../security.js'

const mcpSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp.ts'),
  'utf8',
)

function registeredToolNames(): string[] {
  const names = new Set<string>()
  for (const match of mcpSource.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)) {
    names.add(match[1]!)
  }
  return [...names].sort()
}

describe('MCP tool tiers', () => {
  it('classifies every registered tool into a tier', () => {
    const names = registeredToolNames()
    expect(names.length).toBeGreaterThan(100)
    for (const name of names) {
      const tier = classifyGatewayTool(name)
      expect(['read', 'operate', 'admin']).toContain(tier)
    }
  })

  it('keeps the tiers cumulative: read ⊂ operate ⊂ admin', () => {
    const names = registeredToolNames()
    const enabled = (mode: 'read' | 'operate' | 'admin') =>
      new Set(names.filter(name => toolEnabledForMode(name, mode)))
    const read = enabled('read')
    const operate = enabled('operate')
    const admin = enabled('admin')
    for (const name of read) expect(operate.has(name), `${name} in read but not operate`).toBe(true)
    for (const name of operate) expect(admin.has(name), `${name} in operate but not admin`).toBe(true)
    expect(admin.size).toBe(names.length)
    expect(read.size).toBeLessThan(operate.size)
    expect(operate.size).toBeLessThan(admin.size)
  })

  it('keeps inspection tools in read and mutation tools out of it', () => {
    for (const name of ['dashboard', 'task_list', 'run_get', 'observability', 'briefing', 'agent_team_inspect']) {
      expect(classifyGatewayTool(name), name).toBe('read')
    }
    for (const name of ['task_create', 'delegation_submit', 'channel_send', 'human_gate_decide', 'permission_reject', 'scheduler_pause']) {
      expect(classifyGatewayTool(name), name).toBe('operate')
    }
    for (const name of ['config_update', 'opencode_agent_upsert', 'opencode_session_abort', 'opencode_session_messages', 'backup_create', 'backup_verify', 'recovery_drill', 'state_export', 'restore', 'restart', 'task_delete', 'scheduler_configure', 'session_admit', 'persona_create', 'agent_presence_create', 'agent_presence_update', 'permission_reply']) {
      expect(classifyGatewayTool(name), name).toBe('admin')
    }
    for (const name of ['team_assemble', 'agent_team_validate', 'agent_team_propose', 'promotion_decide', 'blueprint_apply']) {
      expect(classifyGatewayTool(name), name).toBe('admin')
    }
    for (const name of ['blueprint_preview', 'blueprint_preview_text']) {
      expect(classifyGatewayTool(name), name).toBe('operate')
    }
  })

  it('read mode never exposes anything that can mutate durable or OpenCode state', () => {
    const names = registeredToolNames()
    const mutating = /(?:^|_)(?:create|update|upsert|delete|apply|bind|decide|reply|reject|submit|send|pause|resume|configure|restart|restore|archive|abort|record|assemble|reconcile|action|control|once|propose)(?:_|$)/
    for (const name of names.filter(candidate => toolEnabledForMode(candidate, 'read'))) {
      // Read-tier names must not carry mutation verbs, with the exception of
      // report/preview builders that only generate redacted output.
      if (name === 'incident_report') continue
      expect(mutating.test(name), `read tier exposes mutating tool ${name}`).toBe(false)
    }
  })

  it('defaults to operate without admin-only tools', () => {
    expect(resolveMcpToolMode(undefined)).toBe('operate')
    expect(resolveMcpToolMode('nonsense')).toBe('operate')
    expect(resolveMcpToolMode('read')).toBe('read')
  })

  it('shares cumulative MCP mode checks with HTTP capability tiers', () => {
    expect(minimumMcpTierForHttpCapability('read')).toBe('read')
    expect(minimumMcpTierForHttpCapability('operator')).toBe('operate')
    expect(minimumMcpTierForHttpCapability('asset_write')).toBe('admin')
    expect(minimumMcpTierForHttpCapability('admin')).toBe('admin')
    expect(mcpModeAllowsHttpCapability('read', 'operator')).toBe(false)
    expect(mcpModeAllowsHttpCapability('operate', 'operator')).toBe(true)
    expect(mcpModeAllowsHttpCapability('operate', 'asset_write')).toBe(false)
    expect(mcpModeAllowsHttpCapability('admin', 'asset_write')).toBe(true)
  })

  it('does not advertise tools below the capability required by their HTTP route', () => {
    const routes = [
      ['scheduler_pause', 'POST', '/scheduler/pause'],
      ['scheduler_resume', 'POST', '/scheduler/resume'],
      ['scheduler_run_once', 'POST', '/scheduler/run'],
      ['team_assemble', 'POST', '/agent-factory/teams/assemble'],
      ['agent_team_validate', 'POST', '/agent-teams/validate'],
      ['agent_team_propose', 'POST', '/agent-teams/propose'],
      ['promotion_decide', 'POST', '/promotion/decisions'],
      ['blueprint_preview', 'POST', '/blueprints/preview'],
      ['blueprint_preview_text', 'POST', '/blueprints/preview'],
      ['blueprint_apply', 'POST', '/blueprints/apply'],
    ] as const
    const rank = { read: 0, operate: 1, admin: 2 }
    for (const [tool, method, pathname] of routes) {
      const capability = httpCapabilityForRequest({ method, pathname })
      expect(rank[classifyGatewayTool(tool)], tool).toBeGreaterThanOrEqual(rank[minimumMcpTierForHttpCapability(capability)])
    }
  })
})
