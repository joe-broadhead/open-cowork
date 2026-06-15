import type { CSSProperties } from 'react'
import type { WorkflowStep } from '@open-cowork/shared'
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
  triggers?: Array<{ type?: string, enabled?: boolean }>
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

export function CapabilityRows({ items, emptyText }: { items: Capability[], emptyText: string }) {
  if (!items.length) return <p className="empty">{emptyText}</p>
  return (
    <>
      {items.map((item, index) => (
        <div className="capability-card" key={item.id || item.name || index}>
          <div className="surface-card-main">
            <div className="surface-card-header">
              <strong>{cloudWebCapabilityLabel(item)}</strong>
              <span className="pill" data-kind={item.source === 'custom' ? 'warn' : 'ok'}>{item.source === 'custom' ? 'custom' : 'allowed'}</span>
            </div>
            <p className="empty">{item.description || cloudWebCapabilityPolicyNote(item)}</p>
            <small>{[item.kind || 'skill', item.source || item.origin || 'profile', item.scope, list(item.agentNames).length ? `coworkers: ${list(item.agentNames).join(', ')}` : null, list(item.toolIds).length ? `tools: ${list(item.toolIds).join(', ')}` : null].filter(Boolean).join(' · ')}</small>
            <small>{cloudWebCapabilityPolicyNote(item)}</small>
          </div>
        </div>
      ))}
    </>
  )
}

export function WorkflowTable({ workflows, selectedWorkflowId, onSelect }: { workflows: Workflow[], selectedWorkflowId: string | null, onSelect: (workflowId: string) => void }) {
  if (!workflows.length) {
    return <div className="table-row empty-row" role="row"><span role="cell">No playbooks loaded.</span><span role="cell">-</span><span role="cell">-</span><span role="cell">-</span></div>
  }
  return (
    <>
      {workflows.map((workflow) => (
        <div className="table-row thread-row" data-selected={selectedWorkflowId === workflow.id ? 'true' : 'false'} role="row" key={workflow.id}>
          <span role="cell">
            <button type="button" className="row-link" aria-pressed={selectedWorkflowId === workflow.id ? 'true' : 'false'} onClick={() => onSelect(workflow.id)}>
              {workflow.title || workflow.id}
              <small className="thread-row-meta">Runs as {workflow.agentName || 'build'} · last run {formatDate(workflow.lastRunAt)}</small>
            </button>
          </span>
          <span role="cell"><span className="pill" data-kind={workflowPillKind(workflow.status)}>{workflow.status || 'unknown'}</span></span>
          <span role="cell">{workflow.latestRunStatus || workflow.lastRunAt || 'never'}</span>
          <span role="cell">{workflow.nextRunAt ? formatDate(workflow.nextRunAt) : cloudWebWorkflowTriggerSummary(workflow)}</span>
        </div>
      ))}
    </>
  )
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
