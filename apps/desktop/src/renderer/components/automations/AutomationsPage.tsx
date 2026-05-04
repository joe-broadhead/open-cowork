import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationListPayload,
  BuiltInAgentDetail,
  CustomAgentSummary,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { AutomationBoard } from './AutomationBoard'
import { AutomationCardDetail } from './AutomationCardDetail'
import { AutomationCreateWizard } from './AutomationCreateWizard'
import { AutomationDropConfirmDialog } from './AutomationDropConfirmDialog'
import { AutomationHelpDrawer } from './AutomationHelpDrawer'
import {
  buildAutomationCardModel,
  resolveAutomationDropAction,
  type AutomationColumnId,
  type AutomationDropAction,
} from './automation-board-support'
import {
  AUTOMATION_TEMPLATES,
  buildAutomationAgentOptions,
  createDefaultDraft,
  draftToPayload,
  type AutomationAgentOption,
  type DraftState,
} from './automations-page-support'

type Props = {
  onOpenThread?: (sessionId: string) => void
}

export function AutomationsPage({ onOpenThread }: Props) {
  const [payload, setPayload] = useState<AutomationListPayload>({ automations: [], inbox: [], workItems: [], runs: [], deliveries: [] })
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const [selectedAutomation, setSelectedAutomation] = useState<AutomationDetail | null>(null)
  const [selectedAgentOptions, setSelectedAgentOptions] = useState<AutomationAgentOption[]>([])
  const [draftDefaults, setDraftDefaults] = useState<DraftState>(() => createDefaultDraft())
  const [wizardDefaults, setWizardDefaults] = useState<DraftState>(() => createDefaultDraft())
  const [wizardOpen, setWizardOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [pendingDropAction, setPendingDropAction] = useState<Extract<AutomationDropAction, { valid: true }> | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedAutomationIdRef = useRef<string | null>(null)

  const loadAgentOptions = useCallback(async (directory: string | null | undefined, selectedNames: string[]) => {
    const context = directory?.trim() ? { directory: directory.trim() } : undefined
    const [builtins, customAgents] = await Promise.all([
      window.coworkApi.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
      window.coworkApi.agents.list(context).catch(() => [] as CustomAgentSummary[]),
    ])
    return buildAutomationAgentOptions({
      builtinAgents: builtins || [],
      customAgents: customAgents || [],
      selectedNames,
    })
  }, [])

  useEffect(() => {
    selectedAutomationIdRef.current = selectedAutomationId
  }, [selectedAutomationId])

  const refresh = useCallback(async (preferredAutomationId?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const nextPayload = await window.coworkApi.automation.list()
      setPayload(nextPayload)
      const candidateId = preferredAutomationId === undefined ? selectedAutomationIdRef.current : preferredAutomationId
      const resolvedId = candidateId && nextPayload.automations.some((automation) => automation.id === candidateId)
        ? candidateId
        : null
      setSelectedAutomationId(resolvedId)
      setSelectedAutomation(resolvedId ? await window.coworkApi.automation.get(resolvedId) : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh(null)
    return window.coworkApi.on.automationUpdated(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    void window.coworkApi.settings.get().then((settings) => {
      if (cancelled) return
      setDraftDefaults(createDefaultDraft({
        autonomyPolicy: settings.defaultAutomationAutonomyPolicy,
        executionMode: settings.defaultAutomationExecutionMode,
      }))
      setWizardDefaults(createDefaultDraft({
        autonomyPolicy: settings.defaultAutomationAutonomyPolicy,
        executionMode: settings.defaultAutomationExecutionMode,
      }))
    }).catch((err) => {
      console.error('Failed to load automation defaults:', err)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!selectedAutomation) {
      setSelectedAgentOptions([])
      return () => {
        cancelled = true
      }
    }
    void loadAgentOptions(selectedAutomation.projectDirectory, selectedAutomation.preferredAgentNames).then((options) => {
      if (!cancelled) setSelectedAgentOptions(options)
    }).catch(() => {
      if (!cancelled) setSelectedAgentOptions([])
    })
    return () => {
      cancelled = true
    }
  }, [selectedAutomation, loadAgentOptions])

  const selectAutomation = async (automationId: string) => {
    setError(null)
    try {
      setSelectedAutomationId(automationId)
      setSelectedAutomation(await window.coworkApi.automation.get(automationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open automation.')
    }
  }

  const selectedInbox = useMemo(() => payload.inbox.filter((item) => item.automationId === selectedAutomationId), [payload.inbox, selectedAutomationId])
  const selectedWorkItems = useMemo(() => payload.workItems.filter((item) => item.automationId === selectedAutomationId), [payload.workItems, selectedAutomationId])
  const selectedRuns = useMemo(() => payload.runs.filter((item) => item.automationId === selectedAutomationId), [payload.runs, selectedAutomationId])
  const selectedDeliveries = useMemo(() => payload.deliveries.filter((item) => item.automationId === selectedAutomationId), [payload.deliveries, selectedAutomationId])

  const executeDropAction = async (action: Extract<AutomationDropAction, { valid: true }>) => {
    setFeedback(null)
    setError(null)
    try {
      if (action.type === 'previewBrief') await window.coworkApi.automation.previewBrief(action.automationId)
      if (action.type === 'approveBrief') await window.coworkApi.automation.approveBrief(action.automationId)
      if (action.type === 'runNow') await window.coworkApi.automation.runNow(action.automationId)
      if (action.type === 'pause') await window.coworkApi.automation.pause(action.automationId)
      if (action.type === 'resume') await window.coworkApi.automation.resume(action.automationId)
      setFeedback(action.message)
      await refresh(action.automationId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to move automation.')
    }
  }

  const handleDropAutomation = (automationId: string, targetColumn: AutomationColumnId) => {
    const automation = payload.automations.find((entry) => entry.id === automationId)
    if (!automation) return
    const action = resolveAutomationDropAction(buildAutomationCardModel(payload, automation), targetColumn)
    if (!action.valid) {
      setFeedback(action.message)
      return
    }
    if (action.confirm) {
      setPendingDropAction(action)
      return
    }
    void executeDropAction(action)
  }

  const createAutomation = async (draft: DraftState) => {
    const created = await window.coworkApi.automation.create(draftToPayload(draft))
    await refresh(created.id)
  }

  const openWizard = (templateId?: string) => {
    const template = templateId ? AUTOMATION_TEMPLATES.find((entry) => entry.id === templateId) : null
    setWizardDefaults(template ? template.apply(draftDefaults) : draftDefaults)
    setWizardOpen(true)
  }

  const patchSelected = async (patch: Partial<AutomationDraft>) => {
    if (!selectedAutomationId) return
    setError(null)
    setFeedback(null)
    try {
      const updated = await window.coworkApi.automation.update(selectedAutomationId, patch)
      await refresh(updated?.id || selectedAutomationId)
      setFeedback('Automation settings saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save automation settings.')
    }
  }

  const runAndRefresh = async (callback: () => Promise<unknown>) => {
    if (!selectedAutomationId) return
    setError(null)
    setFeedback(null)
    try {
      await callback()
      await refresh(selectedAutomationId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Automation action failed.')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{t('automations.label', 'Automations')}</div>
          <h1 className="mt-1 text-[24px] font-semibold text-text">{t('automations.title', 'Always-on work')}</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-6 text-text-secondary">
            See every standing agent program by lifecycle stage. Drag supported cards to trigger existing actions, or open a card for focused details.
          </p>
        </div>
        {loading ? <div className="text-[11px] text-text-muted">{t('common.loading', 'Loading…')}</div> : null}
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-border-subtle px-4 py-3 text-[12px]" style={{ background: 'color-mix(in srgb, var(--color-red) 8%, transparent)', color: 'var(--color-red)' }} role="alert">
          {error}
        </div>
      ) : null}

      <AutomationBoard
        payload={payload}
        selectedAutomationId={selectedAutomationId}
        onSelectAutomation={(automationId) => void selectAutomation(automationId)}
        onDropAutomation={handleDropAutomation}
        onNewAutomation={openWizard}
        onLearnMore={() => setHelpOpen(true)}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        feedback={feedback}
      />

      {wizardOpen ? (
        <AutomationCreateWizard
          defaults={wizardDefaults}
          onClose={() => setWizardOpen(false)}
          onCreate={createAutomation}
          loadAgentOptions={loadAgentOptions}
        />
      ) : null}

      {helpOpen ? <AutomationHelpDrawer onClose={() => setHelpOpen(false)} /> : null}

      {selectedAutomation ? (
        <AutomationCardDetail
          automation={selectedAutomation}
          inbox={selectedInbox}
          workItems={selectedWorkItems}
          runs={selectedRuns}
          deliveries={selectedDeliveries}
          agentOptions={selectedAgentOptions}
          onClose={() => {
            setSelectedAutomationId(null)
            setSelectedAutomation(null)
          }}
          onOpenThread={onOpenThread}
          onPatch={patchSelected}
          onPreviewBrief={() => runAndRefresh(() => window.coworkApi.automation.previewBrief(selectedAutomation.id))}
          onApproveBrief={() => runAndRefresh(() => window.coworkApi.automation.approveBrief(selectedAutomation.id))}
          onRunNow={() => runAndRefresh(() => window.coworkApi.automation.runNow(selectedAutomation.id))}
          onPause={() => runAndRefresh(() => window.coworkApi.automation.pause(selectedAutomation.id))}
          onResume={() => runAndRefresh(() => window.coworkApi.automation.resume(selectedAutomation.id))}
          onArchive={() => runAndRefresh(() => window.coworkApi.automation.archive(selectedAutomation.id))}
          onCancelRun={(runId) => runAndRefresh(() => window.coworkApi.automation.cancelRun(runId))}
          onRetryRun={(runId) => runAndRefresh(() => window.coworkApi.automation.retryRun(runId))}
          onInboxRespond={(itemId, response) => runAndRefresh(() => window.coworkApi.automation.inboxRespond(itemId, response))}
          onInboxDismiss={(itemId) => runAndRefresh(() => window.coworkApi.automation.inboxDismiss(itemId))}
        />
      ) : null}

      {pendingDropAction ? (
        <AutomationDropConfirmDialog
          action={pendingDropAction}
          onCancel={() => setPendingDropAction(null)}
          onConfirm={() => {
            const action = pendingDropAction
            setPendingDropAction(null)
            void executeDropAction(action)
          }}
        />
      ) : null}
    </div>
  )
}
