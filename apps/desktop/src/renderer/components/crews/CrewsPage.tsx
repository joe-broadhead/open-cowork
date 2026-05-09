import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CrewDetail, CrewListItem, CrewRunDetail } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

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

function NodeLane({ detail }: { detail: CrewRunDetail }) {
  return (
    <div className="grid gap-2 lg:grid-cols-6">
      {detail.nodes.map((node) => (
        <div key={node.id} className="min-h-[116px] rounded-lg border border-border-subtle bg-elevated px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-accent">{node.kind}</div>
          <div className="mt-2 text-[13px] font-semibold text-text">{node.title}</div>
          <div className="mt-1 text-[12px] text-text-secondary">{node.agentName || 'System step'}</div>
          <div className="mt-3 inline-flex rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted">{node.status}</div>
        </div>
      ))}
    </div>
  )
}

function TraceTimeline({ detail }: { detail: CrewRunDetail }) {
  return (
    <div className="space-y-2">
      {detail.traceEvents.map((event) => (
        <div key={event.id} className="rounded-md border border-border-subtle bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px] font-semibold text-text">{String(event.payload?.type || event.source)}</div>
            <div className="text-[10px] uppercase tracking-widest text-text-muted">#{event.sequence}</div>
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            {event.nodeId ? `Node ${event.nodeId.slice(0, 8)}` : 'Run'} · {formatTime(event.createdAt)}
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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedCrew = useMemo(
    () => crews.find((item) => item.definition.id === selectedCrewId) || crews[0] || null,
    [crews, selectedCrewId],
  )

  const load = useCallback(async (nextCrewId?: string | null) => {
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
        const latestRunId = nextDetail?.runs[0]?.id || null
        setRunDetail(latestRunId ? await window.coworkApi.crews.runDetail(latestRunId) : null)
      } else {
        setDetail(null)
        setRunDetail(null)
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
      await load(detail.definition.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start crew run.')
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
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {detail.activeVersion?.members.map((member) => (
                    <span key={member.id} className="rounded-full border border-border-subtle bg-elevated px-3 py-1 text-[12px] text-text-secondary">
                      {member.displayName} · {member.role}
                    </span>
                  ))}
                </div>
              </div>

              {runDetail ? (
                <>
                  <div className="rounded-lg border border-border-subtle bg-surface p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-widest text-text-muted">Latest run</div>
                        <h3 className="mt-1 text-[17px] font-semibold text-text">{runDetail.run.title}</h3>
                      </div>
                      <span className="rounded border border-border-subtle px-3 py-1 text-[12px] text-text-secondary">{runDetail.run.status}</span>
                    </div>
                    <div className="mt-4">
                      <NodeLane detail={runDetail} />
                    </div>
                  </div>
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
