import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CrewDefinitionDraft, CrewDetail, CrewListItem, CrewRunDetail } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  nodeLabelForTrace,
  nodeOperationalDetails,
  summarizeCrewRun,
  tracePayloadType,
  traceToolName,
} from './crew-run-detail-utils'
import { CrewVersionEditor } from './CrewVersionEditor'

const RESEARCH_CREW_MEMBERS = [
  { role: 'lead' as const, agentName: 'plan', displayName: 'Planner', description: 'Decomposes the work and keeps the run scoped.' },
  { role: 'specialist' as const, agentName: 'explore', displayName: 'Explorer', description: 'Finds evidence and maps unknowns.' },
  { role: 'specialist' as const, agentName: 'build', displayName: 'Builder', description: 'Turns evidence into the requested artifact.' },
  { role: 'evaluator' as const, agentName: 'general', displayName: 'Evaluator', description: 'Grades the result before delivery.' },
]

function formatTime(value: string | null) {
  if (!value) return 'Not started'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatMoney(value: number) {
  if (!value) return '$0.00'
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function statusTone(status: string) {
  if (status === 'completed' || status === 'passed' || status === 'allowed' || status === 'approved') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
  if (status === 'failed' || status === 'denied' || status === 'needs_human') return 'border-red-400/30 bg-red-500/10 text-red-100'
  if (status === 'blocked' || status === 'requested' || status === 'needs_revision' || status === 'approval_required') return 'border-amber-400/30 bg-amber-500/10 text-amber-100'
  if (status === 'running' || status === 'evaluating' || status === 'planning') return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100'
  return 'border-border-subtle bg-elevated text-text-secondary'
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-widest ${statusTone(value)}`}>
      {value.replaceAll('_', ' ')}
    </span>
  )
}

function CrewCard({ item, selected, onSelect }: { item: CrewListItem; selected: boolean; onSelect: () => void }) {
  const memberCount = item.activeVersion?.members.length || 0
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-border-subtle bg-surface hover:bg-surface-hover'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-text">{item.definition.name}</div>
          <div className="mt-1 line-clamp-2 text-[12px] text-text-secondary">{item.definition.description}</div>
        </div>
        <span className="rounded border border-border-subtle px-2 py-1 text-[10px] uppercase tracking-widest text-text-muted">
          v{item.activeVersion?.version || 0}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
        <span>{memberCount} members</span>
        <span>{item.latestRun ? `Latest ${item.latestRun.status}` : 'No runs yet'}</span>
      </div>
    </button>
  )
}

function MetricTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-elevated px-3 py-2">
      <div className="text-[17px] font-semibold text-text">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
      {hint ? <div className="mt-1 text-[11px] text-text-muted">{hint}</div> : null}
    </div>
  )
}

function RunOverview({ detail }: { detail: CrewRunDetail }) {
  const summary = summarizeCrewRun(detail)
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MetricTile label="Agents active" value={String(summary.activeAgents)} hint={`${summary.completedNodes} nodes complete`} />
      <MetricTile label="Blockers" value={String(summary.blockedAgents)} hint={summary.pendingApprovals ? `${summary.pendingApprovals} approvals waiting` : 'No pending approvals'} />
      <MetricTile label="Tool calls" value={String(summary.toolCallCount)} hint={`${summary.artifactCount} artifacts`} />
      <MetricTile label="Cost" value={formatMoney(summary.totalCostUsd)} hint={summary.hasTokenUsage ? `${formatNumber(summary.tokenTotal)} tokens` : 'No token events yet'} />
    </div>
  )
}

function AuthorityPanel({ detail }: { detail: CrewRunDetail }) {
  const decisions = detail.policyDecisions
  const version = detail.version
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-text-muted">Authority</div>
          <div className="mt-1 text-[13px] text-text-secondary">Workspace, budget, policy, and root OpenCode session for this run.</div>
        </div>
        <StatusPill value={detail.run.status} />
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Workspace" value={version.workspaceProfileId || 'Default'} hint="Crew workspace profile" />
        <MetricTile label="Budget cap" value={version.budgetCapUsd ? formatMoney(version.budgetCapUsd) : 'None'} hint="Run cost guardrail" />
        <MetricTile label="Policy decisions" value={String(decisions.length)} hint={decisions.length ? decisions.map((decision) => decision.status.replaceAll('_', ' ')).join(', ') : 'No decisions yet'} />
        <MetricTile label="Root session" value={detail.run.rootSessionId ? detail.run.rootSessionId.slice(0, 8) : 'Pending'} hint="OpenCode execution source" />
      </div>
    </div>
  )
}

function BlockerPanel({ detail }: { detail: CrewRunDetail }) {
  const summary = summarizeCrewRun(detail)
  if (summary.blockerLabels.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-surface p-4 text-[13px] text-text-secondary">
        No active blockers. Approval requests, failed nodes, and failed evals will appear here.
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-4">
      <div className="text-[12px] font-semibold uppercase tracking-widest text-amber-100">Needs attention</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {summary.blockerLabels.map((label) => (
          <span key={label} className="rounded-full border border-amber-300/30 px-3 py-1 text-[12px] text-amber-50">{label}</span>
        ))}
      </div>
    </div>
  )
}

function NodeSwimlanes({ detail }: { detail: CrewRunDetail }) {
  const nodes = nodeOperationalDetails(detail)
  return (
    <div className="grid gap-3 xl:grid-cols-3">
      {nodes.map(({ node, events, toolCalls, artifacts, approvals, evaluations }) => (
        <div key={node.id} className="min-h-[154px] rounded-lg border border-border-subtle bg-elevated px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-accent">{node.kind}</div>
          <div className="mt-2 text-[14px] font-semibold text-text">{node.title}</div>
          <div className="mt-1 text-[12px] text-text-secondary">{node.agentName || 'System step'}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusPill value={node.status} />
            {node.sessionId ? <span className="text-[11px] text-text-muted">session {node.sessionId.slice(0, 8)}</span> : null}
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            <MetricTile label="Events" value={String(events.length)} />
            <MetricTile label="Tools" value={String(toolCalls.length)} />
            <MetricTile label="Files" value={String(artifacts.length)} />
            <MetricTile label="Gates" value={String(approvals.length + evaluations.length)} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ToolCallsPanel({ detail }: { detail: CrewRunDetail }) {
  const toolCalls = detail.traceEvents.filter((event) => tracePayloadType(event) === 'crew_run.tool_call')
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Tool calls</div>
      {toolCalls.length === 0 ? <div className="text-[13px] text-text-secondary">No tool calls recorded yet.</div> : null}
      <div className="space-y-2">
        {toolCalls.map((event) => (
          <div key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-elevated px-3 py-2">
            <div>
              <div className="text-[13px] font-semibold text-text">{traceToolName(event)}</div>
              <div className="mt-1 text-[11px] text-text-muted">{nodeLabelForTrace(detail, event)} · {formatTime(event.createdAt)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {event.inputHash ? <span className="text-[10px] text-text-muted">input hashed</span> : null}
              {event.outputHash ? <span className="text-[10px] text-text-muted">output hashed</span> : null}
              <StatusPill value={typeof event.payload?.status === 'string' ? event.payload.status : 'recorded'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ApprovalsArtifactsPanel({ detail }: { detail: CrewRunDetail }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="rounded-lg border border-border-subtle bg-surface p-5">
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Approvals</div>
        {detail.approvals.length === 0 ? <div className="text-[13px] text-text-secondary">No approval gates recorded yet.</div> : null}
        <div className="space-y-2">
          {detail.approvals.map((approval) => (
            <div key={approval.id} className="rounded-md border border-border-subtle bg-elevated px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-text">{approval.title}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{formatTime(approval.requestedAt)}</div>
                </div>
                <StatusPill value={approval.status} />
              </div>
              <div className="mt-2 line-clamp-2 text-[12px] text-text-secondary">{approval.body}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border-subtle bg-surface p-5">
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Artifacts</div>
        {detail.artifacts.length === 0 ? <div className="text-[13px] text-text-secondary">No artifacts recorded yet.</div> : null}
        <div className="space-y-2">
          {detail.artifacts.map((artifact) => (
            <div key={artifact.id} className="rounded-md border border-border-subtle bg-elevated px-3 py-2">
              <div className="text-[13px] font-semibold text-text">{artifact.title}</div>
              <div className="mt-1 text-[11px] text-text-muted">{artifact.mime} · {artifact.hash ? 'hashed' : 'no hash'} · {formatTime(artifact.createdAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function EvaluationPanel({ detail }: { detail: CrewRunDetail }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-widest text-text-muted">Quality gate</div>
          <div className="mt-1 text-[13px] text-text-secondary">Evaluator outcomes and evidence links for this crew run.</div>
        </div>
        <span className="text-[12px] text-text-muted">{summarizeCrewRun(detail).qualityLabel}</span>
      </div>
      {detail.evaluations.length === 0 ? <div className="text-[13px] text-text-secondary">No evaluator result recorded yet.</div> : null}
      <div className="space-y-2">
        {detail.evaluations.map((evaluation) => (
          <div key={evaluation.id} className="rounded-md border border-border-subtle bg-elevated px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-text">{evaluation.evaluatorAgentName}</div>
                <div className="mt-1 text-[11px] text-text-muted">{evaluation.evidenceTraceEventIds.length} evidence events · {formatTime(evaluation.createdAt)}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-text">{Math.round(evaluation.score)}</span>
                <StatusPill value={evaluation.status} />
              </div>
            </div>
            <div className="mt-2 text-[12px] text-text-secondary">Recommendation: {evaluation.recommendation}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TraceTimeline({ detail }: { detail: CrewRunDetail }) {
  return (
    <div className="space-y-2">
      {detail.traceEvents.map((event) => (
        <div key={event.id} className="rounded-md border border-border-subtle bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-semibold text-text">{tracePayloadType(event)}</div>
            <div className="text-[10px] uppercase tracking-widest text-text-muted">#{event.sequence}</div>
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            {nodeLabelForTrace(detail, event)} · {event.actor.kind}:{event.actor.id} · {formatTime(event.createdAt)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-muted">
            {event.inputHash ? <span>input {event.inputHash.slice(0, 18)}...</span> : null}
            {event.outputHash ? <span>output {event.outputHash.slice(0, 18)}...</span> : null}
            {event.tokenUsage ? <span>{formatNumber(event.tokenUsage.input + event.tokenUsage.output + event.tokenUsage.reasoning + event.tokenUsage.cacheRead + event.tokenUsage.cacheWrite)} tokens</span> : null}
            {event.costUsd ? <span>{formatMoney(event.costUsd)}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}

export function CrewsPage() {
  const [crews, setCrews] = useState<CrewListItem[]>([])
  const [selectedCrewId, setSelectedCrewId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CrewDetail | null>(null)
  const [runDetail, setRunDetail] = useState<CrewRunDetail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingCrew, setEditingCrew] = useState(false)

  const selectedCrew = useMemo(
    () => crews.find((item) => item.definition.id === selectedCrewId) || crews[0] || null,
    [crews, selectedCrewId],
  )

  const load = useCallback(async (nextCrewId?: string | null, nextRunId?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const payload = await window.coworkApi.crews.list()
      setCrews(payload.crews)
      const crewId = nextCrewId || selectedCrewId || payload.crews[0]?.definition.id || null
      setSelectedCrewId(crewId)
      if (crewId) {
        const nextDetail = await window.coworkApi.crews.get(crewId)
        setDetail(nextDetail)
        setEditingCrew(false)
        const latestRunId = nextRunId || nextDetail?.runs[0]?.id || null
        setSelectedRunId(latestRunId)
        setRunDetail(latestRunId ? await window.coworkApi.crews.runDetail(latestRunId) : null)
      } else {
        setDetail(null)
        setRunDetail(null)
        setSelectedRunId(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load crews.')
    } finally {
      setLoading(false)
    }
  }, [selectedCrewId])

  useEffect(() => {
    void load()
  }, [load])

  const createResearchCrew = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await window.coworkApi.crews.create({
        name: 'Research Crew',
        description: 'Lead plans the work, two specialists branch out, and an evaluator grades the result.',
        members: RESEARCH_CREW_MEMBERS,
        budgetCapUsd: 4,
      })
      await load(created.definition.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create crew.')
    } finally {
      setBusy(false)
    }
  }

  const startRun = async () => {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      const nextRun = await window.coworkApi.crews.run({
        crewId: detail.definition.id,
        title: 'Research crew demo run',
        workItemTitle: 'Minimum Lovable Crew demo',
        workItemDescription: 'Plan, branch to specialists, join, evaluate, and deliver.',
      })
      setRunDetail(nextRun)
      setSelectedRunId(nextRun.run.id)
      await load(detail.definition.id, nextRun.run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start crew run.')
    } finally {
      setBusy(false)
    }
  }

  const saveCrewVersion = async (draft: CrewDefinitionDraft) => {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      const updated = await window.coworkApi.crews.update(detail.definition.id, draft)
      setEditingCrew(false)
      await load(updated.definition.id, selectedRunId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save crew version.')
    } finally {
      setBusy(false)
    }
  }

  const selectRun = async (runId: string) => {
    setSelectedRunId(runId)
    setError(null)
    try {
      setRunDetail(await window.coworkApi.crews.runDetail(runId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load crew run.')
    }
  }

  const exportTrace = async () => {
    if (!runDetail) return
    setBusy(true)
    setError(null)
    try {
      const content = await window.coworkApi.crews.exportTrace(runDetail.run.id)
      await window.coworkApi.dialog.saveText(`${runDetail.run.title.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-trace.ndjson`, content ? `${content}\n` : '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export crew trace.')
    } finally {
      setBusy(false)
    }
  }

  const evaluateRun = async () => {
    if (!runDetail) return
    setBusy(true)
    setError(null)
    try {
      const evaluated = await window.coworkApi.crews.evaluate(runDetail.run.id)
      setRunDetail(evaluated)
      await load(evaluated.crew.id, evaluated.run.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run crew evaluator.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <header className="border-b border-border-subtle px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">{t('crews.label', 'Crews')}</div>
            <h1 className="mt-1 text-[24px] font-semibold text-text">{t('crews.title', 'Supervised agent teams')}</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6 text-text-secondary">
              {t('crews.subtitle', 'Create the minimum crew shape, preserve versions, dispatch the lead through OpenCode, and inspect the product run graph.')}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={createResearchCrew}
              disabled={busy}
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] font-medium text-text hover:bg-surface-hover disabled:opacity-50"
            >
              {t('crews.createResearchCrew', 'Create Research Crew')}
            </button>
            <button
              type="button"
              onClick={startRun}
              disabled={busy || !detail}
              className="rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-background hover:opacity-90 disabled:opacity-50"
            >
              {t('crews.startRun', 'Start MVP Run')}
            </button>
          </div>
        </div>
        {error ? <div role="alert" className="mt-4 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">{error}</div> : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-border-subtle p-4">
          {loading ? <div className="text-[12px] text-text-muted">Loading crews...</div> : null}
          {!loading && crews.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-subtle p-4 text-[13px] text-text-secondary">
              No crews yet. Create the research crew to seed the first supervised team.
            </div>
          ) : null}
          <div className="space-y-3">
            {crews.map((item) => (
              <CrewCard
                key={item.definition.id}
                item={item}
                selected={selectedCrew?.definition.id === item.definition.id}
                onSelect={() => {
                  setSelectedCrewId(item.definition.id)
                  void load(item.definition.id)
                }}
              />
            ))}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto p-6">
          {!detail ? (
            <div className="rounded-lg border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">
              Select or create a crew to inspect its versioned membership and runs.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-lg border border-border-subtle bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-[18px] font-semibold text-text">{detail.definition.name}</h2>
                    <p className="mt-1 max-w-3xl text-[13px] leading-6 text-text-secondary">{detail.definition.description}</p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-elevated px-3 py-2">
                        <div className="text-[18px] font-semibold text-text">{detail.activeVersion?.members.length || 0}</div>
                        <div className="text-[10px] uppercase tracking-widest text-text-muted">Members</div>
                      </div>
                      <div className="rounded-md bg-elevated px-3 py-2">
                        <div className="text-[18px] font-semibold text-text">{detail.versions.length}</div>
                        <div className="text-[10px] uppercase tracking-widest text-text-muted">Versions</div>
                      </div>
                      <div className="rounded-md bg-elevated px-3 py-2">
                        <div className="text-[18px] font-semibold text-text">{detail.runs.length}</div>
                        <div className="text-[10px] uppercase tracking-widest text-text-muted">Runs</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingCrew(true)}
                      disabled={busy || !detail.activeVersion}
                      className="rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[12px] font-medium text-text hover:bg-surface-hover disabled:opacity-50"
                    >
                      Edit crew
                    </button>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {detail.activeVersion?.members.map((member) => (
                    <span key={member.id} className="rounded-full border border-border-subtle bg-elevated px-3 py-1 text-[12px] text-text-secondary">
                      {member.displayName} · {member.role}
                    </span>
                  ))}
                </div>
              </div>

              {editingCrew ? (
                <CrewVersionEditor
                  key={detail.activeVersion?.id || detail.definition.id}
                  detail={detail}
                  busy={busy}
                  onCancel={() => setEditingCrew(false)}
                  onSave={saveCrewVersion}
                />
              ) : null}

              {runDetail ? (
                <>
                  <div className="rounded-lg border border-border-subtle bg-surface p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-widest text-text-muted">Selected run</div>
                        <h3 className="mt-1 text-[17px] font-semibold text-text">{runDetail.run.title}</h3>
                        <div className="mt-1 text-[12px] text-text-muted">
                          Started {formatTime(runDetail.run.startedAt)} · Finished {formatTime(runDetail.run.finishedAt)}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void evaluateRun()}
                          disabled={busy || runDetail.traceEvents.length === 0 || runDetail.run.status === 'completed'}
                          className="rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[12px] font-medium text-text hover:bg-surface-hover disabled:opacity-50"
                        >
                          Run evaluator
                        </button>
                        <button
                          type="button"
                          onClick={() => void exportTrace()}
                          disabled={busy || runDetail.traceEvents.length === 0}
                          className="rounded-md border border-border-subtle bg-elevated px-3 py-2 text-[12px] font-medium text-text hover:bg-surface-hover disabled:opacity-50"
                        >
                          Export trace
                        </button>
                        <StatusPill value={runDetail.run.status} />
                      </div>
                    </div>
                  </div>
                  <RunOverview detail={runDetail} />
                  <BlockerPanel detail={runDetail} />
                  {detail.runs.length > 1 ? (
                    <div className="rounded-lg border border-border-subtle bg-surface p-4">
                      <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Runs</div>
                      <div className="flex flex-wrap gap-2">
                        {detail.runs.map((run) => (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => void selectRun(run.id)}
                            aria-current={selectedRunId === run.id ? 'true' : undefined}
                            className={`rounded-md border px-3 py-2 text-left text-[12px] ${selectedRunId === run.id ? 'border-accent bg-accent/10 text-text' : 'border-border-subtle bg-elevated text-text-secondary hover:bg-surface-hover'}`}
                          >
                            <div className="font-semibold">{run.title}</div>
                            <div className="mt-1 text-[10px] uppercase tracking-widest text-text-muted">{run.status}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <AuthorityPanel detail={runDetail} />
                  <div className="rounded-lg border border-border-subtle bg-surface p-5">
                    <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Specialist swimlanes</div>
                    <NodeSwimlanes detail={runDetail} />
                  </div>
                  <ToolCallsPanel detail={runDetail} />
                  <ApprovalsArtifactsPanel detail={runDetail} />
                  <EvaluationPanel detail={runDetail} />
                  <div className="rounded-lg border border-border-subtle bg-elevated p-5">
                    <div className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-text-muted">Trace timeline</div>
                    <TraceTimeline detail={runDetail} />
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-border-subtle p-5 text-[13px] text-text-secondary">
                  No runs yet. Start the MVP run to create the branch/join graph, OpenCode lead session, and trace timeline.
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
