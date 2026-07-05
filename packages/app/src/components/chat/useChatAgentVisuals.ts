import { useEffect, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { buildAgentVisualMap } from './agent-visuals'

type AgentVisualMap = Record<string, { avatar: string | null; color: string | null }>

type AgentVisualCacheEntry = {
  value: AgentVisualMap
  promise?: Promise<AgentVisualMap>
}

const agentVisualCache = new Map<string, AgentVisualCacheEntry>()

function scheduleIdle(task: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 750 })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(task, 50)
  return () => window.clearTimeout(handle)
}

function cacheKeyForDirectory(currentDirectory: string | null | undefined) {
  return currentDirectory || ''
}

function loadAgentVisualMap(context: { directory: string } | undefined, cacheKey: string) {
  const cached = agentVisualCache.get(cacheKey)
  if (cached?.promise) return cached.promise

  const promise = Promise.all([
    window.coworkApi.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
    window.coworkApi.agents.list(context).catch(() => [] as CustomAgentSummary[]),
    window.coworkApi.agents.runtime().catch(() => [] as RuntimeAgentDescriptor[]),
  ]).then(([builtinAgents, customAgents, runtimeAgents]) => buildAgentVisualMap({
    builtinAgents,
    customAgents,
    runtimeAgents,
  }))

  agentVisualCache.set(cacheKey, { value: cached?.value || {}, promise })
  return promise.then((value) => {
    agentVisualCache.set(cacheKey, { value })
    return value
  }).catch((error) => {
    if (agentVisualCache.get(cacheKey)?.promise === promise) {
      agentVisualCache.set(cacheKey, { value: cached?.value || {} })
    }
    throw error
  })
}

export function useChatAgentVisuals(currentDirectory: string | null | undefined) {
  const cacheKey = cacheKeyForDirectory(currentDirectory)
  const [agentVisuals, setAgentVisuals] = useState<AgentVisualMap>(() =>
    agentVisualCache.get(cacheKey)?.value || {})

  useEffect(() => {
    let cancelled = false
    let cancelIdle: (() => void) | null = null
    const context = currentDirectory ? { directory: currentDirectory } : undefined
    const nextCacheKey = cacheKeyForDirectory(currentDirectory)
    const cached = agentVisualCache.get(nextCacheKey)?.value
    if (cached) setAgentVisuals(cached)

    const loadAgentVisuals = () => {
      void loadAgentVisualMap(context, nextCacheKey).then((value) => {
        if (cancelled) return
        setAgentVisuals(value)
      }).catch(() => {
        if (!cancelled) setAgentVisuals(agentVisualCache.get(nextCacheKey)?.value || {})
      })
    }

    cancelIdle = scheduleIdle(loadAgentVisuals)
    const unsubscribe = window.coworkApi.on.runtimeReady(() => {
      cancelIdle?.()
      cancelIdle = scheduleIdle(loadAgentVisuals)
    })
    return () => {
      cancelled = true
      cancelIdle?.()
      unsubscribe()
    }
  }, [currentDirectory])

  return agentVisuals
}
