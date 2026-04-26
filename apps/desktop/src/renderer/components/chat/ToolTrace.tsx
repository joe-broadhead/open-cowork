import { useState, useEffect } from 'react'
import type { ToolCall } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { MermaidChart } from './MermaidChart'
import { VegaChart } from './VegaChart'
import { attachmentFromArtifact, dispatchComposerCompose } from './composer-events'
import { artifactForTool, listArtifactsForTools, sanitizeArtifactToolInput } from './session-artifacts'
import { AGENT_LABELS, SUB_AGENT_IDS, summarizeTools, tryParseChartOutput } from './tool-trace-utils'

// Cache parsed chart output by ToolCall identity. `tryParseChartOutput`
// returns a fresh object (and a freshly-parsed spec) on every call —
// calling it inline during render hands VegaChart a new spec prop
// identity each pass, which trips its render-chart postMessage effect
// and re-runs Vega in the iframe. With ResizeObserver echoing back, the
// iframe height thrashes and the virtualizer re-measures every row,
// yanking the user's scroll position. Keying on the ToolCall object
// (which the session store keeps stable while the tool is unchanged)
// means we parse once per tool and return the same {spec} reference
// on subsequent renders.
const chartCache = new WeakMap<ToolCall, ReturnType<typeof tryParseChartOutput>>()
function cachedChart(tool: ToolCall) {
  const cached = chartCache.get(tool)
  if (cached !== undefined) return cached
  const parsed = tryParseChartOutput(tool.output)
  chartCache.set(tool, parsed)
  return parsed
}

interface Props {
  tools: ToolCall[]
  compact?: boolean
}

function ArtifactCard({
  artifact,
  attaching,
  exporting,
  onAttach,
  onExport,
  onReveal,
}: {
  artifact: ReturnType<typeof listArtifactsForTools>[number]
  attaching: boolean
  exporting: boolean
  onAttach: () => Promise<void>
  onExport: () => Promise<void>
  onReveal: () => Promise<void>
}) {
  return (
    <div className="mt-1 mb-1 rounded-lg overflow-hidden border border-border-subtle bg-surface px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-muted mb-1">{t('toolTrace.artifact', 'Artifact')}</div>
          <div className="text-[12px] font-medium text-text truncate">{artifact.filename}</div>
          <div className="mt-1 text-[11px] text-text-muted">
            {artifact.taskRunId
              ? t('toolTrace.generatedInSubAgent', 'Generated via {{tool}} in sub-agent work', { tool: artifact.toolName })
              : t('toolTrace.generatedInThread', 'Generated via {{tool}} in this thread', { tool: artifact.toolName })}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={() => void onAttach()}
            className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
          >
            {attaching ? 'Sending…' : 'Send to thread'}
          </button>
          <button
            onClick={() => void onReveal()}
            className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
          >
            {t('toolTrace.reveal', 'Reveal')}
          </button>
          <button
            onClick={() => void onExport()}
            className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
          >
            {exporting ? t('toolTrace.saving', 'Saving...') : t('toolTrace.saveAs', 'Save As…')}
          </button>
        </div>
      </div>
    </div>
  )
}


export function ToolTrace({ tools, compact = false }: Props) {
  const activeAgent = useSessionStore((s) => s.currentView.activeAgent)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const allDone = tools.every((tool) => tool.status === 'complete' || tool.status === 'error')
  const [expanded, setExpanded] = useState(!allDone)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)
  const [exportingArtifactId, setExportingArtifactId] = useState<string | null>(null)
  const [attachingArtifactId, setAttachingArtifactId] = useState<string | null>(null)

  const currentSession = sessions.find((session) => session.id === currentSessionId) || null
  const privateWorkspace = !currentSession?.directory
  const artifacts = privateWorkspace ? listArtifactsForTools(tools) : []

  // Auto-expand while running so user sees progress
  useEffect(() => {
    if (!allDone) setExpanded(true)
  }, [allDone, tools.length])

  const toolAgents = tools.map((tool) => tool.agent).filter(Boolean) as string[]
  const agentName = toolAgents[0] || activeAgent || null

  const agentLabel = agentName ? AGENT_LABELS[agentName] || agentName : null
  const actorTypeLabel = agentName && SUB_AGENT_IDS.has(agentName) ? t('toolTrace.subAgent', 'Sub-Agent') : t('toolTrace.agent', 'Agent')

  const sendArtifactToThread = async (artifact: ReturnType<typeof listArtifactsForTools>[number]) => {
    if (!currentSessionId) return
    try {
      setAttachingArtifactId(artifact.id)
      const payload = await window.coworkApi.artifact.readAttachment({
        sessionId: currentSessionId,
        filePath: artifact.filePath,
      })
      dispatchComposerCompose({
        attachments: [attachmentFromArtifact(payload)],
      })
    } finally {
      setAttachingArtifactId(null)
    }
  }

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {agentLabel && (
          <>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.06em] border"
              style={{
                background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                color: 'var(--color-text-secondary)',
                borderColor: 'var(--color-border)',
              }}
            >
              {actorTypeLabel}
            </span>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              }}
            >
              {agentLabel}
            </span>
          </>
        )}
        <span className="text-[11px] text-text-muted">{summarizeTools(tools)}</span>
      </div>
    )
  }

  return (
    <div className="py-px">
      {/* Summary line with agent badge */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[12px] cursor-pointer group"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {!allDone && (
          <span className="inline-block w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }} />
        )}
        {agentLabel && (
          <>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.06em] border"
              style={{
                background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                color: 'var(--color-text-secondary)',
                borderColor: 'var(--color-border)',
              }}
            >
              {actorTypeLabel}
            </span>
            <span
              className="px-1.5 py-0.5 rounded-md text-[10px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              }}
            >
              {agentLabel}
            </span>
          </>
        )}
        <span className="font-medium group-hover:text-text-secondary transition-colors">
          {summarizeTools(tools)}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"
          style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}
        >
          <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
        </svg>
      </button>

      {/* Charts always visible regardless of expand state */}
      {currentSessionId && artifacts.map((artifact) => (
        <ArtifactCard
          key={`artifact-${artifact.id}`}
          artifact={artifact}
          attaching={attachingArtifactId === artifact.id}
          exporting={exportingArtifactId === artifact.id}
          onAttach={async () => {
            await sendArtifactToThread(artifact)
          }}
          onExport={async () => {
            try {
              setExportingArtifactId(artifact.id)
              await window.coworkApi.artifact.export({
                sessionId: currentSessionId,
                filePath: artifact.filePath,
                suggestedName: artifact.filename,
              })
            } finally {
              setExportingArtifactId(null)
            }
          }}
          onReveal={async () => {
            await window.coworkApi.artifact.reveal({
              sessionId: currentSessionId,
              filePath: artifact.filePath,
            })
          }}
        />
      ))}

      {/* Charts always visible regardless of expand state */}
      {tools.map((tool) => {
        const chart = cachedChart(tool)
        if ((chart?.type === 'vega-lite' || chart?.type === 'vega') && chart.spec) {
          return (
            <div key={`chart-${tool.id}`} className="mt-1 mb-1 rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
              {chart.type === 'vega' && chart.title && (
                <div className="px-4 pt-3 pb-1 text-[12px] font-medium text-text">
                  {chart.title}
                </div>
              )}
              <VegaChart
                spec={chart.spec}
                chartFormat={chart.type}
                chartTitle={chart.title}
                sessionId={currentSessionId}
                toolCallId={tool.id}
                toolName={tool.name}
                taskRunId={null}
              />
            </div>
          )
        }
        if (chart?.type === 'mermaid' && chart.diagram) {
          return (
            <div key={`chart-${tool.id}`} className="mt-1 mb-1 rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
              <MermaidChart diagram={chart.diagram} title={chart.title} />
            </div>
          )
        }
        // Image attachments always visible
        if (tool.attachments?.some(a => a.mime?.startsWith('image/'))) {
          return (
            <div key={`att-${tool.id}`}>
              {tool.attachments.filter(a => a.mime?.startsWith('image/')).map((att, i) => (
                <div key={i} className="mt-1 mb-1">
                  <img src={att.url} alt={att.filename || 'attachment'} className="rounded-lg max-w-full border border-border-subtle" style={{ maxHeight: 400 }} />
                </div>
              ))}
            </div>
          )
        }
        return null
      })}

      {/* Tool list (expandable details) */}
      {expanded && (
        <div className="mt-1.5 ms-0.5 flex flex-col gap-0.5">
          {tools.map((tool) => {
            const statusIcon = tool.status === 'complete' ? '✓'
              : tool.status === 'error' ? '✗' : '…'
            const statusColor = tool.status === 'complete' ? 'var(--color-text-muted)'
              : tool.status === 'error' ? 'var(--color-red)' : 'var(--color-accent)'
            const isToolExpanded = expandedToolId === tool.id
            const artifact = privateWorkspace ? artifactForTool(tool) : null
            const rawInput: Record<string, unknown> = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
              ? tool.input as Record<string, unknown>
              : {}
            const displayInput = sanitizeArtifactToolInput(rawInput, artifact)

            return (
              <div key={tool.id} data-tool-call-id={tool.id}>
                <button
                  onClick={() => setExpandedToolId(isToolExpanded ? null : tool.id)}
                  className="flex items-center gap-1.5 text-[11px] leading-relaxed cursor-pointer hover:text-text-secondary transition-colors w-full text-start"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <span style={{ color: statusColor }}>{statusIcon}</span>
                  <span className="font-mono">{tool.name}</span>
                  {isToolExpanded ? (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3" /></svg>
                  ) : (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="3,2 5.5,4 3,6" /></svg>
                  )}
                </button>

                {isToolExpanded && (
                  <div className="ms-4 mt-1 mb-2 rounded-lg border border-border-subtle bg-surface overflow-hidden">
                    {artifact && currentSessionId && (
                      <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium text-text-muted mb-1">{t('toolTrace.artifact', 'Artifact')}</div>
                          <div className="text-[11px] text-text truncate">{artifact.filename}</div>
                        </div>
                        <button
                          onClick={async (event) => {
                            event.stopPropagation()
                            await sendArtifactToThread(artifact)
                          }}
                          className="shrink-0 px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
                        >
                          {attachingArtifactId === artifact.id ? 'Sending…' : 'Send to thread'}
                        </button>
                        <button
                          onClick={async (event) => {
                            event.stopPropagation()
                            try {
                              setExportingArtifactId(artifact.id)
                              await window.coworkApi.artifact.export({
                                sessionId: currentSessionId,
                                filePath: artifact.filePath,
                                suggestedName: artifact.filename,
                              })
                            } finally {
                              setExportingArtifactId(null)
                            }
                          }}
                          className="shrink-0 px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
                        >
                          {exportingArtifactId === artifact.id ? t('toolTrace.saving', 'Saving...') : t('toolTrace.saveAs', 'Save As…')}
                        </button>
                        <button
                          onClick={async (event) => {
                            event.stopPropagation()
                            await window.coworkApi.artifact.reveal({
                              sessionId: currentSessionId,
                              filePath: artifact.filePath,
                            })
                          }}
                          className="shrink-0 px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
                        >
                          Reveal
                        </button>
                      </div>
                    )}
                    {Object.keys(displayInput).length > 0 && (
                      <div className="px-3 py-2 border-b border-border-subtle">
                        <div className="text-[10px] font-medium text-text-muted mb-1">{t('toolTrace.input', 'Input')}</div>
                        <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                          {JSON.stringify(displayInput, null, 2)}
                        </pre>
                      </div>
                    )}
                    {tool.output != null && !tryParseChartOutput(tool.output) && (
                      <div className="px-3 py-2">
                        <div className="text-[10px] font-medium text-text-muted mb-1">{t('toolTrace.output', 'Output')}</div>
                        <pre className="text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
                          {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
                        </pre>
                      </div>
                    )}
                    {Object.keys(displayInput).length === 0 && tool.output == null && !artifact && (
                      <div className="px-3 py-2 text-[10px] text-text-muted">{t('toolTrace.noDetails', 'No details available')}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
