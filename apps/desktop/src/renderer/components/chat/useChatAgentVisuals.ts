import { useEffect, useState } from 'react'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { buildAgentVisualMap } from './agent-visuals'

export function useChatAgentVisuals(currentDirectory: string | null | undefined) {
  const [agentVisuals, setAgentVisuals] = useState<Record<string, { avatar: string | null; color: string | null }>>({})

  useEffect(() => {
    let cancelled = false
    const context = currentDirectory ? { directory: currentDirectory } : undefined

    const loadAgentVisuals = () => {
      void Promise.all([
        window.coworkApi.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
        window.coworkApi.agents.list(context).catch(() => [] as CustomAgentSummary[]),
        window.coworkApi.agents.runtime().catch(() => [] as RuntimeAgentDescriptor[]),
      ]).then(([builtinAgents, customAgents, runtimeAgents]) => {
        if (cancelled) return
        setAgentVisuals(buildAgentVisualMap({
          builtinAgents,
          customAgents,
          runtimeAgents,
        }))
      })
    }

    loadAgentVisuals()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadAgentVisuals())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [currentDirectory])

  return agentVisuals
}
