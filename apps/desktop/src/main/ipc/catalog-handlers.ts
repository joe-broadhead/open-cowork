import { getClient, getClientForDirectory, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { invalidateRuntimeToolCache } from '@open-cowork/runtime-host/runtime-tool-cache'
import { listCustomAgents, removeCustomAgent, saveCustomAgent } from '@open-cowork/runtime-host/native-customizations'
import { readEffectiveSkillBundleFile } from '@open-cowork/runtime-host/effective-skills'
import { getCustomAgentCatalog, getCustomAgentSummaries, invalidateCustomAgentCatalogCache, normalizeCustomAgent, validateCustomAgent, type CustomAgentCatalog } from '@open-cowork/runtime-host/custom-agents'
import { getCapabilitySkillBundle, getCapabilityTool, listCapabilitySkills, listCapabilityTools } from '@open-cowork/runtime-host/capability-catalog'
import type {
  CapabilitySkill,
  CapabilityTool,
  CustomAgentConfig,
  RuntimeAgentDescriptor,
  RuntimeContextOptions,
  ScopedArtifactRef,
  ToolListOptions,
} from '@open-cowork/shared'
import { performance } from 'node:perf_hooks'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'
import {
  objectAndObjectArgs,
  objectAndOptionalStringArgs,
  objectArg,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndOptionalObjectArgs,
  stringArg,
  twoStringsAndOptionalObjectArgs,
} from './schema.ts'
import {
  validateCustomAgentConfig,
  validateRuntimeContextOptions,
  validateScopedArtifactRef,
  validateToolListOptions,
} from './object-validators.ts'
import { listBuiltInAgentDetails } from '../built-in-agent-details.ts'
import { expandMcpToolPermissionPatterns, getConfiguredToolPatterns, getConfiguredToolsFromConfig } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'
import { createKeyedPromiseChain } from '../promise-chain.ts'
import { preflightConfiguredApiTokenMcp } from '../mcp-preflight.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

function resolveContext(context: IpcHandlerContext, options?: RuntimeContextOptions) {
  return {
    ...options,
    directory: context.resolveContextDirectory(options),
  }
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasOwn(object: object, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

const NATIVE_RUNTIME_TOOL_IDS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'websearch',
  'webfetch',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'question',
  'todowrite',
  'codesearch',
])
const runMcpTransitionForName = createKeyedPromiseChain()

const WRITE_TOOL_IDS = new Set(['edit', 'write', 'apply_patch', 'todowrite'])
const WRITE_PERMISSION_ACTIONS = new Set(['ask', 'allow'])
const AGENT_COLORS: CustomAgentCatalog['colors'] = ['primary', 'warning', 'accent', 'success', 'info', 'secondary']

function invalidateRuntimeCapabilityCaches() {
  invalidateRuntimeToolCache()
  invalidateCustomAgentCatalogCache()
}

function cloudCatalogTool(tool: CapabilityTool): CustomAgentCatalog['tools'][number] {
  return {
    id: tool.id,
    name: tool.name,
    icon: tool.kind === 'mcp' ? 'plug' : 'terminal',
    description: tool.description,
    supportsWrite: tool.patterns.some((pattern) => WRITE_TOOL_IDS.has(pattern) || pattern.includes('write') || pattern.includes('edit')),
    source: tool.source === 'custom' ? 'custom' : 'builtin',
    patterns: tool.patterns,
    allowPatterns: tool.patterns,
    askPatterns: [],
  }
}

function cloudCatalogSkill(skill: CapabilitySkill): CustomAgentCatalog['skills'][number] {
  return {
    name: skill.name,
    label: skill.label,
    description: skill.description,
    source: skill.source,
    origin: skill.origin,
    scope: skill.scope,
    location: null,
    toolIds: skill.toolIds,
  }
}

async function getCloudAgentCatalog(context: IpcHandlerContext, event: IpcMainInvokeEvent, workspaceId: string | null, excludedTarget?: ScopedArtifactRef): Promise<CustomAgentCatalog> {
  const [tools, skills, customAgents] = await Promise.all([
    context.workspaceGateway.listCloudCapabilityTools(event, workspaceId),
    context.workspaceGateway.listCloudCapabilitySkills(event, workspaceId),
    context.workspaceGateway.listCloudCustomAgents(event, workspaceId),
  ])
  const reservedCustomAgents = excludedTarget
    ? customAgents.filter((agent) => !sameScopedAgent(normalizeCustomAgent(agent), excludedTarget))
    : customAgents
  return {
    tools: tools.map(cloudCatalogTool),
    skills: skills.map(cloudCatalogSkill),
    reservedNames: reservedCustomAgents.map((agent) => normalizeCustomAgent(agent).name).sort((a, b) => a.localeCompare(b)),
    colors: AGENT_COLORS,
  }
}

function assertCloudAgentIsPortable(agent: CustomAgentConfig): CustomAgentConfig {
  if (agent.scope === 'project' || agent.directory) throw new Error('Cloud custom agents cannot reference local project paths.')
  if ((agent.permissionOverrides || []).some((override) => override.key === 'external_directory')) {
    throw new Error('Cloud custom agents cannot reference local external-directory permissions.')
  }
  return {
    ...agent,
    scope: 'machine',
    directory: null,
  }
}

function permissionOverrideCanWrite(agent: CustomAgentConfig) {
  return (agent.permissionOverrides || []).some((override) => (
    (override.key === 'edit' || override.key === 'bash' || override.key === 'task' || override.key === 'external_directory' || override.key === 'mcp') &&
    (
      override.action === 'allow' ||
      override.action === 'ask' ||
      (override.rules || []).some((rule) => rule.action === 'allow' || rule.action === 'ask')
    )
  ))
}

function sameScopedAgent(left: CustomAgentConfig, right: ScopedArtifactRef) {
  const leftName = (left.name || '').trim().toLowerCase()
  const rightName = (right.name || '').trim().toLowerCase()
  const leftScope = left.scope === 'project' ? 'project' : 'machine'
  const rightScope = right.scope === 'project' ? 'project' : 'machine'
  return leftName === rightName
    && leftScope === rightScope
    && (left.directory || null) === (right.directory || null)
}

function mergeOmittedAgentGuardrails(agent: CustomAgentConfig, existing: CustomAgentConfig | null | undefined): CustomAgentConfig {
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

function cloudAgentSummary(agent: CustomAgentConfig) {
  return {
    ...agent,
    mode: agent.mode === 'primary' ? 'primary' : 'subagent',
    writeAccess: agent.toolIds.some((toolId) => WRITE_TOOL_IDS.has(toolId) || toolId === 'bash') || permissionOverrideCanWrite(agent),
    valid: true,
    issues: [],
  }
}

async function timeAgentCatalogHandler<T>(name: 'agents:list' | 'agents:catalog' | 'agents:runtime', work: () => Promise<T>) {
  const start = performance.now()
  try {
    return await work()
  } finally {
    const durationMs = performance.now() - start
    log('agent', `${name} completed in ${Math.round(durationMs)}ms`)
  }
}

function patternMatches(pattern: string, value: string) {
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let resumeValueIndex = 0

  while (valueIndex < value.length) {
    const patternChar = pattern[patternIndex]
    if (patternChar === '?' || patternChar === value[valueIndex]) {
      patternIndex += 1
      valueIndex += 1
    } else if (patternChar === '*') {
      starIndex = patternIndex
      resumeValueIndex = valueIndex
      patternIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeValueIndex += 1
      valueIndex = resumeValueIndex
    } else {
      return false
    }
  }

  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

function permissionActionAllows(value: unknown): boolean {
  return typeof value === 'string' && WRITE_PERMISSION_ACTIONS.has(value)
}

function permissionRuleEntries(value: unknown): Array<{ pattern: string; action: unknown }> {
  if (permissionActionAllows(value)) return [{ pattern: '*', action: value }]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([pattern, action]) => ({ pattern, action }))
}

function permissionValueHasAllowedRule(value: unknown): boolean {
  return permissionRuleEntries(value).some((entry) => permissionActionAllows(entry.action))
}

function configuredToolIdsForPermissionPattern(pattern: string) {
  const expanded = expandMcpToolPermissionPatterns([pattern]).map((entry) => entry.toLowerCase())
  const toolIds: string[] = []
  for (const tool of getConfiguredToolsFromConfig()) {
    const configuredPatterns = getConfiguredToolPatterns(tool)
      .flatMap((entry) => expandMcpToolPermissionPatterns([entry]))
      .map((entry) => entry.toLowerCase())
    if (expanded.some((entry) => configuredPatterns.some((configured) => (
      configured === entry || patternMatches(configured, entry) || patternMatches(entry, configured)
    )))) {
      toolIds.push(tool.id)
    }
  }
  return toolIds
}

function mcpNamespaceFromPermissionPattern(pattern: string) {
  const match = pattern.match(/^mcp__([a-z0-9][a-z0-9_-]*)__[^/]+$/i)
  return match?.[1] || null
}

export function runtimeAgentToolIds(agent: unknown): string[] {
  const toolIds = new Set<string>()
  const nativePermissions = Array.isArray((agent as { permissions?: unknown }).permissions)
    ? (agent as { permissions: unknown[] }).permissions
    : []
  for (const value of nativePermissions) {
    const rule = recordFrom(value)
    const action = typeof rule.action === 'string' ? rule.action : ''
    if (!action || rule.effect === 'deny') continue
    if (NATIVE_RUNTIME_TOOL_IDS.has(action)) toolIds.add(action)
    for (const toolId of configuredToolIdsForPermissionPattern(action)) toolIds.add(toolId)
    const namespace = mcpNamespaceFromPermissionPattern(action)
    if (namespace) toolIds.add(namespace)
  }
  const permission = recordFrom((agent as { permission?: unknown }).permission)
  for (const [key, value] of Object.entries(permission)) {
    if (!permissionValueHasAllowedRule(value)) continue
    if (NATIVE_RUNTIME_TOOL_IDS.has(key)) {
      toolIds.add(key)
      continue
    }
    for (const toolId of configuredToolIdsForPermissionPattern(key)) toolIds.add(toolId)
    const namespace = mcpNamespaceFromPermissionPattern(key)
    if (namespace) toolIds.add(namespace)
  }
  return Array.from(toolIds).sort((a, b) => a.localeCompare(b))
}

function bashPatternLooksWriteCapable(pattern: string) {
  const normalized = pattern.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized || normalized === '*') return true
  if (/[;&|<>`$]/.test(normalized)) return true

  return !(
    /^git (status|diff|log|show|branch|rev-parse|ls-files|grep)\b/.test(normalized)
    || /^(cat|cut|find|grep|head|jq|ls|pwd|rg|sed|sort|tail|uniq|wc)\b/.test(normalized)
  )
}

function permissionBashAllowsWrite(value: unknown): boolean {
  if (permissionActionAllows(value)) return true
  return permissionRuleEntries(value)
    .filter((entry) => permissionActionAllows(entry.action))
    .some((entry) => bashPatternLooksWriteCapable(entry.pattern))
}

export function runtimeAgentCanWrite(agent: unknown): boolean {
  const nativePermissions = Array.isArray((agent as { permissions?: unknown }).permissions)
    ? (agent as { permissions: unknown[] }).permissions
    : []
  if (nativePermissions.some((value) => {
    const rule = recordFrom(value)
    return typeof rule.action === 'string'
      && WRITE_TOOL_IDS.has(rule.action)
      && rule.effect !== 'deny'
  })) return true
  const permission = recordFrom((agent as { permission?: unknown }).permission)
  return permissionValueHasAllowedRule(permission.edit)
    || permissionValueHasAllowedRule(permission.write)
    || permissionValueHasAllowedRule(permission.apply_patch)
    || permissionValueHasAllowedRule(permission.todowrite)
    || permissionBashAllowsWrite(permission.bash)
}

function runtimeAgentSteps(agent: unknown): number | null {
  const record = recordFrom(agent)
  const value = typeof record.maxSteps === 'number' ? record.maxSteps : record.steps
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function authenticateMcpThroughRuntime(client: {
  mcp: {
    auth: {
      remove?: (payload: { name: string }) => Promise<unknown>
      authenticate: (payload: { name: string }) => Promise<unknown>
    }
  }
}, mcpName: string) {
  if (client.mcp.auth.remove) {
    try {
      await client.mcp.auth.remove({ name: mcpName })
      log('mcp', `Cleared OAuth credentials for ${mcpName}`)
    } catch (err) {
      log('mcp', `OAuth credential clear skipped for ${mcpName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await client.mcp.auth.authenticate({ name: mcpName })
  invalidateRuntimeCapabilityCaches()
  return true
}

export function registerCatalogHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'tool:list', optionalObjectArg<ToolListOptions>('tool list options', validateToolListOptions), async (_event, options) => {
    return context.listRuntimeTools(options)
  })

  // MCP state transitions (auth / connect / disconnect) all change the
  // set of tools the SDK exposes on its next status probe. Drop the
  // runtime-tool cache so the Capabilities UI doesn't keep rendering
  // the pre-transition tool list for up to 30s — the user clicks
  // "Authenticate" and immediately expects the new tools to show.
  registerIpcInvoke(context, 'mcp:auth', stringArg('MCP name'), async (_event, mcpName) => {
    return runMcpTransitionForName(mcpName, async () => {
      const client = getClient()
      if (!client) throw new Error('Runtime not started')

      log('mcp', `Triggering OAuth for ${mcpName}`)
      try {
        await authenticateMcpThroughRuntime(client, mcpName)
        log('mcp', `OAuth complete for ${mcpName}`)
        return true
      } catch (err) {
        context.logHandlerError(`mcp:auth ${mcpName}`, err)
        return false
      }
    })
  })

  registerIpcInvoke(context, 'mcp:connect', stringArg('MCP name'), async (_event, name) => {
    return runMcpTransitionForName(name, async () => {
      const client = getClient()
      if (!client) throw new Error('Runtime not started')
      try {
        await client.mcp.connect({ name })
        log('mcp', `Connected: ${name}`)
        invalidateRuntimeCapabilityCaches()
        return true
      } catch (err) {
        context.logHandlerError(`mcp:connect ${name}`, err)
        return false
      }
    })
  })

  registerIpcInvoke(context, 'mcp:disconnect', stringArg('MCP name'), async (_event, name) => {
    return runMcpTransitionForName(name, async () => {
      const client = getClient()
      if (!client) throw new Error('Runtime not started')
      try {
        await client.mcp.disconnect({ name })
        log('mcp', `Disconnected: ${name}`)
        invalidateRuntimeCapabilityCaches()
        return true
      } catch (err) {
        context.logHandlerError(`mcp:disconnect ${name}`, err)
        return false
      }
    })
  })

  registerIpcInvoke(context, 'mcp:preflight', stringArg('MCP name'), async (_event, name) => {
    const result = await preflightConfiguredApiTokenMcp(name, {
      listToolsFromMcpEntry: context.listToolsFromMcpEntry,
    })
    log('mcp', `Preflight ${name}: ${result.status}${result.httpStatus ? ` http=${result.httpStatus}` : ''} ${result.message}`)
    return result
  })

  context.ipcMain.handle('app:builtin-agents', async () => {
    return listBuiltInAgentDetails()
  })

  registerIpcInvoke(context, 'agents:catalog', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return timeAgentCatalogHandler('agents:catalog', () => getCloudAgentCatalog(context, _event, workspaceId))
    }
    return timeAgentCatalogHandler('agents:catalog', () =>
      getCustomAgentCatalog(resolveContext(context, options)))
  })

  registerIpcInvoke(context, 'agents:list', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return timeAgentCatalogHandler('agents:list', async () =>
        (await context.workspaceGateway.listCloudCustomAgents(_event, workspaceId)).map(cloudAgentSummary))
    }
    return timeAgentCatalogHandler('agents:list', () =>
      getCustomAgentSummaries(resolveContext(context, options)))
  })

  // Ask the SDK what agents are actually registered at runtime. Surfaces
  // anything OpenCode knows about — Cowork built-ins, user customs, plus
  // any agent a downstream distribution injected via the `Config.agent`
  // slot that didn't flow through Cowork's config pipeline.
  context.ipcMain.handle('agents:runtime', async (): Promise<RuntimeAgentDescriptor[]> => {
    return timeAgentCatalogHandler('agents:runtime', async () => {
      const directory = getRuntimeHomeDir()
      const client = getClientForDirectory(directory)
      if (!client) return []
      try {
        const response = await client.v2.agent.list({
          location: { directory },
        }, { throwOnError: true })
        const agents = response.data.data
        return agents
          .filter((agent) => agent.id)
          .map((agent): RuntimeAgentDescriptor => {
            const toolIds = runtimeAgentToolIds(agent)
            return {
              name: agent.id,
              mode: agent.mode,
              description: agent.description || null,
              model: agent.model ? `${agent.model.providerID}/${agent.model.id}` : null,
              color: agent.color || null,
              // SDK's Agent type has no `disable` flag — runtime agents are by
              // definition the registered/enabled set.
              disabled: false,
              toolIds,
              toolCount: toolIds.length,
              writeAccess: runtimeAgentCanWrite(agent),
              steps: runtimeAgentSteps(agent),
            }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
      } catch (err) {
        context.logHandlerError('agents:runtime', err)
        return []
      }
    })
  })

  registerIpcInvoke(context, 'agents:create', objectArg<CustomAgentConfig>('custom agent', validateCustomAgentConfig), async (_event, agent) => {
    const normalized = normalizeCustomAgent(agent)
    const workspaceId = readWorkspaceIdOption(agent)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const portable = assertCloudAgentIsPortable(normalized)
      const catalog = await getCloudAgentCatalog(context, _event, workspaceId)
      const siblingNames = (await context.workspaceGateway.listCloudCustomAgents(_event, workspaceId)).map((entry) => normalizeCustomAgent(entry).name)
      const issues = validateCustomAgent(agent, catalog, siblingNames)
      if (issues.length > 0) throw new Error(issues[0]?.message || 'Invalid custom agent')
      return context.workspaceGateway.saveCloudCustomAgent(_event, portable, workspaceId)
    }
    const catalogContext = {
      directory: agent.scope === 'project' ? context.resolveScopedTarget(agent).directory : null,
    }
    const catalog = await getCustomAgentCatalog(catalogContext)
    const siblingNames = listCustomAgents(catalogContext).map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(agent, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    saveCustomAgent(normalized, await context.buildCustomAgentPermission(normalized, catalogContext))
    invalidateCustomAgentCatalogCache()
    log('agent', `Added custom agent: ${normalized.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return true
  })

  registerIpcInvoke(context, 'agents:update', objectAndObjectArgs<ScopedArtifactRef, CustomAgentConfig>('custom agent target', 'custom agent', validateScopedArtifactRef, validateCustomAgentConfig), async (_event, target, agent) => {
    const workspaceId = readWorkspaceIdOption(agent) || readWorkspaceIdOption(target)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const cloudAgents = await context.workspaceGateway.listCloudCustomAgents(_event, workspaceId)
      const existing = cloudAgents
        .map((entry) => normalizeCustomAgent(entry))
        .find((entry) => sameScopedAgent(entry, target))
      const merged = mergeOmittedAgentGuardrails(agent, existing)
      const normalized = normalizeCustomAgent(merged)
      const portable = assertCloudAgentIsPortable(normalized)
      const catalog = await getCloudAgentCatalog(context, _event, workspaceId, target)
      const siblingNames = cloudAgents
        .filter((entry) => !sameScopedAgent(normalizeCustomAgent(entry), target))
        .map((entry) => normalizeCustomAgent(entry).name)
      const issues = validateCustomAgent(merged, catalog, siblingNames)
      if (issues.length > 0) throw new Error(issues[0]?.message || 'Invalid custom agent')
      await context.workspaceGateway.removeCloudCustomAgent(_event, target, workspaceId)
      return context.workspaceGateway.saveCloudCustomAgent(_event, portable, workspaceId)
    }
    const resolvedTarget = context.resolveScopedTarget(target)
    const existing = listCustomAgents({ directory: resolvedTarget.directory })
      .map((entry) => normalizeCustomAgent(entry))
      .find((entry) => sameScopedAgent(entry, resolvedTarget))
    const merged = mergeOmittedAgentGuardrails(agent, existing)
    const normalized = normalizeCustomAgent(merged)
    const catalogContext = {
      directory: normalized.scope === 'project' ? context.resolveScopedTarget(normalized).directory : resolvedTarget.directory,
    }
    const catalog = await getCustomAgentCatalog(catalogContext)
    const siblingNames = listCustomAgents(catalogContext)
      .filter((entry) => !(entry.name === resolvedTarget.name && entry.scope === resolvedTarget.scope && (entry.directory || null) === (resolvedTarget.directory || null)))
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(merged, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    removeCustomAgent(resolvedTarget)
    saveCustomAgent(normalized, await context.buildCustomAgentPermission(normalized, catalogContext))
    invalidateCustomAgentCatalogCache()
    log('agent', `Updated custom agent: ${resolvedTarget.name} -> ${normalized.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return true
  })

  registerIpcInvoke(context, 'agents:remove', objectAndOptionalStringArgs<ScopedArtifactRef>('custom agent target', 'confirmation token', validateScopedArtifactRef), async (_event, target, confirmationToken) => {
    const workspaceId = readWorkspaceIdOption(target)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      if (!context.consumeDestructiveConfirmation({ action: 'agent.remove', target }, confirmationToken)) {
        throw new Error('Confirmation required before deleting an agent.')
      }
      return context.workspaceGateway.removeCloudCustomAgent(_event, target, workspaceId)
    }
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'agent.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before deleting an agent.')
      }
      removeCustomAgent(resolvedTarget)
      invalidateCustomAgentCatalogCache()
      log('agent', `Removed custom agent: ${resolvedTarget.name}`)
      log('audit', `agent.remove completed ${context.describeDestructiveRequest({ action: 'agent.remove', target: resolvedTarget })}`)
      const { rebootRuntime } = await import('../index.ts')
      await rebootRuntime()
      return true
    } catch (err) {
      context.logHandlerError(`agents:remove ${resolvedTarget.name}`, err)
      return false
    }
  })

  registerIpcInvoke(context, 'capabilities:tools', optionalObjectArg<ToolListOptions>('tool list options', validateToolListOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.listCloudCapabilityTools(_event, workspaceId)
    }
    const runtimeTools = await context.listRuntimeTools(options)
    // List view — render just the cards; skip the expensive
    // per-MCP method probe. `deep` defaults to false in shared types
    // and is honored by withDiscoveredBuiltInTools.
    const capabilityContext = {
      sessionId: options?.sessionId,
      directory: context.resolveContextDirectory(options),
      deep: false,
    }
    return context.withDiscoveredBuiltInTools(await listCapabilityTools(capabilityContext), runtimeTools, capabilityContext)
  })

  registerIpcInvoke(context, 'capabilities:tool', stringAndOptionalObjectArgs<ToolListOptions>('tool id', 'tool list options', {}, validateToolListOptions), async (_event, id, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.getCloudCapabilityTool(_event, id, workspaceId)
    }
    const runtimeTools = await context.listRuntimeTools(options)
    // Detail view — user actually opened one tool; spend the time
    // probing its MCP so the method table renders. Scoped to a single
    // tool so we're not paying 16×; `discoverCapabilityToolEntries`
    // also caches per-tool so rapid nav is instant.
    const capabilityContext = {
      sessionId: options?.sessionId,
      directory: context.resolveContextDirectory(options),
      deep: true,
    }
    return (await context.withDiscoveredBuiltInTools(await listCapabilityTools(capabilityContext), runtimeTools, capabilityContext)).find((tool) => tool.id === id)
      || await getCapabilityTool(id, capabilityContext)
  })

  registerIpcInvoke(context, 'capabilities:skills', optionalObjectArg<RuntimeContextOptions>('runtime context options', validateRuntimeContextOptions), async (_event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.listCloudCapabilitySkills(_event, workspaceId)
    }
    return await listCapabilitySkills(resolveContext(context, options))
  })

  registerIpcInvoke(context, 'capabilities:skill-bundle', stringAndOptionalObjectArgs<RuntimeContextOptions>('skill name', 'runtime context options', {}, validateRuntimeContextOptions), async (_event, skillName, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.getCloudCapabilitySkillBundle(_event, skillName, workspaceId)
    }
    return await getCapabilitySkillBundle(skillName, resolveContext(context, options))
  })

  registerIpcInvoke(context, 'capabilities:skill-bundle-file', twoStringsAndOptionalObjectArgs<RuntimeContextOptions>('skill name', 'file path', 'runtime context options', {}, validateRuntimeContextOptions), async (_event, skillName, filePath, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      return context.workspaceGateway.readCloudCapabilitySkillBundleFile(_event, skillName, filePath, workspaceId)
    }
    return await readEffectiveSkillBundleFile(skillName, filePath, resolveContext(context, options))
  })
}
