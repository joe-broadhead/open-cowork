import type { RuntimeContextOptions } from '@open-cowork/shared'
import { getEffectiveSettings } from './settings.js'
import { getClientForDirectory } from './runtime-client-access.js'
import { ensureRuntimeContextDirectory } from './runtime-context.js'
import { getRuntimeHomeDir, resolveProjectDirectory } from './runtime-paths.js'
import { log } from '@open-cowork/shared/node'
import {
  RUNTIME_TOOL_CACHE_TTL_MS,
  currentRuntimeToolCacheGeneration,
  runtimeToolCache,
  runtimeToolInflight,
  setRuntimeToolCacheEntry,
} from './runtime-tool-cache.js'
import { sdkErrorMessage } from './sdk-error.js'
import {
  isVisibleRuntimeToolId,
  runtimeToolId,
} from './runtime-tool-metadata.js'

export {
  humanizeToolId,
  isVisibleRuntimeToolId,
  nativeToolPermissionPatterns,
  nativeToolSupportsWrite,
  runtimeToolId,
} from './runtime-tool-metadata.js'

export type RuntimeToolMetadata = {
  id: string
  description: string
}

type ResolvedRuntimeToolContext = {
  directory: string
  provider: string
  model: string
  logScope?: string
}

export async function listRuntimeToolsForResolvedContext(context: ResolvedRuntimeToolContext) {
  const { directory, provider, model, logScope = 'runtime tool discovery' } = context
  if (!provider || !model) return []

  const cacheKey = `${directory}|${provider}|${model}`
  const now = Date.now()
  const cached = runtimeToolCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.tools
  }

  const inflight = runtimeToolInflight.get(cacheKey)
  if (inflight) return await inflight.promise

  const generation = currentRuntimeToolCacheGeneration()
  const promise = (async () => {
    await ensureRuntimeContextDirectory(directory)

    const client = getClientForDirectory(directory)
    if (!client) return []

    try {
      const result = await client.tool.list({
        directory,
        provider,
        model,
      }, {
        throwOnError: true,
      })
      const tools = (result.data || []).filter((entry) => isVisibleRuntimeToolId(runtimeToolId(entry)))
      if (currentRuntimeToolCacheGeneration() === generation) {
        setRuntimeToolCacheEntry(cacheKey, { expiresAt: Date.now() + RUNTIME_TOOL_CACHE_TTL_MS, tools })
      }
      return tools
    } catch (error) {
      log('error', `${logScope} failed: ${sdkErrorMessage(error)}`)
      return []
    }
  })()
  const inflightEntry = { promise }

  runtimeToolInflight.set(cacheKey, inflightEntry)
  try {
    return await promise
  } finally {
    if (runtimeToolInflight.get(cacheKey) === inflightEntry) {
      runtimeToolInflight.delete(cacheKey)
    }
  }
}

export async function listRuntimeToolsForContext(context?: RuntimeContextOptions) {
  const settings = getEffectiveSettings()
  const provider = settings.effectiveProviderId || ''
  const model = settings.effectiveModel || ''
  const directory = resolveProjectDirectory(context?.directory) || getRuntimeHomeDir()

  return listRuntimeToolsForResolvedContext({
    directory,
    provider,
    model,
    logScope: 'runtime tool discovery',
  })
}

export function toRuntimeToolMetadata(entry: unknown): RuntimeToolMetadata | null {
  const id = runtimeToolId(entry)
  if (!isVisibleRuntimeToolId(id)) return null
  const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
  const description = typeof record?.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : 'Native OpenCode tool available in the current runtime context.'
  return { id, description }
}
