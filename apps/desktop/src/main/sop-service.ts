import type {
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationInboxItem,
  AutomationRun,
  AutomationWorkItem,
  ExecutionBrief,
  SopDraft,
  SopRunDetail,
  SopRunFailure,
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
import { getDb } from './automation-store-db.ts'
import {
  rowToDelivery,
  rowToInbox,
  rowToWorkItem,
  type DbRow,
} from './automation-store-model.ts'
import {
  assertSopRunInputSnapshotSize,
  createSopDefinitionWithRunLink,
  getSopDetail,
  getSopRunLinkForAutomationRun,
  getSopVersion,
  linkAutomationRunToSopVersion,
  listSops,
  updateSopDefinition,
} from './sop-store.ts'

const RUN_PROVENANCE_SUMMARY_MAX_CHARS = 4_000

function inputValueIsPresent(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function assertSopRunEligible(detail: NonNullable<ReturnType<typeof getSopDetail>>, inputs: Record<string, unknown>) {
  if (detail.definition.status !== 'active') throw new Error('Only active SOPs can be run.')
  const activeVersion = detail.activeVersion
  if (!activeVersion) throw new Error(`SOP ${detail.definition.id} has no active version.`)
  const missingInputs = activeVersion.requiredInputs
    .filter((input) => input.required && !inputValueIsPresent(inputs[input.id]))
    .map((input) => input.label || input.id)
  if (missingInputs.length > 0) {
    throw new Error(`Missing required SOP input${missingInputs.length === 1 ? '' : 's'}: ${missingInputs.join(', ')}`)
  }
  assertSopRunInputSnapshotSize(inputs)
}

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

function provenanceInputsForAutomationRun(run: AutomationRun, automation: AutomationDetail): Record<string, unknown> {
  const summary = typeof run.summary === 'string' ? run.summary.trim() : ''
  return {
    source: 'automation_run',
    automationId: automation.id,
    runId: run.id,
    title: run.title,
    ...(summary ? {
      summary: summary.slice(0, RUN_PROVENANCE_SUMMARY_MAX_CHARS),
      summaryTruncated: summary.length > RUN_PROVENANCE_SUMMARY_MAX_CHARS,
    } : {}),
  }
}

export function listSopDefinitions() {
  return listSops()
}

export function getSop(sopId: string) {
  return getSopDetail(sopId)
}

function listRunInboxItems(run: AutomationRun): AutomationInboxItem[] {
  const rows = getDb().prepare(`
    select *
    from automation_inbox
    where run_id = ?
    order by updated_at desc, id desc
  `).all(run.id) as DbRow[]
  return rows.map(rowToInbox)
}

function listRunWorkItems(run: AutomationRun): AutomationWorkItem[] {
  const rows = getDb().prepare(`
    select *
    from automation_work_items
    where run_id = ?
    order by updated_at desc, id desc
  `).all(run.id) as DbRow[]
  return rows.map(rowToWorkItem)
}

function listRunDeliveries(run: AutomationRun): AutomationDeliveryRecord[] {
  const rows = getDb().prepare(`
    select *
    from automation_deliveries
    where run_id = ?
    order by created_at desc, id desc
  `).all(run.id) as DbRow[]
  return rows.map(rowToDelivery)
}

function failuresForRun(run: AutomationRun, inbox: AutomationInboxItem[], deliveries: AutomationDeliveryRecord[]): SopRunFailure[] {
  const failures: SopRunFailure[] = []
  if (run.status === 'failed' || run.error) {
    failures.push({
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      source: 'run',
      id: run.id,
      title: run.failureCode || 'run_failed',
      message: run.error || 'Run failed without a recorded error message.',
      createdAt: run.finishedAt || run.startedAt || run.createdAt,
    })
  }
  for (const item of inbox) {
    if (item.type !== 'failure') continue
    failures.push({
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      source: 'inbox',
      id: item.id,
      title: item.title,
      message: item.body,
      createdAt: item.createdAt,
    })
  }
  for (const delivery of deliveries) {
    if (delivery.status !== 'failed') continue
    failures.push({
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      source: 'delivery',
      id: delivery.id,
      title: delivery.title,
      message: delivery.body,
      createdAt: delivery.createdAt,
    })
  }
  return failures.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getSopRunDetail(automationRunId: string): SopRunDetail | null {
  const link = getSopRunLinkForAutomationRun(automationRunId)
  if (!link) return null
  const version = getSopVersion(link.sopVersionId)
  const sop = getSopDetail(link.sopId)
  const automation = getAutomationDetail(link.automationId)
  const run = getRun(link.automationRunId)
  if (!version || !sop || !automation || !run) return null
  const inbox = listRunInboxItems(run)
  const workItems = listRunWorkItems(run)
  const deliveries = listRunDeliveries(run)
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    link,
    definition: sop.definition,
    version,
    automation,
    run,
    inputs: link.inputs,
    outputs: {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      summary: run.summary,
      deliveries,
    },
    workItems,
    approvals: inbox.filter((item) => item.type === 'approval'),
    inbox,
    artifacts: [],
    evaluatorResults: [],
    failures: failuresForRun(run, inbox, deliveries),
  }
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
  const detail = createSopDefinitionWithRunLink(draftFromCompletedAutomationRun(run, automation), {
    automationId: automation.id,
    runId: run.id,
  }, {
    automationRunId: run.id,
    triggerType: 'manual',
    inputs: provenanceInputsForAutomationRun(run, automation),
  })
  return detail
}

export function updateSop(sopId: string, draft: SopDraft) {
  const detail = updateSopDefinition(sopId, draft)
  if (!detail) throw new Error(`SOP ${sopId} does not exist.`)
  return detail
}

export function runSopNow(sopId: string, inputs: Record<string, unknown> = {}): SopRunLink {
  const detail = getSopDetail(sopId)
  if (!detail?.activeVersion) throw new Error(`SOP ${sopId} has no active version.`)
  assertSopRunEligible(detail, inputs)
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
