import { useState, useEffect } from 'react'
import { DEFAULT_TOOL_TRACE_RULES, type ToolTraceRule } from '@open-cowork/shared'
import type { ToolCall } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { t } from '../../helpers/i18n'
import { TOOL_TRACE_RULES_CHANGED_EVENT } from '../../helpers/tool-trace-events'
import { MermaidChart } from './MermaidChart'
import { VegaChart } from './VegaChart'
import { attachmentFromArtifact, dispatchComposerCompose } from './composer-events'
import { artifactForTool, listArtifactsForTools, sanitizeArtifactToolInput } from './session-artifacts'
import { AGENT_LABELS, SUB_AGENT_IDS, buildCustomMcpToolTraceRules, summarizeTools, tryParseChartOutput } from './tool-trace-utils'
import { Badge, Button, Card, Icon, type BadgeTone } from '../ui'

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

const TOOL_TRACE_RULE_CACHE_MS = 2_000

const toolTraceRulesCache = new Map<string, {
  expiresAt: number
  promise: Promise<ToolTraceRule[]>
}>()

function contextKey(directory?: string | null) {
  return directory || '__machine__'
}

function loadToolTraceRules(directory?: string | null, forceRefresh = false) {
  const key = contextKey(directory)
  if (forceRefresh) toolTraceRulesCache.delete(key)
  const cached = toolTraceRulesCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.promise

  const promise = Promise.all([
    window.coworkApi.app.config(),
    window.coworkApi.custom.listMcps(directory ? { directory } : undefined).catch(() => []),
  ]).then(([config, customMcps]) => {
    const configuredRules = config.toolTrace?.rules?.length ? config.toolTrace.rules : DEFAULT_TOOL_TRACE_RULES
    return [
      ...buildCustomMcpToolTraceRules(customMcps || []),
      ...configuredRules,
    ]
  }).catch(() => DEFAULT_TOOL_TRACE_RULES)
  toolTraceRulesCache.set(key, {
    expiresAt: Date.now() + TOOL_TRACE_RULE_CACHE_MS,
    promise,
  })
  return promise
}

function useToolTraceRules(directory?: string | null) {
  const [rules, setRules] = useState<ToolTraceRule[]>(DEFAULT_TOOL_TRACE_RULES)

  useEffect(() => {
    let cancelled = false
    const refresh = (forceRefresh = false) => {
      loadToolTraceRules(directory, forceRefresh).then((next) => {
        if (!cancelled) setRules(next)
      })
    }
    const handleRulesChanged = () => refresh(true)

    refresh()
    window.addEventListener(TOOL_TRACE_RULES_CHANGED_EVENT, handleRulesChanged)
    return () => {
      cancelled = true
      window.removeEventListener(TOOL_TRACE_RULES_CHANGED_EVENT, handleRulesChanged)
    }
  }, [directory])

  return rules
}

type ToolAttachment = NonNullable<ToolCall['attachments']>[number]

function keyFragment(value: string) {
  return `${value.length}:${value.slice(0, 48)}:${value.slice(-48)}`
}

function toolAttachmentKey(attachment: ToolAttachment, seen: Map<string, number>) {
  const base = [
    attachment.filename || 'attachment',
    attachment.mime || 'unknown',
    keyFragment(attachment.url),
  ].join(':')
  const occurrence = seen.get(base) || 0
  seen.set(base, occurrence + 1)
  return occurrence === 0 ? base : `${base}:${occurrence + 1}`
}

function artifactWorkspaceScope(workspaceId?: string) {
  return workspaceId ? { workspaceId } : {}
}

function statusTone(status: ToolCall['status']): BadgeTone {
  if (status === 'complete') return 'success'
  if (status === 'error') return 'danger'
  return 'accent'
}

function statusLabel(status: ToolCall['status']) {
  if (status === 'complete') return t('toolTrace.statusComplete', 'Complete')
  if (status === 'error') return t('toolTrace.statusError', 'Error')
  return t('toolTrace.statusRunning', 'Running')
}

function statusIconClass(status: ToolCall['status']) {
  if (status === 'error') return 'chat-tool-status-icon chat-tool-status-icon--error'
  if (status === 'complete') return 'chat-tool-status-icon'
  return 'chat-tool-status-icon chat-tool-status-icon--running'
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
    <Card className="mt-1 mb-1 overflow-hidden" padding="sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge tone="neutral" className="mb-1">{t('toolTrace.artifact', 'Artifact')}</Badge>
          <div className="text-[12px] font-medium text-text truncate">{artifact.filename}</div>
          <div className="mt-1 text-[11px] text-text-muted">
            {artifact.taskRunId
              ? t('toolTrace.generatedInSubAgent', 'Generated via {{tool}} in sub-agent work', { tool: artifact.toolName })
              : t('toolTrace.generatedInThread', 'Generated via {{tool}} in this thread', { tool: artifact.toolName })}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Button
            onClick={() => void onAttach()}
            size="sm"
            variant="secondary"
            loading={attaching}
          >
            {t('toolTrace.sendToThread', 'Send to thread')}
          </Button>
          <Button
            onClick={() => void onReveal()}
            size="sm"
            variant="ghost"
            leftIcon="external-link"
          >
            {t('toolTrace.reveal', 'Reveal')}
          </Button>
          <Button
            onClick={() => void onExport()}
            size="sm"
            variant="ghost"
            loading={exporting}
          >
            {t('toolTrace.saveAs', 'Save As...')}
          </Button>
        </div>
      </div>
    </Card>
  )
}


export function ToolTrace({ tools, compact = false }: Props) {
  const activeAgent = useSessionStore((s) => s.currentView.activeAgent)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId)
  const sessions = useSessionStore((s) => s.sessions)
  const allDone = tools.every((tool) => tool.status === 'complete' || tool.status === 'error')
  const [expanded, setExpanded] = useState(!allDone)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)
  const [exportingArtifactId, setExportingArtifactId] = useState<string | null>(null)
  const [attachingArtifactId, setAttachingArtifactId] = useState<string | null>(null)

  const currentSession = sessions.find((session) => session.id === currentSessionId) || null
  const toolTraceRules = useToolTraceRules(currentSession?.directory)
  const privateWorkspace = activeWorkspaceId === LOCAL_WORKSPACE_ID && !currentSession?.directory
  const workspaceIdForArtifact = activeWorkspaceId === LOCAL_WORKSPACE_ID ? undefined : activeWorkspaceId
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
        ...artifactWorkspaceScope(workspaceIdForArtifact),
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
            <Badge tone="neutral">
              {actorTypeLabel}
            </Badge>
            <Badge tone="accent">
              {agentLabel}
            </Badge>
          </>
        )}
        <span className="text-[11px] text-text-muted">{summarizeTools(tools, toolTraceRules)}</span>
      </div>
    )
  }

  return (
    <div className="py-px">
      {/* Summary line with agent badge */}
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        size="sm"
        rightIcon={expanded ? 'chevron-down' : 'chevron-right'}
        className="max-w-full justify-start"
      >
        {!allDone && (
          <Icon name="loader-circle" size={16} className="ui-spin text-accent" />
        )}
        {agentLabel && (
          <>
            <Badge tone="neutral">
              {actorTypeLabel}
            </Badge>
            <Badge tone="accent">
              {agentLabel}
            </Badge>
          </>
        )}
        <span className="min-w-0 truncate font-medium text-text-muted">
          {summarizeTools(tools, toolTraceRules)}
        </span>
      </Button>

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
                ...artifactWorkspaceScope(workspaceIdForArtifact),
              })
            } finally {
              setExportingArtifactId(null)
            }
          }}
          onReveal={async () => {
            await window.coworkApi.artifact.reveal({
              sessionId: currentSessionId,
              filePath: artifact.filePath,
              ...artifactWorkspaceScope(workspaceIdForArtifact),
            })
          }}
        />
      ))}

      {/* Charts always visible regardless of expand state */}
      {tools.map((tool) => {
        const chart = cachedChart(tool)
        if ((chart?.type === 'vega-lite' || chart?.type === 'vega') && chart.spec) {
          return (
            <div key={`chart-${tool.id}`} className="chat-tool-chart-frame mt-1 mb-1">
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
            <div key={`chart-${tool.id}`} className="chat-tool-chart-frame mt-1 mb-1">
              <MermaidChart diagram={chart.diagram} title={chart.title} />
            </div>
          )
        }
        // Image attachments always visible
        if (tool.attachments?.some(a => a.mime?.startsWith('image/'))) {
          const imageAttachmentKeys = new Map<string, number>()
          return (
            <div key={`att-${tool.id}`}>
              {tool.attachments.filter(a => a.mime?.startsWith('image/')).map((att) => (
                <div key={toolAttachmentKey(att, imageAttachmentKeys)} className="mt-1 mb-1">
                  <img src={att.url} alt={att.filename || 'attachment'} className="chat-tool-image rounded-lg max-w-full border border-border-subtle" />
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
            const isToolExpanded = expandedToolId === tool.id
            const artifact = privateWorkspace ? artifactForTool(tool) : null
            const rawInput: Record<string, unknown> = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
              ? tool.input as Record<string, unknown>
              : {}
            const displayInput = sanitizeArtifactToolInput(rawInput, artifact)

            return (
              <div key={tool.id} data-tool-call-id={tool.id}>
                <Card
                  interactive
                  onClick={() => setExpandedToolId(isToolExpanded ? null : tool.id)}
                  padding="sm"
                  aria-expanded={isToolExpanded}
                  className="chat-tool-row"
                >
                  <Icon
                    name={tool.status === 'complete' ? 'check' : tool.status === 'error' ? 'circle-x' : 'loader-circle'}
                    size={16}
                    className={`${statusIconClass(tool.status)} ${tool.status !== 'complete' && tool.status !== 'error' ? 'ui-spin' : ''}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{tool.name}</span>
                  <Badge tone={statusTone(tool.status)}>{statusLabel(tool.status)}</Badge>
                  <Icon name={isToolExpanded ? 'chevron-down' : 'chevron-right'} size={16} className="text-text-muted" />
                </Card>

                {isToolExpanded && (
                  <div className="chat-tool-details ms-4 mt-1 mb-2">
                    {artifact && currentSessionId && (
                      <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Badge tone="neutral" className="mb-1">{t('toolTrace.artifact', 'Artifact')}</Badge>
                          <div className="text-[11px] text-text truncate">{artifact.filename}</div>
                        </div>
                        <Button
                          onClick={async (event) => {
                            event.stopPropagation()
                            await sendArtifactToThread(artifact)
                          }}
                          size="sm"
                          variant="secondary"
                          loading={attachingArtifactId === artifact.id}
                        >
                          {t('toolTrace.sendToThread', 'Send to thread')}
                        </Button>
                        <Button
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
                          size="sm"
                          variant="ghost"
                          loading={exportingArtifactId === artifact.id}
                        >
                          {t('toolTrace.saveAs', 'Save As...')}
                        </Button>
                        <Button
                          onClick={async (event) => {
                            event.stopPropagation()
                            await window.coworkApi.artifact.reveal({
                              sessionId: currentSessionId,
                              filePath: artifact.filePath,
                            })
                          }}
                          size="sm"
                          variant="ghost"
                          leftIcon="external-link"
                        >
                          {t('toolTrace.reveal', 'Reveal')}
                        </Button>
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
