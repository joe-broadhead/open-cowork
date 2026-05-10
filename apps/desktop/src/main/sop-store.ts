import type {
  AutomationDeliveryProvider,
  AutomationRetryPolicy,
  AutomationRunPolicy,
  SopApprovalPolicy,
  SopDefinition,
  SopDetail,
  SopDraft,
  SopListItem,
  SopListPayload,
  SopRequiredInput,
  SopRunLink,
  SopStatus,
  SopTriggerType,
  SopVersion,
  SopWorkflowStep,
} from '@open-cowork/shared'
import { COWORK_SOP_SCHEMA_VERSION } from '@open-cowork/shared'
import { getDb, withTransaction } from './automation-store-db.ts'
import {
  parseJson,
  sanitizeRetryPolicy,
  sanitizeRunPolicy,
  type DbRow,
} from './automation-store-model.ts'

const TRIGGER_TYPES = new Set<SopTriggerType>(['manual', 'schedule', 'inbox', 'webhook'])
const STEP_KINDS = new Set<SopWorkflowStep['kind']>(['plan', 'execute', 'approval', 'evaluate', 'deliver'])
const MAX_REQUIRED_INPUTS = 32
const MAX_WORKFLOW_STEPS = 64
export const SOP_RUN_INPUT_SNAPSHOT_MAX_BYTES = 64 * 1024

type SopDefinitionSource = {
  automationId?: string | null
  runId?: string | null
  createdBy?: string | null
}

type SopRunLinkDraft = {
  automationRunId: string
  triggerType: SopTriggerType
  inputs?: Record<string, unknown>
}

function boundedText(value: unknown, fallback: string, max = 4_000) {
  const text = typeof value === 'string' ? value.trim() : fallback
  return text.slice(0, max)
}

function uniqueTriggerTypes(values: unknown): SopTriggerType[] {
  const triggers = Array.isArray(values)
    ? values.filter((value): value is SopTriggerType => typeof value === 'string' && TRIGGER_TYPES.has(value as SopTriggerType))
    : []
  return Array.from(new Set(triggers)).slice(0, 4)
}

function normalizeRequiredInputs(inputs: unknown): SopRequiredInput[] {
  if (!Array.isArray(inputs)) return []
  return inputs.slice(0, MAX_REQUIRED_INPUTS).map((input, index) => {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const id = boundedText(record.id, `input-${index + 1}`, 128) || `input-${index + 1}`
    return {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      id,
      label: boundedText(record.label, id, 256) || id,
      description: boundedText(record.description, '', 1_000),
      required: record.required !== false,
    }
  })
}

function normalizeWorkflow(workflow: unknown): SopWorkflowStep[] {
  if (!Array.isArray(workflow)) return []
  return workflow.slice(0, MAX_WORKFLOW_STEPS).map((step, index) => {
    const record = step && typeof step === 'object' ? step as Record<string, unknown> : {}
    const kind = typeof record.kind === 'string' && STEP_KINDS.has(record.kind as SopWorkflowStep['kind'])
      ? record.kind as SopWorkflowStep['kind']
      : 'execute'
    const id = boundedText(record.id, `${kind}-${index + 1}`, 128) || `${kind}-${index + 1}`
    return {
      schemaVersion: COWORK_SOP_SCHEMA_VERSION,
      id,
      kind,
      title: boundedText(record.title, id, 512) || id,
      agentName: typeof record.agentName === 'string' && record.agentName.trim() ? record.agentName.trim().toLowerCase() : null,
      approvalRequired: record.approvalRequired === true,
    }
  })
}

function normalizeApprovalPolicy(policy: unknown): SopApprovalPolicy {
  const record = policy && typeof policy === 'object' ? policy as Record<string, unknown> : {}
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    reviewFirst: record.reviewFirst !== false,
    approvalBoundary: typeof record.approvalBoundary === 'string' && record.approvalBoundary.trim()
      ? boundedText(record.approvalBoundary, '', 2_000)
      : null,
  }
}

function normalizeDeliveryPolicy(policy: unknown) {
  const record = policy && typeof policy === 'object' ? policy as Record<string, unknown> : {}
  const provider = record.provider === 'desktop_notification' ? 'desktop_notification' : 'in_app'
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    provider: provider as AutomationDeliveryProvider,
    target: boundedText(record.target, 'automation-inbox', 512) || 'automation-inbox',
    draftFirst: record.draftFirst !== false,
  }
}

function normalizeSopDraft(draft: SopDraft): SopDraft {
  const triggerTypes = uniqueTriggerTypes(draft.triggerTypes)
  return {
    name: boundedText(draft.name, 'Untitled SOP', 256) || 'Untitled SOP',
    description: boundedText(draft.description, '', 4_000),
    triggerTypes: triggerTypes.length ? triggerTypes : ['manual'],
    requiredInputs: normalizeRequiredInputs(draft.requiredInputs),
    workflow: normalizeWorkflow(draft.workflow),
    approvalPolicy: normalizeApprovalPolicy(draft.approvalPolicy),
    retryPolicy: sanitizeRetryPolicy(draft.retryPolicy),
    runPolicy: sanitizeRunPolicy(draft.runPolicy),
    deliveryPolicy: normalizeDeliveryPolicy(draft.deliveryPolicy),
    outcomeRubricId: typeof draft.outcomeRubricId === 'string' && draft.outcomeRubricId.trim() ? draft.outcomeRubricId.trim() : null,
  }
}

function rowToSopDefinition(row: DbRow): SopDefinition {
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    status: String(row.status) as SopStatus,
    activeVersionId: typeof row.active_version_id === 'string' ? row.active_version_id : null,
    sourceAutomationId: typeof row.source_automation_id === 'string' ? row.source_automation_id : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToSopVersion(row: DbRow): SopVersion {
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    id: String(row.id),
    sopId: String(row.sop_id),
    version: Number(row.version) || 1,
    sourceAutomationId: typeof row.source_automation_id === 'string' ? row.source_automation_id : null,
    sourceRunId: typeof row.source_run_id === 'string' ? row.source_run_id : null,
    triggerTypes: uniqueTriggerTypes(parseJson<unknown>(row.trigger_types_json, [])),
    requiredInputs: normalizeRequiredInputs(parseJson<unknown>(row.required_inputs_json, [])),
    workflow: normalizeWorkflow(parseJson<unknown>(row.workflow_json, [])),
    approvalPolicy: normalizeApprovalPolicy(parseJson<unknown>(row.approval_policy_json, null)),
    retryPolicy: sanitizeRetryPolicy(parseJson<Partial<AutomationRetryPolicy>>(row.retry_policy_json, {})),
    runPolicy: sanitizeRunPolicy(parseJson<Partial<AutomationRunPolicy>>(row.run_policy_json, {})),
    deliveryPolicy: normalizeDeliveryPolicy(parseJson<unknown>(row.delivery_policy_json, null)),
    outcomeRubricId: typeof row.outcome_rubric_id === 'string' ? row.outcome_rubric_id : null,
    createdAt: String(row.created_at),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }
}

function rowToSopRunLink(row: DbRow): SopRunLink {
  return {
    schemaVersion: COWORK_SOP_SCHEMA_VERSION,
    id: String(row.id),
    sopId: String(row.sop_id),
    sopVersionId: String(row.sop_version_id),
    automationId: String(row.automation_id),
    automationRunId: String(row.automation_run_id),
    triggerType: TRIGGER_TYPES.has(String(row.trigger_type) as SopTriggerType) ? String(row.trigger_type) as SopTriggerType : 'manual',
    inputs: parseJson<Record<string, unknown>>(row.inputs_json, {}),
    createdAt: String(row.created_at),
  }
}

function listSopVersions(sopId: string) {
  const rows = getDb().prepare('select * from sop_versions where sop_id = ? order by version desc').all(sopId) as DbRow[]
  return rows.map(rowToSopVersion)
}

function listSopRunLinks(sopId: string) {
  const rows = getDb().prepare('select * from sop_run_links where sop_id = ? order by created_at desc').all(sopId) as DbRow[]
  return rows.map(rowToSopRunLink)
}

function getNextSopVersion(db: ReturnType<typeof getDb>, sopId: string) {
  const row = db.prepare('select max(version) as version from sop_versions where sop_id = ?').get(sopId) as { version?: number | null } | undefined
  return Math.max(0, Number(row?.version) || 0) + 1
}

function insertSopVersion(
  db: ReturnType<typeof getDb>,
  sopId: string,
  version: number,
  draft: SopDraft,
  source: SopDefinitionSource = {},
) {
  const normalized = normalizeSopDraft(draft)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    insert into sop_versions (
      id, sop_id, version, source_automation_id, source_run_id, trigger_types_json, required_inputs_json,
      workflow_json, approval_policy_json, retry_policy_json, run_policy_json, delivery_policy_json,
      outcome_rubric_id, created_at, created_by
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sopId,
    version,
    source.automationId || null,
    source.runId || null,
    JSON.stringify(normalized.triggerTypes),
    JSON.stringify(normalized.requiredInputs),
    JSON.stringify(normalized.workflow),
    JSON.stringify(normalized.approvalPolicy),
    JSON.stringify(normalized.retryPolicy),
    JSON.stringify(normalized.runPolicy),
    JSON.stringify(normalized.deliveryPolicy),
    normalized.outcomeRubricId || null,
    now,
    source.createdBy || null,
  )
  db.prepare('update sop_definitions set active_version_id = ?, name = ?, description = ?, status = ?, updated_at = ? where id = ?')
    .run(id, normalized.name, normalized.description, 'active', now, sopId)
  return id
}

function getSopVersionFromDb(db: ReturnType<typeof getDb>, sopVersionId: string) {
  const row = db.prepare('select * from sop_versions where id = ?').get(sopVersionId) as DbRow | undefined
  return row ? rowToSopVersion(row) : null
}

function getSopRunLinkForAutomationRunFromDb(db: ReturnType<typeof getDb>, automationRunId: string) {
  const row = db.prepare('select * from sop_run_links where automation_run_id = ?').get(automationRunId) as DbRow | undefined
  return row ? rowToSopRunLink(row) : null
}

function insertSopRunLink(
  db: ReturnType<typeof getDb>,
  input: SopRunLinkDraft & { sopVersionId: string },
) {
  const version = getSopVersionFromDb(db, input.sopVersionId)
  if (!version) throw new Error(`SOP version ${input.sopVersionId} does not exist.`)
  const run = db.prepare('select id, automation_id from automation_runs where id = ?').get(input.automationRunId) as DbRow | undefined
  if (!run) throw new Error(`Automation run ${input.automationRunId} does not exist.`)
  const triggerType = TRIGGER_TYPES.has(input.triggerType) ? input.triggerType : 'manual'
  if (!version.triggerTypes.includes(triggerType)) {
    throw new Error(`SOP version ${version.id} does not allow ${triggerType} triggers.`)
  }
  const inputs = input.inputs || {}
  assertSopRunInputSnapshotSize(inputs)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    insert into sop_run_links (
      id, sop_id, sop_version_id, automation_id, automation_run_id, trigger_type, inputs_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(automation_run_id) do nothing
  `).run(id, version.sopId, version.id, String(run.automation_id), input.automationRunId, triggerType, JSON.stringify(inputs), now)
  const link = getSopRunLinkForAutomationRunFromDb(db, input.automationRunId)
  if (!link) throw new Error(`Failed to link automation run ${input.automationRunId} to SOP version ${version.id}.`)
  if (link.sopVersionId !== version.id) {
    throw new Error(`Automation run ${input.automationRunId} is already linked to another SOP version.`)
  }
  return link
}

export function createSopDefinition(
  draft: SopDraft,
  source: SopDefinitionSource = {},
): SopDetail {
  const normalized = normalizeSopDraft(draft)
  const sopId = crypto.randomUUID()
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare(`
      insert into sop_definitions (
        id, name, description, status, active_version_id, source_automation_id, created_at, updated_at
      ) values (?, ?, ?, ?, null, ?, ?, ?)
    `).run(sopId, normalized.name, normalized.description, 'draft', source.automationId || null, now, now)
    insertSopVersion(db, sopId, 1, normalized, source)
  })
  return getSopDetail(sopId)!
}

export function createSopDefinitionWithRunLink(
  draft: SopDraft,
  source: SopDefinitionSource,
  runLink: SopRunLinkDraft,
): SopDetail {
  const normalized = normalizeSopDraft(draft)
  const sopId = crypto.randomUUID()
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare(`
      insert into sop_definitions (
        id, name, description, status, active_version_id, source_automation_id, created_at, updated_at
      ) values (?, ?, ?, ?, null, ?, ?, ?)
    `).run(sopId, normalized.name, normalized.description, 'draft', source.automationId || null, now, now)
    const versionId = insertSopVersion(db, sopId, 1, normalized, source)
    insertSopRunLink(db, { ...runLink, sopVersionId: versionId })
  })
  return getSopDetail(sopId)!
}

export function updateSopDefinition(sopId: string, draft: SopDraft): SopDetail | null {
  const existing = getSopDefinition(sopId)
  if (!existing) return null
  const normalized = normalizeSopDraft(draft)
  withTransaction((db) => {
    insertSopVersion(db, sopId, getNextSopVersion(db, sopId), normalized, {
      automationId: existing.sourceAutomationId,
    })
  })
  return getSopDetail(sopId)
}

export function getSopDefinition(sopId: string) {
  const row = getDb().prepare('select * from sop_definitions where id = ?').get(sopId) as DbRow | undefined
  return row ? rowToSopDefinition(row) : null
}

export function getSopVersion(sopVersionId: string) {
  const row = getDb().prepare('select * from sop_versions where id = ?').get(sopVersionId) as DbRow | undefined
  return row ? rowToSopVersion(row) : null
}

export function getSopDetail(sopId: string): SopDetail | null {
  const definition = getSopDefinition(sopId)
  if (!definition) return null
  const versions = listSopVersions(sopId)
  return {
    definition,
    versions,
    activeVersion: definition.activeVersionId ? versions.find((version) => version.id === definition.activeVersionId) || null : null,
    runLinks: listSopRunLinks(sopId),
  }
}

export function listSops(): SopListPayload {
  const rows = getDb().prepare('select * from sop_definitions order by updated_at desc, name asc').all() as DbRow[]
  const sops: SopListItem[] = rows.map((row) => {
    const definition = rowToSopDefinition(row)
    const activeVersion = definition.activeVersionId ? getSopVersion(definition.activeVersionId) : null
    return { definition, activeVersion }
  })
  return { sops }
}

export function assertSopRunInputSnapshotSize(inputs: Record<string, unknown>) {
  const bytes = Buffer.byteLength(JSON.stringify(inputs), 'utf8')
  if (bytes > SOP_RUN_INPUT_SNAPSHOT_MAX_BYTES) throw new Error('SOP run inputs are too large.')
}

export function linkAutomationRunToSopVersion(input: {
  sopVersionId: string
  automationRunId: string
  triggerType: SopTriggerType
  inputs?: Record<string, unknown>
}): SopRunLink {
  withTransaction((db) => {
    insertSopRunLink(db, input)
  })
  return getSopRunLinkForAutomationRun(input.automationRunId)!
}

export function getSopRunLinkForAutomationRun(automationRunId: string) {
  return getSopRunLinkForAutomationRunFromDb(getDb(), automationRunId)
}
