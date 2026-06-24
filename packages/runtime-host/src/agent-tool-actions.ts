import type { CustomAgentConfig, ScopedArtifactRef } from '@open-cowork/shared'
import { getBrandName } from '@open-cowork/runtime-host/config'
import { getCustomAgentCatalog, invalidateCustomAgentCatalogCache } from './custom-agents.js'
import {
  buildCustomAgentPermissionFromCatalog,
  normalizeCustomAgent,
  validateCustomAgent,
} from './custom-agents-utils.js'
import { listCustomAgents, removeCustomAgent, saveCustomAgent } from './native-customizations.js'
import { resolveProjectDirectory } from './runtime-paths.js'

type AgentToolContext = {
  directory?: string | null
}

function contextForAgent(agent: CustomAgentConfig): AgentToolContext {
  return {
    directory: agent.scope === 'project' ? agent.directory || null : null,
  }
}

function sameScopedAgent(left: CustomAgentConfig, right: CustomAgentConfig | ScopedArtifactRef) {
  if (left.name !== right.name || left.scope !== right.scope) return false
  if (left.scope === 'machine') return true
  return resolveProjectDirectory(left.directory) === resolveProjectDirectory(right.directory)
}

function hasOwn(object: object, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function findExistingAgent(agent: CustomAgentConfig, context: AgentToolContext) {
  return listCustomAgents(context)
    .map(normalizeCustomAgent)
    .find((entry) => sameScopedAgent(entry, agent))
}

function mergeOmittedAgentGuardrails(agent: CustomAgentConfig) {
  const normalized = normalizeCustomAgent(agent)
  const context = contextForAgent(normalized)
  const existing = findExistingAgent(normalized, context)
  if (!existing) return agent

  const input = agent as unknown as Record<string, unknown>
  return {
    ...agent,
    mode: hasOwn(input, 'mode') ? agent.mode : existing.mode,
    permissionOverrides: hasOwn(input, 'permissionOverrides')
      ? agent.permissionOverrides
      : existing.permissionOverrides,
  }
}

function siblingNamesFor(agent: CustomAgentConfig, context: AgentToolContext) {
  return listCustomAgents(context)
    .filter((entry) => !sameScopedAgent(normalizeCustomAgent(entry), agent))
    .map((entry) => normalizeCustomAgent(entry).name)
}

function agentSummary(agent: CustomAgentConfig) {
  const normalized = normalizeCustomAgent(agent)
  return {
    scope: normalized.scope,
    directory: normalized.directory,
    name: normalized.name,
    description: normalized.description,
    skillNames: normalized.skillNames,
    toolIds: normalized.toolIds,
    enabled: normalized.enabled,
    color: normalized.color,
    mode: normalized.mode,
    model: normalized.model,
    variant: normalized.variant,
    temperature: normalized.temperature,
    top_p: normalized.top_p,
    steps: normalized.steps,
    options: normalized.options,
    deniedToolPatterns: normalized.deniedToolPatterns,
    permissionOverrides: normalized.permissionOverrides,
  }
}

function normalizeTarget(target: ScopedArtifactRef): ScopedArtifactRef {
  const scope = target.scope === 'project' ? 'project' : 'machine'
  return {
    name: String(target.name || '').trim().toLowerCase(),
    scope,
    directory: scope === 'project' ? resolveProjectDirectory(target.directory) : null,
  }
}

export async function previewAgentFromTool(agent: CustomAgentConfig) {
  const merged = mergeOmittedAgentGuardrails(agent)
  const normalized = normalizeCustomAgent(merged)
  const context = contextForAgent(normalized)
  const catalog = await getCustomAgentCatalog(context)
  const issues = validateCustomAgent(merged, catalog, siblingNamesFor(normalized, context))
  const permission = issues.length === 0
    ? buildCustomAgentPermissionFromCatalog(normalized, catalog)
    : null
  return {
    ok: issues.length === 0,
    agent: agentSummary(normalized),
    issues,
    permission,
    brandName: getBrandName(),
  }
}

export async function saveAgentFromTool(agent: CustomAgentConfig) {
  const merged = mergeOmittedAgentGuardrails(agent)
  const preview = await previewAgentFromTool(merged)
  if (!preview.ok) {
    throw new Error(preview.issues[0]?.message || 'Invalid custom agent.')
  }
  const normalized = normalizeCustomAgent(merged)
  saveCustomAgent(normalized, preview.permission || {})
  invalidateCustomAgentCatalogCache()
  return {
    ok: true,
    saved: true,
    agent: agentSummary(normalized),
    runtimeRefreshRequired: true,
  }
}

export function listAgentsFromTool(context: AgentToolContext = {}) {
  return {
    ok: true,
    agents: listCustomAgents(context).map(agentSummary),
  }
}

export function getAgentFromTool(target: ScopedArtifactRef) {
  const normalizedTarget = normalizeTarget(target)
  const agent = listCustomAgents({ directory: normalizedTarget.directory })
    .map(normalizeCustomAgent)
    .find((entry) => sameScopedAgent(entry, normalizedTarget))
  if (!agent) {
    throw new Error(`Custom agent not found: ${target.name}`)
  }
  return {
    ok: true,
    agent: agentSummary(agent),
  }
}

export function deleteAgentFromTool(target: ScopedArtifactRef) {
  const normalizedTarget = normalizeTarget(target)
  removeCustomAgent(normalizedTarget)
  invalidateCustomAgentCatalogCache()
  return {
    ok: true,
    deleted: true,
    target: normalizedTarget,
    runtimeRefreshRequired: true,
  }
}
