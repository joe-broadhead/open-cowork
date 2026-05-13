import type {
  CapabilityRiskMetadata,
  GovernanceAuditEvent,
  OperationalQueueAlert,
  OperationalQueueItem,
  OperationsAction,
  OperationsHealthSignal,
  OperationsQueueStatus,
  OperationsQueueStatusSummary,
  OperationsSummary,
  OperationsWorkItem,
  WorkLedgerEntry,
  WorkLedgerSourceKind,
} from '@open-cowork/shared'
import {
  COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
} from '@open-cowork/shared'
import {
  buildOperationalQueueAlerts,
  listOperationalQueueItems,
  recoverInterruptedOperationalQueueItems,
} from './operational-queue-store.ts'
import { listCapabilityRiskMetadata } from './operation-capability-risk.ts'
import { listGovernanceAuditEvents } from './governance-audit-store.ts'
import { getWorkLedgerService } from './work-ledger-service.ts'

const OPERATIONS_LEDGER_PAGE_LIMIT = 100
const OPERATIONS_LEDGER_MAX_ITEMS = 500
const OPERATIONS_HEALTH_SIGNAL_LIMIT = 40

const QUEUE_LABELS: Record<OperationsQueueStatus, string> = {
  needs_review: 'Needs review',
  waiting_on_user: 'Waiting on user',
  running: 'Running',
  blocked: 'Blocked',
  failed: 'Failed',
  delivered: 'Delivered',
  quiet_paused: 'Quiet / paused',
}

const QUEUE_RANK: Record<OperationsQueueStatus, number> = {
  needs_review: 0,
  waiting_on_user: 1,
  blocked: 2,
  failed: 3,
  running: 4,
  delivered: 5,
  quiet_paused: 6,
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ')
}

function tokenCount(entry: WorkLedgerEntry) {
  const tokens = entry.usage.tokens
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function workItemRunKey(entry: Pick<WorkLedgerEntry, 'sourceKind' | 'sourceRef'>) {
  if (entry.sourceRef.automationRunId) return `automation:${entry.sourceRef.automationRunId}`
  if (entry.sourceRef.crewRunId) return `crew:${entry.sourceRef.crewRunId}`
  if (entry.sourceKind === 'channel_event' && entry.sourceRef.channelEventId) return `channel:${entry.sourceRef.channelEventId}`
  return null
}

function queueStatusFromOperationalItem(item: OperationalQueueItem | undefined) {
  if (!item) return null
  if (item.status === 'blocked') return 'blocked'
  if (item.status === 'failed') return 'failed'
  if (item.status === 'running' || item.status === 'queued') return 'running'
  if (item.status === 'completed') return 'delivered'
  return 'quiet_paused'
}

export function operationsQueueStatusForEntry(entry: WorkLedgerEntry, queueItem?: OperationalQueueItem): OperationsQueueStatus {
  const queueStatus = queueStatusFromOperationalItem(queueItem)
  if (queueStatus === 'blocked' || queueStatus === 'failed' || queueStatus === 'running') return queueStatus
  if (entry.status === 'blocked') return 'blocked'
  if (entry.status === 'failed' || entry.status === 'error' || entry.status === 'denied') return 'failed'
  if (entry.reviewState === 'approval_requested' || entry.reviewState === 'needs_review') return 'needs_review'
  if (entry.needsUserAttention || entry.status === 'needs_user' || entry.status === 'approval_required') return 'waiting_on_user'
  if (
    entry.status === 'running'
    || entry.status === 'queued'
    || entry.status === 'planning'
    || entry.status === 'dispatching'
    || entry.status === 'dispatched'
    || entry.status === 'enriching'
    || entry.status === 'evaluating'
    || entry.status === 'sending'
    || entry.status === 'delivering'
    || entry.status === 'active'
    || entry.status === 'automation'
  ) {
    return 'running'
  }
  if (
    entry.status === 'completed'
    || entry.status === 'succeeded'
    || entry.status === 'delivered'
    || entry.status === 'approved'
  ) {
    return 'delivered'
  }
  return queueStatus || 'quiet_paused'
}

function actionTarget(entry: WorkLedgerEntry) {
  return {
    route: entry.route,
    sourceRef: entry.sourceRef,
    automationId: entry.sourceRef.automationId || null,
    automationRunId: entry.sourceRef.automationRunId || null,
    crewId: entry.sourceRef.crewId || null,
    crewRunId: entry.sourceRef.crewRunId || null,
    sessionId: entry.sourceRef.sessionId || null,
  }
}

function action(entry: WorkLedgerEntry, kind: OperationsAction['kind'], label: string, options: Partial<OperationsAction> = {}): OperationsAction {
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    id: `${entry.id}:${kind}`,
    kind,
    label,
    supported: options.supported ?? true,
    disabledReason: options.disabledReason ?? null,
    destructive: options.destructive ?? false,
    requiresConfirmation: options.requiresConfirmation ?? false,
    target: actionTarget(entry),
  }
}

function canOpenSourceRoute(route: WorkLedgerEntry['route']) {
  return Boolean(route.sessionId || route.surface === 'automations' || route.surface === 'crews')
}

function buildActions(entry: WorkLedgerEntry, queueStatus: OperationsQueueStatus): OperationsAction[] {
  const actions: OperationsAction[] = []
  if (canOpenSourceRoute(entry.route)) {
    actions.push(action(entry, 'open_source', 'Open source'))
  }
  const automationId = entry.sourceRef.automationId
  const automationRunId = entry.sourceRef.automationRunId
  if (automationId) {
    if (entry.status === 'paused') {
      actions.push(action(entry, 'resume_automation', 'Resume automation'))
    } else if (queueStatus === 'running' || queueStatus === 'blocked' || queueStatus === 'failed' || queueStatus === 'needs_review' || queueStatus === 'waiting_on_user') {
      actions.push(action(entry, 'pause_automation', 'Pause automation', { destructive: false }))
    }
  }
  if (automationRunId && queueStatus === 'failed') {
    actions.push(action(entry, 'retry_automation_run', 'Retry run'))
  }
  if (automationRunId && queueStatus === 'running') {
    actions.push(action(entry, 'cancel_automation_run', 'Cancel run', { destructive: true }))
  }
  return actions
}

function buildQueueSummary(items: OperationsWorkItem[]): OperationsQueueStatusSummary[] {
  return (Object.keys(QUEUE_LABELS) as OperationsQueueStatus[]).map((status) => ({
    status,
    label: QUEUE_LABELS[status],
    count: items.filter((item) => item.queueStatus === status).length,
  }))
}

function toWorkItem(entry: WorkLedgerEntry, queueItemsByRun: Map<string, OperationalQueueItem>): OperationsWorkItem {
  const queueItem = workItemRunKey(entry)
    ? queueItemsByRun.get(workItemRunKey(entry)!)
    : undefined
  const queueStatus = operationsQueueStatusForEntry(entry, queueItem)
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    id: entry.id,
    sourceKind: entry.sourceKind,
    sourceId: entry.sourceId,
    title: entry.title,
    summary: entry.summary,
    queueStatus,
    status: entry.status,
    statusLabel: statusLabel(entry.status),
    sourceLabel: entry.sourceLabel,
    owner: entry.owner,
    agents: entry.agents,
    capabilities: entry.capabilities,
    costUsd: queueItem?.costUsd ?? entry.usage.cost,
    tokenCount: tokenCount(entry),
    riskLabels: entry.riskLabels,
    governanceLabels: entry.governanceLabels,
    reviewState: entry.reviewState,
    needsUserAttention: entry.needsUserAttention || queueStatus === 'needs_review' || queueStatus === 'waiting_on_user',
    sourceRef: entry.sourceRef,
    route: entry.route,
    actions: buildActions(entry, queueStatus),
    createdAt: entry.createdAt,
    updatedAt: queueItem?.updatedAt || entry.updatedAt,
    startedAt: queueItem?.startedAt || entry.startedAt,
    finishedAt: queueItem?.finishedAt || entry.finishedAt,
  }
}

function sortWorkItems(left: OperationsWorkItem, right: OperationsWorkItem) {
  const rank = QUEUE_RANK[left.queueStatus] - QUEUE_RANK[right.queueStatus]
  if (rank !== 0) return rank
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  if (updated !== 0) return updated
  return left.id.localeCompare(right.id)
}

function queueAlertSignal(alert: OperationalQueueAlert, item?: OperationalQueueItem): OperationsHealthSignal {
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    id: `queue:${alert.queueItemId}:${alert.kind}`,
    severity: alert.severity,
    kind: alert.kind,
    title: item ? `${statusLabel(alert.kind)}: ${item.title}` : statusLabel(alert.kind),
    message: alert.message,
    sourceLabel: item ? statusLabel(item.runKind) : 'Operations queue',
    createdAt: alert.createdAt,
    updatedAt: alert.createdAt,
  }
}

function capabilityRiskSignal(risk: CapabilityRiskMetadata): OperationsHealthSignal | null {
  if (risk.risk === 'low' && !risk.writeCapable) return null
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    id: `capability:${risk.capabilityId}:${risk.toolPattern || 'native'}`,
    severity: risk.risk === 'high' ? 'critical' : 'warning',
    kind: 'capability_risk',
    title: `${risk.risk === 'high' ? 'High-risk' : 'Review'} capability: ${risk.capabilityId}`,
    message: risk.reason,
    sourceLabel: risk.toolPattern,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function governanceSignal(event: GovernanceAuditEvent): OperationsHealthSignal | null {
  if (event.outcome !== 'failed') return null
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    id: `governance:${event.id}`,
    severity: 'critical',
    kind: event.action,
    title: `Governance control failed: ${statusLabel(event.action)}`,
    message: event.reason || 'Governance control did not complete.',
    sourceLabel: event.subjectKind,
    route: { surface: 'operations', governanceAuditEventId: event.id },
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  }
}

function buildHealthSignals(input: {
  queueItems: OperationalQueueItem[]
  queueAlerts: OperationalQueueAlert[]
  capabilityRisks: CapabilityRiskMetadata[]
  governanceAuditEvents: GovernanceAuditEvent[]
}) {
  const queueItemsById = new Map(input.queueItems.map((item) => [item.id, item]))
  return [
    ...input.queueAlerts.map((alert) => queueAlertSignal(alert, queueItemsById.get(alert.queueItemId))),
    ...input.capabilityRisks.map(capabilityRiskSignal).filter((signal): signal is OperationsHealthSignal => Boolean(signal)),
    ...input.governanceAuditEvents.map(governanceSignal).filter((signal): signal is OperationsHealthSignal => Boolean(signal)),
  ]
    .sort((left, right) => {
      const severityRank = { critical: 0, warning: 1, info: 2 }
      const rank = severityRank[left.severity] - severityRank[right.severity]
      if (rank !== 0) return rank
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (updated !== 0) return updated
      return left.id.localeCompare(right.id)
    })
    .slice(0, OPERATIONS_HEALTH_SIGNAL_LIMIT)
}

function queueRunKey(item: OperationalQueueItem) {
  return `${item.runKind}:${item.runId}`
}

export function buildOperationsSummary(input: {
  ledgerEntries: WorkLedgerEntry[]
  queueItems?: OperationalQueueItem[]
  queueAlerts?: OperationalQueueAlert[]
  capabilityRisks?: CapabilityRiskMetadata[]
  governanceAuditEvents?: GovernanceAuditEvent[]
  generatedAt?: string
}): OperationsSummary {
  const queueItems = input.queueItems || []
  const queueItemsByRun = new Map(queueItems.map((item) => [queueRunKey(item), item]))
  const items = input.ledgerEntries
    .map((entry) => toWorkItem(entry, queueItemsByRun))
    .sort(sortWorkItems)
  const queue = buildQueueSummary(items)
  const healthSignals = buildHealthSignals({
    queueItems,
    queueAlerts: input.queueAlerts || [],
    capabilityRisks: input.capabilityRisks || [],
    governanceAuditEvents: input.governanceAuditEvents || [],
  })
  return {
    schemaVersion: COWORK_OPERATIONS_COMMAND_CENTER_SCHEMA_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    totalWorkItems: items.length,
    needsAttention: items.filter((item) => item.needsUserAttention || item.queueStatus === 'needs_review' || item.queueStatus === 'waiting_on_user' || item.queueStatus === 'blocked').length,
    running: queue.find((item) => item.status === 'running')?.count || 0,
    failed: queue.find((item) => item.status === 'failed')?.count || 0,
    delivered: queue.find((item) => item.status === 'delivered')?.count || 0,
    queue,
    items,
    healthSignals,
  }
}

function shouldKeepOperationsEntry(entry: WorkLedgerEntry) {
  const sourceKinds = new Set<WorkLedgerSourceKind>([
    'thread',
    'automation',
    'automation_run',
    'crew',
    'crew_run',
    'delegated_task',
    'approval',
    'question',
    'delivery',
    'channel_event',
    'governance_incident',
  ])
  return sourceKinds.has(entry.sourceKind)
}

function loadLedgerEntries() {
  const service = getWorkLedgerService()
  const entries: WorkLedgerEntry[] = []
  let cursor: string | null = null
  do {
    const result = service.search({ limit: OPERATIONS_LEDGER_PAGE_LIMIT, cursor, sort: 'updated_desc' })
    entries.push(...result.entries.filter(shouldKeepOperationsEntry))
    cursor = result.nextCursor
  } while (cursor && entries.length < OPERATIONS_LEDGER_MAX_ITEMS)
  return entries.slice(0, OPERATIONS_LEDGER_MAX_ITEMS)
}

export function getOperationsSummary(): OperationsSummary {
  recoverInterruptedOperationalQueueItems()
  return buildOperationsSummary({
    ledgerEntries: loadLedgerEntries(),
    queueItems: listOperationalQueueItems(),
    queueAlerts: buildOperationalQueueAlerts(),
    capabilityRisks: listCapabilityRiskMetadata(),
    governanceAuditEvents: listGovernanceAuditEvents({ limit: 50 }),
  })
}
