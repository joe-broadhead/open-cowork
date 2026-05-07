import { useCallback, useEffect, useState } from 'react'
import type {
  DashboardSummary,
  DashboardTimeRangeKey,
} from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import { getModelContextLimit } from '../helpers/model-info'
import {
  DASHBOARD_RANGE_STORAGE_KEY,
  EMPTY_DIAGNOSTICS,
  LEGACY_DASHBOARD_RANGE_STORAGE_KEY,
  readStoredRange,
  type DiagnosticsState,
} from './pulse-page-support.tsx'

export function usePulseDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>(EMPTY_DIAGNOSTICS)
  const [dashboardRange, setDashboardRange] = useState<DashboardTimeRangeKey>(readStoredRange)
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null)
  const [dashboardError, setDashboardError] = useState<string | null>(null)

  // Persist filter selection so the user's "All time" pick survives a
  // relaunch. Session-independent; one preference per install.
  useEffect(() => {
    try {
      window.localStorage.setItem(DASHBOARD_RANGE_STORAGE_KEY, dashboardRange)
      window.localStorage.removeItem(LEGACY_DASHBOARD_RANGE_STORAGE_KEY)
    } catch {
      /* Quota / disabled storage — non-fatal, selection just won't persist. */
    }
    // Invalidate any previously-loaded summary so we don't flash a
    // "Last 7 days" total while the new range's fetch is in flight.
    setDashboardSummary(null)
    setDashboardError(null)
  }, [dashboardRange])

  const refreshDiagnostics = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setDiagnostics((current) => ({ ...current, loading: true }))
    }

    const [
      runtimeStatusResult,
      settingsResult,
      modelInfoResult,
      capabilitySkillsResult,
      customMcpsResult,
      customSkillsResult,
      capabilityToolsResult,
      builtinAgentsResult,
      customAgentsResult,
      perfResult,
      dashboardSummaryResult,
      runtimeInputsResult,
    ] = await Promise.allSettled([
      window.coworkApi.runtime.status(),
      window.coworkApi.settings.get(),
      window.coworkApi.model.info(),
      window.coworkApi.capabilities.skills(),
      window.coworkApi.custom.listMcps(),
      window.coworkApi.custom.listSkills(),
      window.coworkApi.capabilities.tools(),
      window.coworkApi.app.builtinAgents(),
      window.coworkApi.agents.list(),
      window.coworkApi.diagnostics.perf(),
      window.coworkApi.app.dashboardSummary(dashboardRange),
      window.coworkApi.app.runtimeInputs(),
    ])

    const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null
    const modelInfo = modelInfoResult.status === 'fulfilled' ? modelInfoResult.value as any : null
    const modelId = settings?.effectiveModel || settings?.selectedModelId || null
    const providerId = settings?.effectiveProviderId || null
    const contextLimit = getModelContextLimit(modelInfo, providerId, modelId)

    setDiagnostics({
      loading: false,
      runtimeReady: runtimeStatusResult.status === 'fulfilled' ? runtimeStatusResult.value.ready : false,
      runtimeModel: {
        providerId,
        modelId,
        contextLimit,
      },
      runtimeInputs: runtimeInputsResult.status === 'fulfilled' ? runtimeInputsResult.value : null,
      skills: capabilitySkillsResult.status === 'fulfilled' ? capabilitySkillsResult.value : [],
      customMcps: customMcpsResult.status === 'fulfilled' ? customMcpsResult.value : [],
      customSkills: customSkillsResult.status === 'fulfilled' ? customSkillsResult.value : [],
      tools: capabilityToolsResult.status === 'fulfilled' ? capabilityToolsResult.value : [],
      builtinAgents: builtinAgentsResult.status === 'fulfilled' ? builtinAgentsResult.value : [],
      customAgents: customAgentsResult.status === 'fulfilled' ? customAgentsResult.value : [],
      perf: perfResult.status === 'fulfilled' ? perfResult.value : null,
      updatedAt: new Date().toISOString(),
    })
    if (dashboardSummaryResult.status === 'fulfilled') {
      setDashboardSummary(dashboardSummaryResult.value)
      setDashboardError(null)
    } else {
      // Surface the failure explicitly so users don't silently see
      // stale totals from the previous range selection.
      const reason = dashboardSummaryResult.reason
      setDashboardError(reason instanceof Error ? reason.message : t('homepage.warning.dashboardLoadFailed', 'Could not load dashboard totals.'))
    }
  }, [dashboardRange])

  useEffect(() => {
    let cancelled = false
    const runRefresh = async (silent = false) => {
      await refreshDiagnostics({ silent })
      if (cancelled) return
    }

    void runRefresh()
    const unsubscribeRuntimeReady = window.coworkApi.on.runtimeReady(() => {
      if (cancelled) return
      void runRefresh(true)
    })

    // Debounced silent refresh triggered by live session events. Coalesce
    // bursts (a single assistant turn fires many patches) into at most one
    // refresh per 800ms so the dashboard stays responsive without
    // hammering the main process on every streamed token.
    let debounceHandle: number | null = null
    const scheduleSilentRefresh = () => {
      if (cancelled) return
      if (debounceHandle !== null) return
      debounceHandle = window.setTimeout(() => {
        debounceHandle = null
        if (!cancelled) void runRefresh(true)
      }, 800)
    }

    const unsubscribeSessionPatch = window.coworkApi.on.sessionPatch(scheduleSilentRefresh)
    const unsubscribeSessionUpdated = window.coworkApi.on.sessionUpdated(scheduleSilentRefresh)
    const unsubscribeSessionDeleted = window.coworkApi.on.sessionDeleted(scheduleSilentRefresh)
    const unsubscribeDashboardUpdated = window.coworkApi.on.dashboardSummaryUpdated(scheduleSilentRefresh)

    const onFocus = () => {
      if (cancelled) return
      void runRefresh(true)
    }
    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      void runRefresh(true)
    }
    const interval = window.setInterval(() => {
      if (cancelled || document.visibilityState !== 'visible') return
      void runRefresh(true)
    }, 15000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      unsubscribeRuntimeReady()
      unsubscribeSessionPatch()
      unsubscribeSessionUpdated()
      unsubscribeSessionDeleted()
      unsubscribeDashboardUpdated()
      if (debounceHandle !== null) window.clearTimeout(debounceHandle)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(interval)
    }
  }, [refreshDiagnostics])

  return {
    diagnostics,
    dashboardRange,
    setDashboardRange,
    dashboardSummary,
    dashboardError,
    refreshDiagnostics,
  }
}
