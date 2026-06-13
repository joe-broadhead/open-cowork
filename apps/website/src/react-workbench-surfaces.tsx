import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { CloudArtifactSurfacePortals } from './react-workbench-artifacts.tsx'
import { CloudChannelSurfacePortals } from './react-workbench-channels.tsx'
import { CloudProjectBoardPortal } from './react-workbench-projects.tsx'
import type { CloudRuntimeActionProps } from './react-workbench.ts'
import { asRecord, errorMessage, setRouteHash } from './react-workbench-controller.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'
import {
  cloudWebCapabilityLabel,
  cloudWebCapabilityPolicyNote,
  cloudWebCoworkerInitials,
  cloudWebCoworkerTone,
  cloudWebWorkflowTriggerSummary,
  deriveCloudWebWorkbenchAgents,
  filterCloudWebCapabilities,
  type CloudWebWorkbenchAgent,
} from './surface-workbench.ts'

type StudioToneStyle = CSSProperties & {
  '--studio-tone'?: string
}

type SurfaceProps = {
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
  selectedView: CloudWebThreadView | null
  onStartAgentChat: (agentName: string) => void
  onSelectSession: (sessionId: string) => Promise<void>
  onReloadSessions: () => Promise<void>
  artifactActions: CloudRuntimeActionProps
}

type Capability = {
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

type Workflow = {
  id: string
  title?: string
  status?: string
  instructions?: string
  agentName?: string
  skillNames?: string[]
  toolIds?: string[]
  triggers?: Array<{ type?: string, enabled?: boolean }>
  latestRunId?: string
  latestRunStatus?: string
  latestRunSummary?: string
  latestRunSessionId?: string
  nextRunAt?: string
  lastRunAt?: string
  webhookUrl?: string
}

type WorkflowRun = {
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

type WorkflowTriggerInput =
  | { id: string, type: 'manual', enabled: true }
  | {
    id: string
    type: 'schedule'
    enabled: true
    schedule: {
      type: 'daily'
      timezone: string
      runAtHour: number
      runAtMinute: number
    }
  }
  | { id: string, type: 'webhook', enabled: true }

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}
function workflowPillKind(status: unknown) {
  const value = String(status || '').toLowerCase()
  if (value === 'active' || value === 'completed' || value === 'running') return 'ok'
  if (value === 'paused' || value === 'pending') return 'warn'
  if (value === 'archived' || value === 'failed') return 'warn'
  return ''
}

function formatDate(value: unknown) {
  if (!value) return 'never'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function splitCsv(value: FormDataEntryValue | null) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean)
}

function workflowTriggersFromForm(data: FormData): WorkflowTriggerInput[] {
  const type = String(data.get('triggerType') || 'manual').trim()
  const id = `${type}-web`
  if (type === 'schedule') {
    return [{
      id,
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 9,
        runAtMinute: 0,
      },
    }]
  }
  if (type === 'webhook') return [{ id, type: 'webhook', enabled: true }]
  return [{ id: 'manual-web', type: 'manual', enabled: true }]
}
function currentInputValue(id: string) {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || ''
}

function setStatus(message: string, kind: 'ok' | 'warn' | '' = '') {
  const status = document.getElementById('status')
  if (!status) return
  status.textContent = message
  if (kind) status.setAttribute('data-kind', kind)
}

function workspaceAllowedAgents(workspace: unknown) {
  const policy = asRecord(asRecord(workspace).policy)
  return list<unknown>(policy.allowedAgents).map((agent) => typeof agent === 'string' ? agent : text(asRecord(agent).name)).filter(Boolean)
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
          <strong>{agent.name}</strong>
          <span className="pill" data-kind={agent.custom ? 'warn' : 'ok'}>{agent.custom ? 'custom coworker' : 'profile coworker'}</span>
        </div>
        <small>{[agent.custom ? 'Custom metadata' : 'Built-in profile', `${agent.toolCount} tool(s)`, `${agent.skillCount} skill(s)`].join(' - ')}</small>
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

function CapabilityRows({ items, emptyText }: { items: Capability[], emptyText: string }) {
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
            <small>{[item.kind || 'skill', item.source || item.origin || 'profile', item.scope, list(item.agentNames).length ? `coworkers: ${list(item.agentNames).join(', ')}` : null, list(item.toolIds).length ? `tools: ${list(item.toolIds).join(', ')}` : null].filter(Boolean).join(' - ')}</small>
            <small>{cloudWebCapabilityPolicyNote(item)}</small>
          </div>
        </div>
      ))}
    </>
  )
}

function WorkflowTable({ workflows, selectedWorkflowId, onSelect }: { workflows: Workflow[], selectedWorkflowId: string | null, onSelect: (workflowId: string) => void }) {
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

function WorkflowDetail({
  workflow,
  runs,
  disabled,
  onRun,
  onPause,
  onResume,
  onArchive,
  onOpenThread,
}: {
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
      {workflow.latestRunStatus || workflow.latestRunSummary || workflow.latestRunSessionId ? (
        <div className="row compact">
          <div>
            <strong>Latest run</strong>
            <br />
            <small>{[workflow.latestRunStatus || 'unknown', workflow.latestRunSummary, workflow.latestRunSessionId ? `chat ${workflow.latestRunSessionId}` : null].filter(Boolean).join(' - ')}</small>
          </div>
          {workflow.latestRunSessionId ? <div className="row-actions"><button type="button" onClick={() => onOpenThread(workflow.latestRunSessionId as string)}>Open run chat</button></div> : null}
        </div>
      ) : null}
      <p className="empty">{workflow.instructions || 'No instructions.'}</p>
      <details className="runtime-detail">
        <summary>Playbook metadata</summary>
        <pre>{JSON.stringify({ id: workflow.id, agentName: workflow.agentName, skillNames: workflow.skillNames, toolIds: workflow.toolIds, latestRunId: workflow.latestRunId, latestRunStatus: workflow.latestRunStatus, latestRunSummary: workflow.latestRunSummary, nextRunAt: workflow.nextRunAt, lastRunAt: workflow.lastRunAt }, null, 2)}</pre>
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
          <div>
            <strong>{run.title || run.id}</strong>
            <br />
            <small>{[run.triggerType || 'manual', formatDate(run.createdAt), run.summary || run.error].filter(Boolean).join(' - ')}</small>
          </div>
          <div className="row-actions">
            <span className="pill" data-kind={workflowPillKind(run.status)}>{run.status || 'unknown'}</span>
            {run.sessionId ? <button type="button" onClick={() => onOpenThread(run.sessionId as string)}>Open chat</button> : null}
          </div>
        </div>
      )) : <p className="empty">No runs recorded.</p>}
    </>
  )
}

export function CloudWorkbenchSurfacePortals({ bootstrap, workspace, selectedView, onStartAgentChat, onSelectSession, onReloadSessions, artifactActions }: SurfaceProps) {
  const api = useAppApi()
  const [tools, setTools] = useState<Capability[]>([])
  const [skills, setSkills] = useState<Capability[]>([])
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [capabilityFilter, setCapabilityFilter] = useState('')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const targets = {
    agents: usePortalTarget('workbench-agent-list'),
    agentPolicy: usePortalTarget('agent-policy-list'),
    tools: usePortalTarget('tool-list'),
    skills: usePortalTarget('skill-list'),
    capabilityNote: usePortalTarget('capability-policy-note'),
    workflows: usePortalTarget('workflow-list'),
    workflowRuns: usePortalTarget('workflow-run-list'),
    workflowDetail: usePortalTarget('workflow-detail'),
    projectBoard: usePortalTarget('project-board-surface'),
  }
  const workflowDisabled = bootstrap.features.workflows === false
  const workflowDisabledReason = 'Playbook controls are disabled by this cloud profile.'
  const agentDisabled = bootstrap.features.chat === false || bootstrap.features.agents === false

  const loadCapabilities = useCallback(async () => {
    setCapabilityError(null)
    try {
      const body = asRecord(await api.capabilities.catalog())
      setTools(list<Capability>(body.tools))
      setSkills(list<Capability>(body.skills))
    } catch (error) {
      setCapabilityError(errorMessage(error))
    }
  }, [api])

  const loadWorkflows = useCallback(async () => {
    setWorkflowError(null)
    try {
      const body = asRecord(await api.workflows.list())
      const nextWorkflows = list<Workflow>(body.workflows)
      setWorkflows(nextWorkflows)
      setRuns(list<WorkflowRun>(body.runs))
      setSelectedWorkflowId((current) => current && nextWorkflows.some((workflow) => workflow.id === current) ? current : nextWorkflows[0]?.id || null)
    } catch (error) {
      setWorkflowError(errorMessage(error))
    }
  }, [api])

  useEffect(() => {
    document.body.dataset.reactWorkbenchSurfaces = 'active'
    void loadCapabilities()
    void loadWorkflows()
    return () => {
      delete document.body.dataset.reactWorkbenchSurfaces
    }
  }, [loadCapabilities, loadWorkflows])

  useEffect(() => {
    const capabilityFilterControl = document.getElementById('capability-filter') as HTMLInputElement | null
    const workflowFilterControl = document.getElementById('workflow-filter') as HTMLInputElement | null
    const onCapabilityInput = () => setCapabilityFilter(capabilityFilterControl?.value || '')
    const onWorkflowInput = () => setWorkflowFilter(workflowFilterControl?.value || '')
    capabilityFilterControl?.addEventListener('input', onCapabilityInput)
    workflowFilterControl?.addEventListener('input', onWorkflowInput)
    setCapabilityFilter(currentInputValue('capability-filter'))
    setWorkflowFilter(currentInputValue('workflow-filter'))
    return () => {
      capabilityFilterControl?.removeEventListener('input', onCapabilityInput)
      workflowFilterControl?.removeEventListener('input', onWorkflowInput)
    }
  }, [])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('#refresh-capabilities')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void loadCapabilities()
      }
      if (target.closest('#refresh-workflows')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void loadWorkflows()
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [loadCapabilities, loadWorkflows])

  useEffect(() => {
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('[data-workflow-control="true"]'))
    for (const control of controls) {
      control.disabled = workflowDisabled
      control.dataset.locked = workflowDisabled ? 'true' : 'false'
      if (workflowDisabled) control.title = workflowDisabledReason
      else control.removeAttribute('title')
    }
  }, [workflowDisabled, workflowDisabledReason])

  useEffect(() => {
    const form = document.getElementById('workflow-form') as HTMLFormElement | null
    if (!form) return undefined
    const handler = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (workflowDisabled) {
        setStatus(workflowDisabledReason, 'warn')
        return
      }
      void (async () => {
        const data = new FormData(form)
        try {
          await api.workflows.create({
            title: String(data.get('title') || '').trim(),
            agentName: String(data.get('agentName') || '').trim() || undefined,
            triggers: workflowTriggersFromForm(data),
            toolIds: splitCsv(data.get('toolIds')),
            skillNames: splitCsv(data.get('skillNames')),
            instructions: String(data.get('instructions') || '').trim(),
          })
          form.reset()
          await loadWorkflows()
          setStatus('Playbook created', 'ok')
        } catch (error) {
          setStatus(errorMessage(error), 'warn')
        }
      })()
    }
    form.addEventListener('submit', handler, true)
    return () => form.removeEventListener('submit', handler, true)
  }, [api, loadWorkflows, workflowDisabled, workflowDisabledReason])

  const agents = useMemo(() => deriveCloudWebWorkbenchAgents({
    policyAllowedAgents: workspaceAllowedAgents(workspace),
    tools,
    skills,
  }), [skills, tools, workspace])
  const filteredTools = useMemo(() => filterCloudWebCapabilities(tools, capabilityFilter), [capabilityFilter, tools])
  const filteredSkills = useMemo(() => filterCloudWebCapabilities(skills, capabilityFilter), [capabilityFilter, skills])
  const visibleWorkflows = useMemo(() => {
    const tokens = workflowFilter.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) return workflows
    return workflows.filter((workflow) => {
      const haystack = [workflow.id, workflow.title, workflow.status, workflow.agentName, workflow.instructions, cloudWebWorkflowTriggerSummary(workflow), ...(workflow.skillNames || []), ...(workflow.toolIds || [])].filter(Boolean).join(' ').toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    })
  }, [workflowFilter, workflows])
  const selectedWorkflow = visibleWorkflows.find((workflow) => workflow.id === selectedWorkflowId) || visibleWorkflows[0] || null
  const selectedRuns = selectedWorkflow ? runs.filter((run) => run.workflowId === selectedWorkflow.id) : []
  const projectAgentNames = useMemo(() => agents.map((agent) => agent.name), [agents])
  const runWorkflow = useCallback((workflow: Workflow) => {
    void (async () => {
      try {
        const body = asRecord(await api.workflows.run(workflow.id))
        await loadWorkflows()
        await onReloadSessions()
        const run = asRecord(body.run)
        const nextWorkflow = asRecord(body.workflow)
        const sessionId = text(run.sessionId || nextWorkflow.latestRunSessionId)
        if (sessionId) await onSelectSession(sessionId)
        setStatus('Playbook run started', 'ok')
      } catch (error) {
        setStatus(errorMessage(error), 'warn')
      }
    })()
  }, [api, loadWorkflows, onReloadSessions, onSelectSession])

  const updateWorkflow = useCallback((workflow: Workflow, action: 'pause' | 'resume' | 'archive') => {
    void (async () => {
      if (action === 'archive') {
        const confirmation = window.prompt(`Type ${workflow.id} to archive this playbook.`)
        if (confirmation !== workflow.id) {
          setStatus('Confirmation did not match the playbook id.', 'warn')
          return
        }
      }
      try {
        if (action === 'pause') await api.workflows.pause(workflow.id)
        else if (action === 'resume') await api.workflows.resume(workflow.id)
        else await api.workflows.archive(workflow.id)
        await loadWorkflows()
        setStatus(`Playbook ${action} complete`, 'ok')
      } catch (error) {
        setStatus(errorMessage(error), 'warn')
      }
    })()
  }, [api, loadWorkflows])

  const portals = []
  if (targets.agents) {
    portals.push(createPortal(
      agents.length
        ? <>{agents.map((agent) => <AgentCard key={agent.name} agent={agent} disabled={agentDisabled} onStart={onStartAgentChat} />)}</>
        : <p className="empty">{capabilityError || 'No profile-allowed coworkers loaded.'}</p>,
      targets.agents,
    ))
  }
  if (targets.agentPolicy) {
    portals.push(createPortal(
      <>
        <div className="row compact"><strong>Profile</strong><span>{text(asRecord(workspace).profileName || bootstrap.profileName, 'default')}</span></div>
        <div className="row compact"><strong>Chat</strong><span>{bootstrap.features.chat === false ? 'disabled' : 'enabled'}</span></div>
        <div className="row compact"><strong>Playbooks</strong><span>{workflowDisabled ? 'disabled' : 'enabled'}</span></div>
        <div className="row compact"><strong>Surfaces</strong><span>chat, coworkers, tools, playbooks, channels, artifacts</span></div>
      </>,
      targets.agentPolicy,
    ))
  }
  if (targets.tools) portals.push(createPortal(<CapabilityRows items={filteredTools} emptyText={capabilityError || 'No allowed tools loaded.'} />, targets.tools))
  if (targets.skills) portals.push(createPortal(<CapabilityRows items={filteredSkills} emptyText={capabilityError || 'No allowed skills loaded.'} />, targets.skills))
  if (targets.capabilityNote) {
    portals.push(createPortal(
      <>
        {capabilityError ? <p className="notice">{capabilityError}</p> : null}
        {bootstrap.features.agents === false ? <p className="empty">Coworker capability browsing is disabled by this org profile.</p> : null}
        {bootstrap.features.customSkills === false ? <p className="empty">Custom skill metadata may be synced but is disabled by this org profile.</p> : null}
        {bootstrap.features.customMcps === false ? <p className="empty">Custom MCP metadata may be synced but is disabled by this org profile.</p> : null}
        <p className="empty">The browser shows cloud-safe capability metadata and policy verdicts only.</p>
        <p className="empty">Local stdio MCPs are Desktop-only unless represented by a Cloud-safe capability profile.</p>
      </>,
      targets.capabilityNote,
    ))
  }
  if (targets.workflows) portals.push(createPortal(<WorkflowTable workflows={visibleWorkflows.slice(0, 100)} selectedWorkflowId={selectedWorkflow?.id || null} onSelect={setSelectedWorkflowId} />, targets.workflows))
  if (targets.workflowRuns) {
    portals.push(createPortal(
      selectedRuns.length ? <>{selectedRuns.slice(0, 12).map((run) => <div className="row compact" key={run.id || run.createdAt}><strong>{run.title || run.id}</strong><span className="pill" data-kind={workflowPillKind(run.status)}>{run.status || 'unknown'}</span></div>)}</> : <p className="empty">{workflowError || 'No runs loaded.'}</p>,
      targets.workflowRuns,
    ))
  }
  if (targets.workflowDetail) {
    portals.push(createPortal(
      workflowError ? <p className="notice">{workflowError}</p> : <WorkflowDetail
        workflow={selectedWorkflow}
        runs={selectedRuns}
        disabled={workflowDisabled}
        onRun={runWorkflow}
        onPause={(workflow) => updateWorkflow(workflow, 'pause')}
        onResume={(workflow) => updateWorkflow(workflow, 'resume')}
        onArchive={(workflow) => updateWorkflow(workflow, 'archive')}
        onOpenThread={(sessionId) => {
          setRouteHash('chat')
          void onSelectSession(sessionId)
        }}
      />,
      targets.workflowDetail,
    ))
  }
  return (
    <>
      {portals}
      <CloudProjectBoardPortal target={targets.projectBoard} bootstrap={bootstrap} agents={projectAgentNames} onSelectSession={onSelectSession} />
      <CloudArtifactSurfacePortals selectedView={selectedView} artifactActions={artifactActions} />
      <CloudChannelSurfacePortals onSelectSession={onSelectSession} />
    </>
  )
}
