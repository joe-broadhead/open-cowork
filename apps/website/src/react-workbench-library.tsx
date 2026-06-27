import type { CSSProperties } from 'react'
import type { WorkflowStep } from '@open-cowork/shared'
import { Icon, entityChroma, type IconName } from '@open-cowork/ui'
import {
  cloudWebCapabilityLabel,
  cloudWebCapabilityPolicyNote,
  cloudWebCoworkerInitials,
  cloudWebCoworkerTone,
  cloudWebWorkflowTriggerSummary,
  type CloudWebWorkbenchAgent,
} from './surface-workbench.ts'

type StudioToneStyle = CSSProperties & {
  '--studio-tone'?: string
}

// The card paints an identity plate (`--entity-chroma`) and a hover spine
// (`--spine`) from the same deterministic hue, mirroring the desktop capability
// gallery so a tool/skill reads identically across surfaces.
type CapabilityCardStyle = CSSProperties & {
  '--entity-chroma'?: string
  '--spine'?: string
}

// The playbook card paints the same identity plate (`--entity-chroma`) and
// selection/hover spine (`--spine`) as the capability gallery, so a playbook
// reads identically to a tool/skill across surfaces and matches the desktop card.
type PlaybookCardStyle = CSSProperties & {
  '--entity-chroma'?: string
  '--spine'?: string
}

export type Capability = {
  id?: string
  name?: string
  label?: string
  description?: string
  source?: string
  origin?: string | null
  scope?: string | null
  kind?: string
  namespace?: string | null
  agentNames?: string[]
  toolIds?: string[]
}

export type Workflow = {
  id: string
  title?: string
  status?: string
  instructions?: string
  agentName?: string
  skillNames?: string[]
  toolIds?: string[]
  steps?: WorkflowStep[]
  triggers?: Array<{ type?: string, enabled?: boolean, webhookSecret?: string | null }>
  latestRunId?: string
  latestRunStatus?: string
  latestRunSummary?: string
  latestRunSessionId?: string
  nextRunAt?: string
  lastRunAt?: string
  webhookUrl?: string
}

export type WorkflowRun = {
  id?: string
  workflowId?: string
  title?: string
  status?: string
  sessionId?: string
  triggerType?: string
  createdAt?: string
  summary?: string
  error?: string
}

export type AgentFilter = 'everyone' | 'leads' | 'specialists' | 'custom'
export type CapabilityTab = 'abilities' | 'connections'

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

export function workflowPillKind(status: unknown) {
  const value = String(status || '').toLowerCase()
  if (value === 'active' || value === 'completed' || value === 'running') return 'ok'
  if (value === 'paused' || value === 'pending') return 'warn'
  if (value === 'archived' || value === 'failed') return 'warn'
  return ''
}

// Status -> pill kind for the playbook card badge, mirroring the desktop
// statusTone (active->ok, running->accent, failed->danger, paused->warn). The
// card wants the richer accent/danger split the shared workflowPillKind flattens.
export function workflowStatusKind(status: unknown) {
  const value = String(status || '').toLowerCase()
  if (value === 'active' || value === 'completed') return 'ok'
  if (value === 'running' || value === 'queued') return 'accent'
  if (value === 'failed') return 'danger'
  if (value === 'paused' || value === 'pending') return 'warn'
  return ''
}

export function formatDate(value: unknown) {
  if (!value) return 'never'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

export function filterAgents(agents: CloudWebWorkbenchAgent[], filter: AgentFilter) {
  if (filter === 'leads') return agents.filter((agent) => agent.mode === 'primary')
  if (filter === 'specialists') return agents.filter((agent) => agent.mode === 'subagent')
  if (filter === 'custom') return agents.filter((agent) => agent.custom)
  return agents
}

function agentModeLabel(agent: CloudWebWorkbenchAgent) {
  return agent.mode === 'primary' ? 'Lead' : 'Specialist'
}

function agentTemperature(agent: CloudWebWorkbenchAgent) {
  return agent.temperature === null ? 'Profile default' : agent.temperature.toFixed(2)
}

function agentSteps(agent: CloudWebWorkbenchAgent) {
  return agent.steps === null ? 'Profile default' : String(agent.steps)
}

function WorkflowSteps({ workflow }: { workflow: Workflow }) {
  const steps = workflow.steps?.length
    ? workflow.steps
    : [{ id: 'step-1', title: 'Run saved instructions', detail: workflow.instructions || null }]
  return (
    <ol className="workflow-step-list" aria-label={`${workflow.title || workflow.id} steps`}>
      {steps.map((step, index) => (
        <li className="workflow-step" key={step.id || index}>
          <span className="workflow-step-index">{index + 1}</span>
          <span>
            <strong>{step.title}</strong>
            {step.detail ? <small>{step.detail}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function AgentDirectory({
  agents,
  filter,
  disabled,
  error,
  onFilter,
  onStart,
}: {
  agents: CloudWebWorkbenchAgent[]
  filter: AgentFilter
  disabled: boolean
  error: string | null
  onFilter: (filter: AgentFilter) => void
  onStart: (agentName: string) => void
}) {
  const visibleAgents = filterAgents(agents, filter)
  const filters: Array<[AgentFilter, string]> = [
    ['everyone', `Everyone · ${agents.length}`],
    ['leads', `Leads · ${filterAgents(agents, 'leads').length}`],
    ['specialists', `Specialists · ${filterAgents(agents, 'specialists').length}`],
    ['custom', `Custom · ${filterAgents(agents, 'custom').length}`],
  ]
  return (
    <>
      <div className="segmented-control" role="tablist" aria-label="Coworker filters">
        {filters.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id ? 'true' : 'false'} onClick={() => onFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {visibleAgents.length
        ? <>{visibleAgents.map((agent) => <AgentCard key={agent.name} agent={agent} disabled={disabled} onStart={onStart} />)}</>
        : <p className="empty">{error || 'No profile-allowed coworkers match this filter.'}</p>}
    </>
  )
}

function AgentCard({ agent, disabled, onStart }: { agent: CloudWebWorkbenchAgent, disabled: boolean, onStart: (agentName: string) => void }) {
  const avatarStyle: StudioToneStyle = {
    '--studio-tone': cloudWebCoworkerTone(agent.name),
  }
  return (
    <div className="agent-card">
      <div className="surface-card-main">
        <div className="surface-card-header">
          <span className="studio-coworker-avatar studio-coworker-avatar--sm" style={avatarStyle} aria-hidden="true">
            {cloudWebCoworkerInitials(agent.name)}
          </span>
          <strong>{agent.displayName}</strong>
          <span className="pill" data-kind={agent.mode === 'primary' ? 'info' : 'ok'}>{agentModeLabel(agent)}</span>
          <span className="pill" data-kind={agent.custom ? 'warn' : ''}>{agent.custom ? 'Custom' : 'Built-in'}</span>
        </div>
        <small>{agent.role}</small>
        <div className="agent-config-spec" aria-label={`${agent.displayName} config`}>
          <span><strong>Brain</strong><em>{agent.modelLabel}</em></span>
          <span><strong>Temperature</strong><em>{agentTemperature(agent)}</em></span>
          <span><strong>Max steps</strong><em>{agentSteps(agent)}</em></span>
        </div>
        <small>{[`${agent.toolCount} connection${agent.toolCount === 1 ? '' : 's'}`, `${agent.skillCount} ${agent.skillCount === 1 ? 'ability' : 'abilities'}`].join(' · ')}</small>
      </div>
      <div className="surface-card-actions">
        <button
          className="primary"
          type="button"
          disabled={disabled}
          title={disabled ? 'Start chat disables when chat or coworker browsing is disabled by this cloud profile.' : ''}
          onClick={() => onStart(agent.name)}
        >
          Start chat
        </button>
      </div>
    </div>
  )
}

export function CapabilityTabs({ tab, abilityCount, connectionCount, onTab }: { tab: CapabilityTab, abilityCount: number, connectionCount: number, onTab: (tab: CapabilityTab) => void }) {
  return (
    <div className="segmented-control" role="tablist" aria-label="Capability library">
      <button type="button" role="tab" aria-selected={tab === 'abilities' ? 'true' : 'false'} onClick={() => onTab('abilities')}>Abilities · {abilityCount}</button>
      <button type="button" role="tab" aria-selected={tab === 'connections' ? 'true' : 'false'} onClick={() => onTab('connections')}>Connections · {connectionCount}</button>
    </div>
  )
}

function capabilityIcon(item: Capability): IconName {
  // Connections (tools / MCPs) read as a wrench plate; abilities (skills) as the
  // sparkles plate, matching the desktop gallery's tool vs standalone-skill tiles.
  return item.kind === 'mcp' || item.kind === 'tool' ? 'wrench' : 'sparkles'
}

function CapabilityCard({ item, index }: { item: Capability, index: number }) {
  const label = cloudWebCapabilityLabel(item)
  const chroma = entityChroma(item.name || item.id || label)
  const cardStyle: CapabilityCardStyle = { '--entity-chroma': chroma, '--spine': chroma }
  const coworkers = list<string>(item.agentNames)
  const tools = list<string>(item.toolIds)
  const meta = [item.kind || 'skill', item.source || item.origin || 'profile', item.scope].filter(Boolean) as string[]
  return (
    <div className="capability-card capability-tile" style={cardStyle} key={item.id || item.name || index}>
      <div className="surface-card-main">
        <div className="capability-tile-head">
          <span className="entity-tile capability-tile-icon" aria-hidden="true">
            <Icon name={capabilityIcon(item)} size={16} />
          </span>
          <div className="capability-tile-headings">
            <div className="surface-card-header">
              <strong>{label}</strong>
              <span className="pill" data-kind={item.source === 'custom' ? 'warn' : 'ok'}>{item.source === 'custom' ? 'custom' : 'allowed'}</span>
            </div>
            <p className="empty">{item.description || cloudWebCapabilityPolicyNote(item)}</p>
          </div>
        </div>
        <div className="capability-tile-readout">
          {meta.map((value, metaIndex) => (
            <span className="capability-tile-readout-item" key={value}>
              {metaIndex > 0 ? <span className="capability-tile-readout-sep" aria-hidden="true">·</span> : null}
              {value}
            </span>
          ))}
        </div>
        {coworkers.length || tools.length ? (
          <div className="capability-tile-rail">
            {coworkers.length ? <small>coworkers: {coworkers.join(', ')}</small> : null}
            {tools.length ? <small>tools: {tools.join(', ')}</small> : null}
          </div>
        ) : null}
        <small>{cloudWebCapabilityPolicyNote(item)}</small>
      </div>
    </div>
  )
}

export function CapabilityRows({ items, emptyText }: { items: Capability[], emptyText: string }) {
  if (!items.length) return <p className="empty">{emptyText}</p>
  return (
    <div className="capability-gallery">
      {items.map((item, index) => (
        <CapabilityCard key={item.id || item.name || index} item={item} index={index} />
      ))}
    </div>
  )
}

// Trigger label for the card meta line — mirrors the desktop triggerLabel/
// cloudWebWorkflowTriggerSummary (enabled trigger types, falling back to manual).
function workflowTriggerLabel(workflow: Workflow) {
  return cloudWebWorkflowTriggerSummary(workflow)
}

// Last-run label for the card meta line — mirrors the desktop
// workflowLastRunLabel (formatted last-run date, else latest run status, else
// "never").
function workflowLastRunLabel(workflow: Workflow) {
  if (workflow.lastRunAt) return formatDate(workflow.lastRunAt)
  if (workflow.latestRunStatus) return workflow.latestRunStatus
  return 'never'
}

function workflowNextRunLabel(workflow: Workflow) {
  return workflow.nextRunAt ? formatDate(workflow.nextRunAt) : 'Not scheduled'
}

// One playbook card: an identity-tinted plate, a title + status badge, an
// instrument-readout meta line (trigger · last run · next run), and the saved
// step list — the cloud mirror of the desktop WorkflowsPage card.
function WorkflowCard({ workflow, selected, onSelect }: { workflow: Workflow, selected: boolean, onSelect: (workflowId: string) => void }) {
  const chroma = entityChroma(workflow.id || workflow.title || 'playbook')
  const cardStyle: PlaybookCardStyle = { '--entity-chroma': chroma, '--spine': chroma }
  const meta: Array<[string, string]> = [
    ['trigger', workflowTriggerLabel(workflow)],
    ['last run', workflowLastRunLabel(workflow)],
    ['next run', workflowNextRunLabel(workflow)],
  ]
  return (
    <div className="playbook-card" style={cardStyle} data-selected={selected ? 'true' : 'false'} role="row">
      <div className="playbook-card-head">
        <span className="entity-tile playbook-card-icon" aria-hidden="true">
          <Icon name="workflow" size={16} />
        </span>
        <div className="playbook-card-headings">
          <button type="button" className="playbook-card-title" aria-pressed={selected ? 'true' : 'false'} onClick={() => onSelect(workflow.id)}>
            <strong>{workflow.title || workflow.id}</strong>
            <span className="pill" data-kind={workflowStatusKind(workflow.status)}>{workflow.status || 'unknown'}</span>
          </button>
          <div className="playbook-card-meta">
            <span className="playbook-card-meta-item">Runs as {workflow.agentName || 'build'}</span>
            {meta.map(([label, value]) => (
              <span className="playbook-card-meta-item" key={label}>
                <span className="playbook-card-meta-sep" aria-hidden="true">·</span>
                {label} {value}
              </span>
            ))}
          </div>
        </div>
      </div>
      <WorkflowSteps workflow={workflow} />
    </div>
  )
}

export function WorkflowTable({ workflows, selectedWorkflowId, onSelect }: { workflows: Workflow[], selectedWorkflowId: string | null, onSelect: (workflowId: string) => void }) {
  if (!workflows.length) {
    return <div className="table-row empty-row" role="row"><span role="cell">No playbooks loaded.</span><span role="cell">-</span><span role="cell">-</span><span role="cell">-</span></div>
  }
  return (
    <div className="playbook-grid">
      {workflows.map((workflow) => (
        <WorkflowCard key={workflow.id} workflow={workflow} selected={selectedWorkflowId === workflow.id} onSelect={onSelect} />
      ))}
    </div>
  )
}

function activeWebhookSecret(workflow: Workflow): string | null {
  return workflow.triggers?.find((trigger) => (
    trigger.enabled !== false
    && trigger.type === 'webhook'
    && typeof trigger.webhookSecret === 'string'
    && trigger.webhookSecret.length > 0
  ))?.webhookSecret || null
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// The runnable webhook invocation. Mirrors the desktop WorkflowsPage helper: the
// secret lives ONLY in the copied curl (never shown on screen), and falls back
// to the bare URL when no secret is present.
function webhookCurlCommand(workflow: Workflow): string | null {
  if (!workflow.webhookUrl) return null
  const secret = activeWebhookSecret(workflow)
  if (!secret) return workflow.webhookUrl
  return [
    `curl -X POST ${shellSingleQuote(workflow.webhookUrl)}`,
    `  -H ${shellSingleQuote('content-type: application/json')}`,
    `  -H ${shellSingleQuote(`Authorization: Bearer ${secret}`)}`,
    `  --data ${shellSingleQuote('{"source":"manual"}')}`,
  ].join(' \\\n')
}

function copyWebhookCurl(workflow: Workflow) {
  const command = webhookCurlCommand(workflow)
  if (command && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(command)
  }
}

export function WorkflowDetail({ workflow, runs, disabled, onRun, onPause, onResume, onArchive, onOpenThread }: {
  workflow: Workflow | null
  runs: WorkflowRun[]
  disabled: boolean
  onRun: (workflow: Workflow) => void
  onPause: (workflow: Workflow) => void
  onResume: (workflow: Workflow) => void
  onArchive: (workflow: Workflow) => void
  onOpenThread: (sessionId: string) => void
}) {
  const reason = 'Playbook controls disable when workflows are disabled by this cloud profile or the playbook is archived.'
  if (!workflow) return <p className="empty">Select or create a playbook.</p>
  return (
    <>
      <span className="pill" data-kind={workflowPillKind(workflow.status)}>{workflow.status || 'unknown'}</span>
      <span className="pill">trigger: {cloudWebWorkflowTriggerSummary(workflow)}</span>
      <p className="empty">Runs as {workflow.agentName || 'build'} · last run {formatDate(workflow.lastRunAt)}</p>
      <WorkflowSteps workflow={workflow} />
      {workflow.latestRunStatus || workflow.latestRunSummary || workflow.latestRunSessionId ? (
        <div className="row compact">
          <div><strong>Latest run</strong><br /><small>{[workflow.latestRunStatus || 'unknown', workflow.latestRunSummary, workflow.latestRunSessionId ? `chat ${workflow.latestRunSessionId}` : null].filter(Boolean).join(' · ')}</small></div>
          {workflow.latestRunSessionId ? <div className="row-actions"><button type="button" onClick={() => onOpenThread(workflow.latestRunSessionId as string)}>Open run chat</button></div> : null}
        </div>
      ) : null}
      {workflow.webhookUrl ? (
        <div className="row compact">
          <div>
            <strong>Webhook</strong><br />
            <code className="webhook-url">{workflow.webhookUrl}</code>
          </div>
          <div className="row-actions">
            <button type="button" onClick={() => copyWebhookCurl(workflow)}>Copy curl</button>
          </div>
        </div>
      ) : null}
      <p className="empty">{workflow.instructions || 'No instructions.'}</p>
      <details className="runtime-detail">
        <summary>Playbook metadata</summary>
        <pre>{JSON.stringify({ id: workflow.id, agentName: workflow.agentName, skillNames: workflow.skillNames, toolIds: workflow.toolIds, steps: workflow.steps, latestRunId: workflow.latestRunId, latestRunStatus: workflow.latestRunStatus, latestRunSummary: workflow.latestRunSummary, nextRunAt: workflow.nextRunAt, lastRunAt: workflow.lastRunAt }, null, 2)}</pre>
      </details>
      <div className="row-actions">
        <button className="primary" type="button" disabled={disabled || workflow.status === 'archived'} title={disabled ? reason : ''} onClick={() => onRun(workflow)}>Run now</button>
        {workflow.status === 'paused'
          ? <button type="button" disabled={disabled} title={disabled ? reason : ''} onClick={() => onResume(workflow)}>Resume</button>
          : <button type="button" disabled={disabled || workflow.status === 'archived'} title={disabled ? reason : ''} onClick={() => onPause(workflow)}>Pause</button>}
        <button className="danger" type="button" disabled={disabled || workflow.status === 'archived'} title={disabled ? reason : ''} onClick={() => onArchive(workflow)}>Archive</button>
      </div>
      <h3>Runs</h3>
      {runs.length ? runs.slice(0, 12).map((run) => (
        <div className="row compact" key={run.id || `${run.workflowId}-${run.createdAt}`}>
          <div><strong>{run.title || run.id}</strong><br /><small>{[run.triggerType || 'manual', formatDate(run.createdAt), run.summary || run.error].filter(Boolean).join(' · ')}</small></div>
          <div className="row-actions"><span className="pill" data-kind={workflowPillKind(run.status)}>{run.status || 'unknown'}</span>{run.sessionId ? <button type="button" onClick={() => onOpenThread(run.sessionId as string)}>Open chat</button> : null}</div>
        </div>
      )) : <p className="empty">No runs recorded.</p>}
    </>
  )
}
