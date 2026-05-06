import type {
  CapabilityTool,
  CapabilityToolEntry,
  CustomAgentConfig,
  RuntimeContextOptions,
} from '@open-cowork/shared'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { getEffectiveSettings } from './settings.ts'
import { getCustomAgentCatalog } from './custom-agents.ts'
import { listBuiltInAgentDetails } from './agent-config.ts'
import { humanizeToolId, isVisibleRuntimeToolId, runtimeToolId } from './runtime-tools.ts'
import { validateCustomMcpStdioCommand } from './mcp-stdio-policy.ts'
import { listCustomMcps } from './native-customizations.ts'
import {
  resolveConfiguredMcpRuntimeEntry,
  resolveCustomMcpRuntimeEntryForRuntime,
  type ResolvedRuntimeMcpEntry,
} from './runtime-mcp.ts'

type CapabilityToolDiscoveryDeps = {
  resolveContextDirectory: (options?: RuntimeContextOptions) => string | null
  logHandlerError: (handler: string, err: unknown) => void
  capabilityToolMethodCache: Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>
}

export async function buildCustomAgentPermission(agent: CustomAgentConfig, options?: RuntimeContextOptions) {
  const catalog = await getCustomAgentCatalog(options)
  const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
  const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
  const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))
  const deniedPatterns = Array.from(new Set((agent.deniedToolPatterns || []).map((pattern) => pattern.trim()).filter(Boolean)))

  const permission: Record<string, unknown> = {}
  if ((agent.skillNames || []).length > 0) {
    permission.skill = Object.fromEntries((agent.skillNames || []).map((name) => [name, 'allow']))
  }

  for (const pattern of allowPatterns) permission[pattern] = 'allow'
  for (const pattern of askPatterns) permission[pattern] = 'ask'
  // Specific user-chosen denies land LAST so they shadow the MCP's
  // wildcard allow when the same key is written (e.g. a user denies
  // `mcp__github__*` outright). OpenCode's permission resolver picks
  // the most specific match, so patterns like `mcp__github__delete_repo`
  // coexist with `mcp__github__*: allow` without key collision.
  for (const pattern of deniedPatterns) permission[pattern] = 'deny'
  return permission
}

function capabilityToolPrefixes(tool: CapabilityTool) {
  const prefixes = new Set<string>()

  if (tool.namespace) {
    prefixes.add(`mcp__${tool.namespace}__`)
    prefixes.add(`${tool.namespace}_`)
  }

  prefixes.add(`mcp__${tool.id}__`)
  prefixes.add(`${tool.id}_`)

  return Array.from(prefixes)
}

function runtimeToolMatchesCapability(entry: unknown, tool: CapabilityTool) {
  const id = runtimeToolId(entry)
  if (!id) return false
  if (id === tool.id) return true
  return capabilityToolPrefixes(tool).some((prefix) => id.startsWith(prefix))
}

function isMcpBackedCapability(tool: CapabilityTool) {
  return Boolean(tool.namespace) || tool.patterns.some((pattern) => pattern.startsWith('mcp__'))
}

export async function listToolsFromMcpEntry(entry: unknown) {
  if (!entry) return []

  const runtimeEntry = entry as ResolvedRuntimeMcpEntry
  const client = new McpClient(
    { name: 'open-cowork-capabilities', version: '1.0.0' },
    { capabilities: {} },
  )

  if (runtimeEntry.type === 'local') {
    const [command, ...args] = runtimeEntry.command
    if (!command) return []
    const transport = new StdioClientTransport({
      command,
      args,
      env: runtimeEntry.environment,
      stderr: 'pipe',
    })
    await client.connect(transport)
  } else {
    const transport = new StreamableHTTPClientTransport(new URL(runtimeEntry.url), {
      requestInit: runtimeEntry.headers
        ? { headers: runtimeEntry.headers }
        : undefined,
    })
    await client.connect(transport)
  }

  try {
    const result = await client.listTools()
    return (result.tools || []).map((tool: { name: string; description?: string }) => ({
      id: tool.name,
      description: tool.description?.trim() || 'No description available for this MCP method.',
    }))
  } finally {
    await client.close().catch(() => {})
  }
}

export function isLikelyMcpAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /missing authorization header|invalid_token|unauthorized|forbidden|40[13]|needs_auth|oauth/i.test(message)
}

async function discoverCapabilityToolEntries(
  tool: CapabilityTool,
  options: RuntimeContextOptions | undefined,
  deps: CapabilityToolDiscoveryDeps,
) {
  if (!isMcpBackedCapability(tool)) return tool.availableTools || []

  const cacheKey = `${tool.source}:${tool.id}:${tool.namespace || ''}:${deps.resolveContextDirectory(options) || 'machine'}`
  const cached = deps.capabilityToolMethodCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries
  }

  const settings = getEffectiveSettings()
  const builtinEntry = tool.source === 'builtin'
    ? resolveConfiguredMcpRuntimeEntry(tool.namespace || tool.id, settings)
    : null
  const matchingCustomMcp = tool.source === 'custom'
    ? listCustomMcps(options).find((entry) => entry.name === tool.id || entry.name === tool.namespace) || null
    : null
  const customEntry = matchingCustomMcp
    ? await resolveCustomMcpRuntimeEntryForRuntime(matchingCustomMcp)
    : null

  if (matchingCustomMcp?.type === 'stdio') {
    try {
      validateCustomMcpStdioCommand(matchingCustomMcp)
    } catch (error) {
      deps.logHandlerError(`capability:mcp-tools ${tool.id}`, error)
      return []
    }
  }

  const shouldSkipDirectProbe = Boolean(
    matchingCustomMcp
    && matchingCustomMcp.type === 'http'
    && (!matchingCustomMcp.headers || Object.keys(matchingCustomMcp.headers).length === 0),
  )
  if (shouldSkipDirectProbe) return []

  const entries = await listToolsFromMcpEntry(builtinEntry || customEntry).catch((error) => {
    deps.logHandlerError(`capability:mcp-tools ${tool.id}`, error)
    return []
  })

  // Bound the cache so a long-running session with many projects x tools
  // can't grow the map unbounded. The key space is
  // `source:id:namespace:directory` so collisions across users are rare;
  // when we hit the cap we evict the oldest entry (FIFO is sufficient
  // since all entries share the same 30s TTL).
  const CAPABILITY_CACHE_MAX = 500
  if (deps.capabilityToolMethodCache.size >= CAPABILITY_CACHE_MAX) {
    const oldestKey = deps.capabilityToolMethodCache.keys().next().value
    if (oldestKey !== undefined) deps.capabilityToolMethodCache.delete(oldestKey)
  }
  deps.capabilityToolMethodCache.set(cacheKey, {
    expiresAt: Date.now() + 30_000,
    entries,
  })

  return entries
}

export function createCapabilityToolDiscovery(deps: CapabilityToolDiscoveryDeps) {
  return {
    async withDiscoveredBuiltInTools(
      tools: CapabilityTool[],
      runtimeTools: unknown[],
      options?: RuntimeContextOptions & { deep?: boolean },
    ) {
      const builtInAgentDetails = listBuiltInAgentDetails()
      const nativeToolEntries = new Map<string, CapabilityTool>()

      for (const entry of runtimeTools) {
        const id = runtimeToolId(entry)
        if (!id) continue
        if (!isVisibleRuntimeToolId(id)) continue
        if (id.startsWith('mcp__')) continue
        if (tools.some((tool) => runtimeToolMatchesCapability(entry, tool))) continue

        const agentNames = builtInAgentDetails
          .filter((agent) => agent.nativeToolIds.includes(id))
          .map((agent) => agent.label)

        const description = typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
          ? (entry as { description?: string }).description!.trim()
          : 'Native OpenCode tool available in the current runtime context.'

        nativeToolEntries.set(id, {
          id,
          name: humanizeToolId(id),
          description,
          kind: 'built-in',
          source: 'builtin',
          origin: 'opencode',
          namespace: null,
          patterns: [id],
          availableTools: [
            {
              id,
              description,
            },
          ],
          agentNames,
        })
      }

      const combined = [...tools, ...nativeToolEntries.values()].sort((a, b) => a.name.localeCompare(b.name))

      return Promise.all(combined.map(async (tool) => {
        const runtimeEntries = runtimeTools
          .filter((entry) => runtimeToolMatchesCapability(entry, tool))
          .map((entry) => ({
            id: runtimeToolId(entry),
            description: typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
              ? (entry as { description?: string }).description!.trim()
              : 'No description available for this MCP method.',
          }))
          .filter((entry): entry is CapabilityToolEntry => Boolean(entry.id))

        if (runtimeEntries.length > 0) {
          return { ...tool, availableTools: runtimeEntries }
        }

        if (!isMcpBackedCapability(tool)) {
          return tool
        }

        // `deep` is the opt-in for the expensive per-MCP probe. List
        // views (the Capabilities grid) skip it: the card renders from
        // name + description + icon alone, and probing 16 MCPs on every
        // page open pushes the IPC into 3-5s. Detail views
        // (capabilities.tool(id)) pass deep:true so the method table is
        // populated when the user actually opens one tool.
        if (!options?.deep) return tool

        const fallbackEntries = await discoverCapabilityToolEntries(tool, options, deps)
        if (fallbackEntries.length > 0) {
          return { ...tool, availableTools: fallbackEntries }
        }

        return tool
      }))
    },
  }
}
