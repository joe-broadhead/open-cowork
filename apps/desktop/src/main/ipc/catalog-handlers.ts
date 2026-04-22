import type { RuntimeAgentDescriptor, RuntimeContextOptions, ScopedArtifactRef, ToolListOptions, CustomAgentConfig } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { getClient } from '../runtime.ts'
import { invalidateRuntimeToolCache } from '../runtime-tool-cache.ts'
import { listBuiltInAgentDetails } from '../agent-config.ts'
import { getCustomAgentCatalog, getCustomAgentSummaries, normalizeCustomAgent, validateCustomAgent } from '../custom-agents.ts'
import { listCustomAgents, removeCustomAgent, saveCustomAgent } from '../native-customizations.ts'
import { getCapabilitySkillBundle, getCapabilityTool, listCapabilitySkills, listCapabilityTools } from '../capability-catalog.ts'
import { readEffectiveSkillBundleFile } from '../effective-skills.ts'
import { log } from '../logger.ts'

function resolveContext(context: IpcHandlerContext, options?: RuntimeContextOptions) {
  return {
    ...options,
    directory: context.resolveContextDirectory(options),
  }
}

export async function authenticateMcpThroughRuntime(client: {
  mcp: {
    auth: {
      authenticate: (payload: { name: string }) => Promise<unknown>
    }
  }
}, mcpName: string) {
  await client.mcp.auth.authenticate({ name: mcpName })
  invalidateRuntimeToolCache()
  return true
}

export function registerCatalogHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('tool:list', async (_event, options?: ToolListOptions) => {
    return context.listRuntimeTools(options)
  })

  // MCP state transitions (auth / connect / disconnect) all change the
  // set of tools the SDK exposes on its next status probe. Drop the
  // runtime-tool cache so the Capabilities UI doesn't keep rendering
  // the pre-transition tool list for up to 30s — the user clicks
  // "Authenticate" and immediately expects the new tools to show.
  context.ipcMain.handle('mcp:auth', async (_event, mcpName: string) => {
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

  context.ipcMain.handle('mcp:connect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.connect({ name })
      log('mcp', `Connected: ${name}`)
      invalidateRuntimeToolCache()
      return true
    } catch (err) {
      context.logHandlerError(`mcp:connect ${name}`, err)
      return false
    }
  })

  context.ipcMain.handle('mcp:disconnect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.disconnect({ name })
      log('mcp', `Disconnected: ${name}`)
      invalidateRuntimeToolCache()
      return true
    } catch (err) {
      context.logHandlerError(`mcp:disconnect ${name}`, err)
      return false
    }
  })

  context.ipcMain.handle('app:builtin-agents', async () => {
    return listBuiltInAgentDetails()
  })

  context.ipcMain.handle('agents:catalog', async (_event, options?: RuntimeContextOptions) => {
    return await getCustomAgentCatalog(resolveContext(context, options))
  })

  context.ipcMain.handle('agents:list', async (_event, options?: RuntimeContextOptions) => {
    return await getCustomAgentSummaries(resolveContext(context, options))
  })

  // Ask the SDK what agents are actually registered at runtime. Surfaces
  // anything OpenCode knows about — Cowork built-ins, user customs, plus
  // any agent a downstream distribution injected via the `Config.agent`
  // slot that didn't flow through Cowork's config pipeline.
  context.ipcMain.handle('agents:runtime', async (): Promise<RuntimeAgentDescriptor[]> => {
    const client = getClient()
    if (!client) return []
    try {
      const response = await client.app.agents()
      const agents = response.data || []
      return agents
        .filter((agent) => agent.name)
        .map((agent): RuntimeAgentDescriptor => ({
          name: agent.name,
          mode: agent.mode,
          description: agent.description || null,
          model: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : null,
          color: agent.color || null,
          // SDK's Agent type has no `disable` flag — runtime agents are by
          // definition the registered/enabled set.
          disabled: false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      context.logHandlerError('agents:runtime', err)
      return []
    }
  })

  context.ipcMain.handle('agents:create', async (_event, agent: CustomAgentConfig) => {
    const normalized = normalizeCustomAgent(agent)
    const catalogContext = {
      directory: agent.scope === 'project' ? context.resolveScopedTarget(agent).directory : null,
    }
    const catalog = await getCustomAgentCatalog(catalogContext)
    const siblingNames = listCustomAgents(catalogContext).map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    saveCustomAgent(normalized, await context.buildCustomAgentPermission(normalized, catalogContext))
    log('agent', `Added custom agent: ${normalized.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return true
  })

  context.ipcMain.handle('agents:update', async (_event, target: ScopedArtifactRef, agent: CustomAgentConfig) => {
    const normalized = normalizeCustomAgent(agent)
    const resolvedTarget = context.resolveScopedTarget(target)
    const catalogContext = {
      directory: normalized.scope === 'project' ? context.resolveScopedTarget(normalized).directory : resolvedTarget.directory,
    }
    const catalog = await getCustomAgentCatalog(catalogContext)
    const siblingNames = listCustomAgents(catalogContext)
      .filter((entry) => !(entry.name === resolvedTarget.name && entry.scope === resolvedTarget.scope && (entry.directory || null) === (resolvedTarget.directory || null)))
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    removeCustomAgent(resolvedTarget)
    saveCustomAgent(normalized, await context.buildCustomAgentPermission(normalized, catalogContext))
    log('agent', `Updated custom agent: ${resolvedTarget.name} -> ${normalized.name}`)
    const { rebootRuntime } = await import('../index.ts')
    await rebootRuntime()
    return true
  })

  context.ipcMain.handle('agents:remove', async (_event, target: ScopedArtifactRef, confirmationToken?: string | null) => {
    const resolvedTarget = context.resolveScopedTarget(target)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'agent.remove', target: resolvedTarget }, confirmationToken)) {
        throw new Error('Confirmation required before deleting an agent.')
      }
      removeCustomAgent(resolvedTarget)
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

  context.ipcMain.handle('capabilities:tools', async (_event, options?: ToolListOptions) => {
    const runtimeTools = await context.listRuntimeTools(options)
    // List view — render just the cards; skip the expensive
    // per-MCP method probe. `deep` defaults to false in shared types
    // and is honored by withDiscoveredBuiltInTools.
    const capabilityContext = {
      sessionId: options?.sessionId,
      directory: context.resolveContextDirectory(options),
      deep: false,
    }
    return context.withDiscoveredBuiltInTools(listCapabilityTools(capabilityContext), runtimeTools, capabilityContext)
  })

  context.ipcMain.handle('capabilities:tool', async (_event, id: string, options?: ToolListOptions) => {
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
    return (await context.withDiscoveredBuiltInTools(listCapabilityTools(capabilityContext), runtimeTools, capabilityContext)).find((tool) => tool.id === id)
      || getCapabilityTool(id, capabilityContext)
  })

  context.ipcMain.handle('capabilities:skills', async (_event, options?: RuntimeContextOptions) => {
    return await listCapabilitySkills(resolveContext(context, options))
  })

  context.ipcMain.handle('capabilities:skill-bundle', async (_event, skillName: string, options?: RuntimeContextOptions) => {
    return await getCapabilitySkillBundle(skillName, resolveContext(context, options))
  })

  context.ipcMain.handle('capabilities:skill-bundle-file', async (_event, skillName: string, filePath: string, options?: RuntimeContextOptions) => {
    return await readEffectiveSkillBundleFile(skillName, filePath, resolveContext(context, options))
  })
}
