import type {
  AutomationDetail,
  AutomationRun,
  ExecutionBrief,
  SopDraft,
  SopRunLink,
  SopTriggerType,
  SopWorkflowStep,
} from '@open-cowork/shared'
import { COWORK_SOP_SCHEMA_VERSION } from '@open-cowork/shared'
import {
  createAutomationRunWhenNoActive,
  getAutomationDetail,
  getRun,
} from './automation-store.ts'
import {
  createSopDefinition,
  getSopDetail,
  getSopRunLinkForAutomationRun,
  linkAutomationRunToSopVersion,
  listSops,
  updateSopDefinition,
} from './sop-store.ts'

function step(id: string, kind: SopWorkflowStep['kind'], title: string, options: {
  agentName?: string | null
  approvalRequired?: boolean
} = {}): SopWorkflowStep {
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    id,
    kind,
    title,
    agentName: options.agentName || null,
    approvalRequired: options.approvalRequired === true,
  }
}

function workflowFromAutomation(automation: AutomationDetail, brief: ExecutionBrief | null): SopWorkflowStep[] {
  const workflow: SopWorkflowStep[] = [
    step('plan', 'plan', `Plan ${automation.title}`, { agentName: 'plan', approvalRequired: true }),
  ]
  if (brief?.workItems.length) {
    for (const item of brief.workItems) {
      workflow.push(step(`work-${item.id}`, 'execute', item.title, {
        agentName: item.ownerAgent,
        approvalRequired: automation.autonomyPolicy === 'review-first',
      }))
    }
  } else {
    workflow.push(step('execute', 'execute', automation.title, {
      agentName: automation.preferredAgentNames[0] || 'build',
      approvalRequired: automation.autonomyPolicy === 'review-first',
    }))
  }
  workflow.push(step('deliver', 'deliver', `Deliver ${automation.title}`, {
    approvalRequired: automation.autonomyPolicy === 'review-first',
  }))
  return workflow
}

function triggerTypesFromAutomation(automation: AutomationDetail): SopTriggerType[] {
  const triggers: SopTriggerType[] = ['manual']
  if (automation.schedule.type) triggers.push('schedule')
  return Array.from(new Set(triggers))
}

function draftFromCompletedAutomationRun(run: AutomationRun, automation: AutomationDetail): SopDraft {
  const brief = automation.brief
  const approvalBoundary = brief?.approvalBoundary?.trim() || 'Review and approve before external delivery or write-side effects.'
  return {
    name: automation.title,
    description: automation.goal,
    triggerTypes: triggerTypesFromAutomation(automation),
    requiredInputs: automation.projectDirectory ? [
      {
        schemaVersion: COWORK_SOP_SCHEMA_VERSION,
        id: 'project-directory',
        label: 'Project directory',
        description: 'Workspace directory granted to the automation run.',
        required: true,
      },
    ] : [],
    workflow: workflowFromAutomation(automation, brief),
    approvalPolicy: {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      reviewFirst: automation.autonomyPolicy === 'review-first',
      approvalBoundary,
    },
    retryPolicy: automation.retryPolicy,
    runPolicy: automation.runPolicy,
    deliveryPolicy: {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      provider: 'in_app',
      target: 'automation-inbox',
      draftFirst: true,
    },
    outcomeRubricId: null,
  }
}

export function listSopDefinitions() {
  return listSops()
}

export function getSop(sopId: string) {
  return getSopDetail(sopId)
}

export function saveAutomationRunAsSop(runId: string) {
  const run = getRun(runId)
  if (!run) throw new Error(`Automation run ${runId} does not exist.`)
  if (run.status !== 'completed') throw new Error('Only completed automation runs can be saved as SOPs.')
  const automation = getAutomationDetail(run.automationId)
  if (!automation) throw new Error(`Automation ${run.automationId} does not exist.`)
  const existingLink = getSopRunLinkForAutomationRun(run.id)
  if (existingLink) {
    const existingDetail = getSopDetail(existingLink.sopId)
    if (existingDetail) return existingDetail
  }
  const detail = createSopDefinition(draftFromCompletedAutomationRun(run, automation), {
    automationId: automation.id,
    runId: run.id,
  })
  const activeVersion = detail.activeVersion
  if (!activeVersion) throw new Error('Failed to create SOP version.')
  linkAutomationRunToSopVersion({
    sopVersionId: activeVersion.id,
    automationRunId: run.id,
    triggerType: 'manual',
    inputs: {
      source: 'automation_run',
      automationId: automation.id,
      runId: run.id,
      title: run.title,
      summary: run.summary,
    },
  })
  return getSopDetail(detail.definition.id)!
}

export function updateSop(sopId: string, draft: SopDraft) {
  const detail = updateSopDefinition(sopId, draft)
  if (!detail) throw new Error(`SOP ${sopId} does not exist.`)
  return detail
}

export function runSopNow(sopId: string, inputs: Record<string, unknown> = {}): SopRunLink {
  const detail = getSopDetail(sopId)
  if (!detail?.activeVersion) throw new Error(`SOP ${sopId} has no active version.`)
  const automationId = detail.activeVersion.sourceAutomationId || detail.definition.sourceAutomationId
  if (!automationId) throw new Error('SOP has no backing automation to execute.')
  if (!detail.activeVersion.triggerTypes.includes('manual')) {
    throw new Error('SOP does not allow manual runs.')
  }
  const run = createAutomationRunWhenNoActive(automationId, 'execution', `Run SOP: ${detail.definition.name}`)
  if (!run) throw new Error('SOP backing automation already has an active run.')
  return linkAutomationRunToSopVersion({
    sopVersionId: detail.activeVersion.id,
    automationRunId: run.id,
    triggerType: 'manual',
    inputs,
  })
}
