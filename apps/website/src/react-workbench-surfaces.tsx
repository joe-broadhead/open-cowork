import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppApi } from '@open-cowork/ui/app-api'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import { CloudArtifactSurfacePortals } from './react-workbench-artifacts.tsx'
import { CloudChannelSurfacePortals } from './react-workbench-channels.tsx'
import { CloudKnowledgeSurfacePortals } from './react-workbench-knowledge.tsx'
import { CloudProjectBoardPortal } from './react-workbench-projects.tsx'
import type { CloudRuntimeActionProps } from './react-workbench.ts'
import { asRecord, errorMessage, setRouteHash } from './react-workbench-controller.ts'
import type { CloudWebThreadView } from './thread-workbench.ts'
import {
  cloudWebWorkflowTriggerSummary,
  deriveCloudWebWorkbenchAgents,
  filterCloudWebCapabilities,
} from './surface-workbench.ts'
import {
  AgentDirectory,
  CapabilityRows,
  CapabilityTabs,
  WorkflowDetail,
  WorkflowTable,
  workflowPillKind,
  type AgentFilter,
  type Capability,
  type CapabilityTab,
  type Workflow,
  type WorkflowRun,
} from './react-workbench-library.tsx'

type SurfaceProps = {
  bootstrap: CloudWebClientBootstrap
  workspace: unknown
  selectedView: CloudWebThreadView | null
  onStartAgentChat: (agentName: string) => void
  onSelectSession: (sessionId: string) => Promise<void>
  onReloadSessions: () => Promise<void>
  artifactActions: CloudRuntimeActionProps
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
  return list<unknown>(policy.allowedAgents)
}

export function CloudWorkbenchSurfacePortals({ bootstrap, workspace, selectedView, onStartAgentChat, onSelectSession, onReloadSessions, artifactActions }: SurfaceProps) {
  const api = useAppApi()
  const [tools, setTools] = useState<Capability[]>([])
  const [skills, setSkills] = useState<Capability[]>([])
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [capabilityFilter, setCapabilityFilter] = useState('')
  const [capabilityTab, setCapabilityTab] = useState<CapabilityTab>('abilities')
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('everyone')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const [workflowFilter, setWorkflowFilter] = useState('')
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const targets = {
    agents: usePortalTarget('workbench-agent-list'),
    agentPolicy: usePortalTarget('agent-policy-list'),
    capabilityTabs: usePortalTarget('capability-tabs'),
    capabilityActiveList: usePortalTarget('capability-active-list'),
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
      <AgentDirectory
        agents={agents}
        filter={agentFilter}
        disabled={agentDisabled}
        error={capabilityError}
        onFilter={setAgentFilter}
        onStart={onStartAgentChat}
      />,
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
  if (targets.capabilityTabs) {
    portals.push(createPortal(
      <CapabilityTabs tab={capabilityTab} abilityCount={filteredSkills.length} connectionCount={filteredTools.length} onTab={setCapabilityTab} />,
      targets.capabilityTabs,
    ))
  }
  if (targets.capabilityActiveList) {
    portals.push(createPortal(
      capabilityTab === 'abilities'
        ? <CapabilityRows items={filteredSkills} emptyText={capabilityError || 'No allowed abilities loaded.'} />
        : <CapabilityRows items={filteredTools} emptyText={capabilityError || 'No allowed connections loaded.'} />,
      targets.capabilityActiveList,
    ))
  }
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
      <CloudChannelSurfacePortals bootstrap={bootstrap} workspace={workspace} onSelectSession={onSelectSession} />
      <CloudKnowledgeSurfacePortals selectedView={selectedView} bootstrap={bootstrap} workspace={workspace} />
    </>
  )
}
