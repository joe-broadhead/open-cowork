import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationDraft,
  AutomationInboxItem,
  AutomationRun,
  AutomationWorkItem,
} from '@open-cowork/shared'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import {
  AgentTeamSelector,
  dailyRunAttemptCapLabel,
  dailyRunAttemptCapPlaceholder,
  deriveNextAction,
  deriveReliabilityState,
  describeRunPolicy,
  DetailGroup,
  DetailSection,
  formatSchedule,
  formatStatus,
  formatTimestamp,
  latestRunSummary,
  resolveAgentLabels,
  SummaryCard,
  summarizeWorkItems,
  type AutomationAgentOption,
} from './automations-page-support'

type DetailTab = 'now' | 'brief' | 'work' | 'history' | 'settings'

type Props = {
  automation: AutomationDetail
  inbox: AutomationInboxItem[]
  workItems: AutomationWorkItem[]
  runs: AutomationRun[]
  deliveries: AutomationDeliveryRecord[]
  agentOptions: AutomationAgentOption[]
  onClose: () => void
  onOpenThread?: (sessionId: string) => void
  onPatch: (patch: Partial<AutomationDraft>) => Promise<void>
  onPreviewBrief: () => Promise<void>
  onApproveBrief: () => Promise<void>
  onRunNow: () => Promise<void>
  onPause: () => Promise<void>
  onResume: () => Promise<void>
  onArchive: () => Promise<void>
  onCancelRun: (runId: string) => Promise<void>
  onRetryRun: (runId: string) => Promise<void>
  onInboxRespond: (itemId: string, response: string) => Promise<void>
  onInboxDismiss: (itemId: string) => Promise<void>
}

function PanelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  )
}

function tabLabel(tab: DetailTab) {
  if (tab === 'now') return 'Now'
  if (tab === 'brief') return 'Brief'
  if (tab === 'work') return 'Work'
  if (tab === 'history') return 'History'
  return 'Settings'
}

export function AutomationCardDetail({
  automation,
  inbox,
  workItems,
  runs,
  deliveries,
  agentOptions,
  onClose,
  onOpenThread,
  onPatch,
  onPreviewBrief,
  onApproveBrief,
  onRunNow,
  onPause,
  onResume,
  onArchive,
  onCancelRun,
  onRetryRun,
  onInboxRespond,
  onInboxDismiss,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<DetailTab>('now')
  const [edit, setEdit] = useState({
    title: automation.title,
    goal: automation.goal,
    projectDirectory: automation.projectDirectory,
    preferredAgentNames: automation.preferredAgentNames,
    runPolicy: automation.runPolicy,
  })
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useFocusTrap(panelRef, { onEscape: onClose })

  useEffect(() => {
    setEdit({
      title: automation.title,
      goal: automation.goal,
      projectDirectory: automation.projectDirectory,
      preferredAgentNames: automation.preferredAgentNames,
      runPolicy: automation.runPolicy,
    })
  }, [automation.id, automation.title, automation.goal, automation.projectDirectory, automation.preferredAgentNames, automation.runPolicy])

  useEffect(() => {
    setTab('now')
  }, [automation.id])

  const activeRun = useMemo(() => runs.find((run) => run.status === 'queued' || run.status === 'running') || null, [runs])
  const latestRun = runs[0] || null
  const latestDelivery = deliveries[0] || null
  const backlog = useMemo(() => summarizeWorkItems(workItems), [workItems])
  const nextAction = useMemo(() => deriveNextAction({ automation, inbox, activeRun, latestRun, latestDelivery }), [automation, inbox, activeRun, latestRun, latestDelivery])
  const reliability = useMemo(() => deriveReliabilityState({ automation, inbox, activeRun, latestRun }), [automation, inbox, activeRun, latestRun])
  const preferredAgentLabels = useMemo(() => resolveAgentLabels(automation.preferredAgentNames, agentOptions), [automation.preferredAgentNames, agentOptions])
  const isArchived = automation.status === 'archived'
  const hasActiveRun = Boolean(activeRun)
  const canRun = !isArchived && !hasActiveRun && Boolean(automation.brief?.approvedAt)

  const saveEdits = async () => {
    setSaving(true)
    try {
      await onPatch({
        title: edit.title,
        goal: edit.goal,
        projectDirectory: edit.projectDirectory,
        preferredAgentNames: edit.preferredAgentNames,
        runPolicy: edit.runPolicy,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <ModalBackdrop onDismiss={onClose} className="fixed inset-0 z-40 bg-black/30" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-detail-title"
        className="fixed bottom-0 right-0 top-0 z-50 flex w-[760px] max-w-full flex-col border-l border-border-subtle shadow-2xl"
        style={{ background: 'var(--color-base)' }}
      >
        <div className="border-b border-border-subtle px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{automation.kind === 'managed-project' ? 'Managed project' : 'Recurring program'}</div>
              <h2 id="automation-detail-title" className="mt-1 text-[24px] font-semibold text-text">{automation.title}</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-6 text-text-secondary">{automation.goal}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
                <span>{formatStatus(automation.status)}</span>
                <span>{formatSchedule(automation.schedule)}</span>
                <span>{automation.executionMode === 'scoped_execution' ? 'Scoped execution' : 'Planning only'}</span>
                <span>{automation.autonomyPolicy}</span>
                {preferredAgentLabels.length > 0 ? <span>Team {preferredAgentLabels.join(', ')}</span> : null}
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close automation details" className="text-[22px] leading-none text-text-muted hover:text-text cursor-pointer">×</button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {automation.status === 'draft' || !automation.brief ? (
              <button type="button" disabled={hasActiveRun || isArchived} onClick={() => void onPreviewBrief()} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">Preview brief</button>
            ) : null}
            {inbox.some((item) => item.type === 'approval') ? (
              <button type="button" disabled={isArchived} onClick={() => void onApproveBrief()} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>Approve brief</button>
            ) : null}
            {canRun ? (
              <button type="button" onClick={() => void onRunNow()} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>Run now</button>
            ) : null}
            {activeRun ? (
              <button type="button" onClick={() => void onCancelRun(activeRun.id)} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">Cancel run</button>
            ) : null}
            {automation.status === 'paused' ? (
              <button type="button" onClick={() => void onResume()} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">Resume</button>
            ) : (
              <button type="button" disabled={isArchived} onClick={() => void onPause()} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">Pause</button>
            )}
            <button type="button" disabled={hasActiveRun || isArchived} onClick={() => void onArchive()} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">Archive</button>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto border-b border-border-subtle px-5 py-3">
          {(['now', 'brief', 'work', 'history', 'settings'] as DetailTab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setTab(entry)}
              className="rounded-full border px-3 py-1.5 text-[11px] cursor-pointer"
              style={{
                borderColor: tab === entry ? 'var(--color-accent)' : 'var(--color-border)',
                color: tab === entry ? 'var(--color-accent)' : 'var(--color-text-muted)',
              }}
            >
              {tabLabel(entry)}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'now' ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <SummaryCard label="Next step" value={nextAction} detail={activeRun ? `Active run: ${activeRun.title}` : latestRunSummary(latestRun)} accent />
                <SummaryCard label="Reliability" value={reliability.value} detail={reliability.detail} compact />
                <SummaryCard label="Run policy" value={dailyRunAttemptCapLabel(automation.runPolicy.dailyRunCap)} detail={describeRunPolicy(automation, latestRun)} compact />
              </div>
              <DetailSection title="Attention">
                {inbox.length === 0 ? (
                  <div className="text-[12px] text-text-muted">No open inbox items.</div>
                ) : (
                  <div className="space-y-3">
                    {inbox.map((item) => (
                      <div key={item.id} className="rounded-xl border border-border px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[12px] font-medium text-text">{item.title}</div>
                          <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{item.type}</span>
                        </div>
                        <div className="mt-1 whitespace-pre-wrap text-[12px] text-text-secondary">{item.body}</div>
                        {item.questionId ? (
                          <div className="mt-3 flex gap-2">
                            <input
                              value={replies[item.id] || ''}
                              onChange={(event) => setReplies((current) => ({ ...current, [item.id]: event.target.value }))}
                              placeholder="Reply to continue"
                              className="min-w-0 flex-1 rounded-xl border border-border bg-transparent px-3 py-2 text-[12px]"
                            />
                            <button type="button" onClick={() => void onInboxRespond(item.id, replies[item.id] || '')} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
                              Send
                            </button>
                          </div>
                        ) : null}
                        {item.type === 'approval' ? (
                          <button type="button" disabled={isArchived} onClick={() => void onApproveBrief()} className="mt-3 rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>
                            Approve brief
                          </button>
                        ) : null}
                        <button type="button" onClick={() => void onInboxDismiss(item.id)} className="mt-3 text-[11px] text-text-muted underline cursor-pointer">Dismiss</button>
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>
              {latestDelivery ? (
                <DetailSection title="Latest delivery">
                  <div className="text-[12px] font-medium text-text">{latestDelivery.title}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{latestDelivery.provider} · {formatTimestamp(latestDelivery.createdAt)}</div>
                  <div className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-text-secondary">{latestDelivery.body}</div>
                </DetailSection>
              ) : null}
            </div>
          ) : null}

          {tab === 'brief' ? (
            <DetailSection
              title="Execution brief"
              action={automation.latestSessionId && onOpenThread ? (
                <button type="button" onClick={() => onOpenThread(automation.latestSessionId!)} className="text-[11px] text-text-muted underline cursor-pointer">Open linked thread</button>
              ) : undefined}
            >
              {automation.brief ? (
                <div className="space-y-4 text-[12px]">
                  <div className="grid gap-4 md:grid-cols-2">
                    <DetailGroup label="Deliverables" values={automation.brief.deliverables} empty="No deliverables specified yet" />
                    <DetailGroup label="Recommended agents" values={automation.brief.recommendedAgents} empty="Use standard plan/build routing" />
                    <DetailGroup label="Preferred specialists" values={preferredAgentLabels} empty="No preferred specialist team configured" />
                    <DetailGroup label="Assumptions" values={automation.brief.assumptions} />
                    <DetailGroup label="Success criteria" values={automation.brief.successCriteria} />
                    <DetailGroup label="Missing context" values={automation.brief.missingContext} empty="No missing context" />
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Approval boundary</div>
                    <div className="mt-2 text-[12px] leading-6 text-text-secondary">{automation.brief.approvalBoundary}</div>
                  </div>
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">No execution brief yet. Preview the brief to route this through the plan agent.</div>
              )}
            </DetailSection>
          ) : null}

          {tab === 'work' ? (
            <DetailSection title="Work items">
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <SummaryCard label="Total" value={String(backlog.total)} detail="Items in this brief" />
                <SummaryCard label="Completed" value={String(backlog.completed)} detail="Finished work" />
                <SummaryCard label="Ready" value={String(backlog.ready + backlog.running)} detail="Ready or running" />
                <SummaryCard label="Blocked" value={String(backlog.blocked + backlog.failed)} detail="Blocked or failed" />
              </div>
              <div className="space-y-3">
                {workItems.length === 0 ? (
                  <div className="text-[12px] text-text-muted">Work items appear after enrichment.</div>
                ) : workItems.map((item) => (
                  <div key={item.id} className="rounded-xl border border-border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[12px] font-medium text-text">{item.title}</div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{item.status}</span>
                    </div>
                    <div className="mt-1 text-[12px] leading-6 text-text-secondary">{item.description}</div>
                    <div className="mt-2 text-[11px] text-text-muted">
                      {item.ownerAgent ? `Owner: ${item.ownerAgent}` : 'Owner decided at runtime'}
                      {item.dependsOn.length > 0 ? ` · depends on ${item.dependsOn.join(', ')}` : ''}
                      {item.blockingReason ? ` · ${item.blockingReason}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </DetailSection>
          ) : null}

          {tab === 'history' ? (
            <DetailSection title="Run timeline">
              <div className="space-y-3">
                {runs.length === 0 ? (
                  <div className="text-[12px] text-text-muted">No runs yet.</div>
                ) : runs.map((run) => (
                  <div key={run.id} className="rounded-xl border border-border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[12px] font-medium text-text">{run.title}</div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{run.status}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">{formatTimestamp(run.createdAt)} · attempt {run.attempt}{run.nextRetryAt ? ` · retrying ${formatTimestamp(run.nextRetryAt)}` : ''}</div>
                    {run.summary ? <div className="mt-2 whitespace-pre-wrap text-[12px] text-text-secondary">{run.summary}</div> : null}
                    {run.error ? <div className="mt-2 text-[12px]" style={{ color: 'var(--color-red)' }}>{run.error}</div> : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {run.status === 'running' ? (
                        <button type="button" onClick={() => void onCancelRun(run.id)} className="rounded-xl border border-border px-3 py-2 text-[11px] cursor-pointer">Cancel run</button>
                      ) : null}
                      {run.status === 'failed' || run.status === 'cancelled' ? (
                        <button type="button" disabled={isArchived || hasActiveRun} onClick={() => void onRetryRun(run.id)} className="rounded-xl border border-border px-3 py-2 text-[11px] cursor-pointer disabled:opacity-50">Retry run</button>
                      ) : null}
                      {run.sessionId && onOpenThread ? (
                        <button type="button" onClick={() => onOpenThread(run.sessionId!)} className="rounded-xl border border-border px-3 py-2 text-[11px] cursor-pointer">Open thread</button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </DetailSection>
          ) : null}

          {tab === 'settings' ? (
            <DetailSection title="Quick settings">
              <div className="grid gap-3 md:grid-cols-2">
                <PanelField label="Title">
                  <input value={edit.title} onChange={(event) => setEdit((current) => ({ ...current, title: event.target.value }))} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                </PanelField>
                <PanelField label="Project directory">
                  <div className="flex gap-2">
                    <input value={edit.projectDirectory || ''} readOnly className="min-w-0 flex-1 rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder="Optional project directory" />
                    <button type="button" onClick={async () => {
                      const selected = await window.coworkApi.dialog.selectDirectory()
                      if (selected) setEdit((current) => ({ ...current, projectDirectory: selected }))
                    }} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">Browse</button>
                    {edit.projectDirectory ? (
                      <button type="button" onClick={() => setEdit((current) => ({ ...current, projectDirectory: null }))} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer">Clear</button>
                    ) : null}
                  </div>
                </PanelField>
                <PanelField label="Goal">
                  <textarea value={edit.goal} onChange={(event) => setEdit((current) => ({ ...current, goal: event.target.value }))} rows={5} className="w-full resize-y rounded-xl border border-border bg-transparent px-3 py-2 text-[13px] md:col-span-2" />
                </PanelField>
                <PanelField label="Daily run cap">
                  <input type="number" min={1} value={edit.runPolicy.dailyRunCap} onChange={(event) => setEdit((current) => ({
                    ...current,
                    runPolicy: { ...current.runPolicy, dailyRunCap: Math.max(1, Number.parseInt(event.target.value, 10) || 1) },
                  }))} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" placeholder={dailyRunAttemptCapPlaceholder()} />
                </PanelField>
                <PanelField label="Max run duration minutes">
                  <input type="number" min={1} value={edit.runPolicy.maxRunDurationMinutes} onChange={(event) => setEdit((current) => ({
                    ...current,
                    runPolicy: { ...current.runPolicy, maxRunDurationMinutes: Math.max(1, Number.parseInt(event.target.value, 10) || 1) },
                  }))} className="w-full rounded-xl border border-border bg-transparent px-3 py-2 text-[13px]" />
                </PanelField>
              </div>
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Preferred specialists</div>
                <div className="mt-2">
                  <AgentTeamSelector options={agentOptions} value={edit.preferredAgentNames} onChange={(preferredAgentNames) => setEdit((current) => ({ ...current, preferredAgentNames }))} />
                </div>
              </div>
              <button type="button" onClick={() => void saveEdits()} disabled={saving} className="mt-4 rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50">
                {saving ? 'Saving…' : 'Save edits'}
              </button>
            </DetailSection>
          ) : null}
        </div>
      </aside>
    </>
  )
}
