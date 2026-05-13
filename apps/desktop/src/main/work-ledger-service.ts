import type {
  AutomationInboxItem,
  AutomationListPayload,
  AutomationRunStatus,
  AutomationStatus,
  AutomationWorkItem,
  ChannelDeliveryRecord,
  ChannelInboundItem,
  ChannelListPayload,
  CoworkWorkItem,
  CrewApproval,
  CrewApprovalStatus,
  CrewArtifact,
  CrewListPayload,
  CrewRun,
  CrewRunNode,
  CrewRunNodeStatus,
  CrewRunStatus,
  GovernanceAuditEvent,
  GovernanceAuditOutcome,
  PolicyDecision,
  PolicyDecisionStatus,
  SessionTokens,
  ThreadListItem,
  WorkLedgerReviewState,
  WorkLedgerSearchQuery,
  WorkLedgerSourceKind,
  WorkLedgerStatus,
  WorkLedgerUpsertInput,
} from '@open-cowork/shared'
import { listAutomationState } from './automation-store.ts'
import { listChannelState } from './channel-store.ts'
import { listCrewCatalog } from './crew-service.ts'
import {
  listCoworkWorkItems,
  listCrewApprovalsForAudit,
  listCrewArtifactsForRun,
  listCrewRunNodes,
  listCrewRunsForAudit,
  listPolicyDecisionsForAudit,
} from './crew-store.ts'
import { listGovernanceAuditEvents } from './governance-audit-store.ts'
import { getThreadIndexService } from './thread-index-service.ts'
import {
  getWorkLedgerStore,
  normalizeWorkLedgerSearchQuery,
  type WorkLedgerStore,
} from './work-ledger-store.ts'
import { log } from './logger.ts'

const LEDGER_REFRESH_TTL_MS = 5_000
const RECENT_THREAD_PAGE_LIMIT = 100
const RECENT_GOVERNANCE_AUDIT_LIMIT = 500

export interface WorkLedgerCrewSnapshot {
  catalog: CrewListPayload
  runs: CrewRun[]
  nodes: CrewRunNode[]
  workItems: CoworkWorkItem[]
  approvals: CrewApproval[]
  policyDecisions: PolicyDecision[]
  artifacts: CrewArtifact[]
}

export interface WorkLedgerSnapshot {
  threads: ThreadListItem[]
  automations: AutomationListPayload
  crews: WorkLedgerCrewSnapshot
  channels: ChannelListPayload
  governanceAuditEvents: GovernanceAuditEvent[]
}

type WorkLedgerSnapshotLoader = () => WorkLedgerSnapshot

function emptyTokens(): SessionTokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}

function emptyUsage() {
  return { cost: 0, tokens: emptyTokens() }
}

function compactStrings(values: Array<string | null | undefined | false>) {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())))
}

function sourceId(kind: WorkLedgerSourceKind, id: string) {
  return `${kind}:${id}`
}

function reviewFromStatus(status: WorkLedgerStatus): WorkLedgerReviewState {
  if (status === 'needs_user' || status === 'blocked') return 'needs_review'
  if (status === 'approval_required') return 'approval_requested'
  if (status === 'approved') return 'approved'
  if (status === 'denied') return 'denied'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'completed' || status === 'delivered' || status === 'succeeded' || status === 'cancelled') return 'resolved'
  return 'none'
}

function routeForThread(sessionId: string) {
  return {
    surface: 'thread' as const,
    sessionId,
  }
}

function automationRoute(automationId: string, automationRunId?: string | null, sessionId?: string | null) {
  return {
    surface: 'automations' as const,
    automationId,
    automationRunId: automationRunId || null,
    sessionId: sessionId || null,
  }
}

function crewRoute(crewId?: string | null, crewRunId?: string | null, sessionId?: string | null) {
  return {
    surface: sessionId ? 'thread' as const : 'crews' as const,
    crewId: crewId || null,
    crewRunId: crewRunId || null,
    sessionId: sessionId || null,
  }
}

function channelRoute(channelId: string) {
  return {
    surface: 'channels' as const,
    channelId,
  }
}

function governanceRoute(eventId: string) {
  return {
    surface: 'operations' as const,
    governanceAuditEventId: eventId,
  }
}

function mapThreadStatus(status: ThreadListItem['status']): WorkLedgerStatus {
  if (status === 'error') return 'error'
  return status
}

function mapAutomationStatus(status: AutomationStatus): WorkLedgerStatus {
  return status
}

function mapAutomationRunStatus(status: AutomationRunStatus): WorkLedgerStatus {
  return status
}

function mapAutomationWorkItemStatus(status: AutomationWorkItem['status']): WorkLedgerStatus {
  return status
}

function mapCrewRunStatus(status: CrewRunStatus): WorkLedgerStatus {
  return status
}

function mapCrewNodeStatus(status: CrewRunNodeStatus): WorkLedgerStatus {
  if (status === 'skipped') return 'cancelled'
  return status
}

function mapCrewApprovalStatus(status: CrewApprovalStatus): WorkLedgerStatus {
  if (status === 'requested') return 'approval_required'
  if (status === 'cancelled') return 'cancelled'
  return status
}

function mapPolicyStatus(status: PolicyDecisionStatus): WorkLedgerStatus {
  if (status === 'approval_required') return 'approval_required'
  if (status === 'denied') return 'denied'
  return 'approved'
}

function mapGovernanceOutcome(outcome: GovernanceAuditOutcome): WorkLedgerStatus {
  return outcome === 'failed' ? 'failed' : 'succeeded'
}

function titleWithPrefix(prefix: string, title: string) {
  return title.toLowerCase().startsWith(prefix.toLowerCase()) ? title : `${prefix}: ${title}`
}

function threadEntries(threads: ThreadListItem[]): WorkLedgerUpsertInput[] {
  return threads.map((thread) => {
    const status = mapThreadStatus(thread.status)
    return {
      id: sourceId('thread', thread.sessionId),
      sourceKind: 'thread',
      sourceId: thread.sessionId,
      title: thread.title || 'New session',
      summary: thread.changeSummary?.files
        ? `${thread.changeSummary.files} files changed, ${thread.changeSummary.additions} additions, ${thread.changeSummary.deletions} deletions.`
        : null,
      status,
      sourceLabel: thread.projectLabel || thread.directory || 'Thread',
      owner: thread.projectLabel || null,
      agents: thread.actualAgents.map((agent) => agent.name),
      capabilities: thread.actualTools.map((tool) => tool.name),
      usage: {
        cost: thread.usage.cost,
        tokens: thread.usage.tokens,
      },
      riskLabels: [],
      governanceLabels: compactStrings([
        thread.automationId ? 'automation-linked' : null,
        thread.revertedMessageId ? 'reverted' : null,
      ]),
      reviewState: reviewFromStatus(status),
      needsUserAttention: status === 'needs_user',
      sourceRef: {
        kind: 'thread',
        id: thread.sessionId,
        sessionId: thread.sessionId,
        automationId: thread.automationId,
        automationRunId: thread.runId,
      },
      route: routeForThread(thread.sessionId),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      startedAt: null,
      finishedAt: null,
    }
  })
}

function automationEntries(snapshot: AutomationListPayload): WorkLedgerUpsertInput[] {
  const entries: WorkLedgerUpsertInput[] = []
  const automations = new Map(snapshot.automations.map((automation) => [automation.id, automation]))
  for (const automation of snapshot.automations) {
    const status = mapAutomationStatus(automation.status)
    entries.push({
      id: sourceId('automation', automation.id),
      sourceKind: 'automation',
      sourceId: automation.id,
      title: automation.title,
      summary: automation.goal,
      status,
      sourceLabel: 'Automation',
      owner: automation.projectDirectory,
      agents: automation.preferredAgentNames,
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([automation.autonomyPolicy, automation.executionMode, automation.kind]),
      reviewState: automation.status === 'needs_user' ? 'needs_review' : reviewFromStatus(status),
      needsUserAttention: automation.status === 'needs_user' || automation.latestRunStatus === 'needs_user',
      sourceRef: {
        kind: 'automation',
        id: automation.id,
        automationId: automation.id,
        automationRunId: automation.latestRunId,
      },
      route: automationRoute(automation.id, automation.latestRunId),
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
      startedAt: automation.lastRunAt,
      finishedAt: null,
    })
  }
  for (const run of snapshot.runs) {
    const automation = automations.get(run.automationId)
    const status = mapAutomationRunStatus(run.status)
    entries.push({
      id: sourceId('automation_run', run.id),
      sourceKind: 'automation_run',
      sourceId: run.id,
      title: run.title,
      summary: run.summary,
      status,
      sourceLabel: automation?.title || 'Automation run',
      owner: automation?.projectDirectory || null,
      agents: automation?.preferredAgentNames || [],
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: compactStrings([run.failureCode || null]),
      governanceLabels: compactStrings([run.kind, run.retryOfRunId ? 'retry' : null]),
      reviewState: reviewFromStatus(status),
      needsUserAttention: status === 'needs_user' || status === 'failed',
      sourceRef: {
        kind: 'automation_run',
        id: run.id,
        automationId: run.automationId,
        automationRunId: run.id,
        sessionId: run.sessionId,
      },
      route: automationRoute(run.automationId, run.id, run.sessionId),
      createdAt: run.createdAt,
      updatedAt: run.finishedAt || run.startedAt || run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })
  }
  for (const item of snapshot.workItems) {
    const automation = automations.get(item.automationId)
    const status = mapAutomationWorkItemStatus(item.status)
    entries.push({
      id: sourceId('delegated_task', `automation_work_item:${item.id}`),
      sourceKind: 'delegated_task',
      sourceId: `automation_work_item:${item.id}`,
      title: titleWithPrefix('Automation task', item.title),
      summary: item.description,
      status,
      sourceLabel: automation?.title || 'Automation work item',
      owner: item.ownerAgent,
      agents: compactStrings([item.ownerAgent]),
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([item.blockingReason ? 'blocked' : null]),
      reviewState: item.status === 'blocked' ? 'needs_review' : reviewFromStatus(status),
      needsUserAttention: item.status === 'blocked' || item.status === 'failed',
      sourceRef: {
        kind: 'delegated_task',
        id: item.id,
        automationId: item.automationId,
        automationRunId: item.runId,
      },
      route: automationRoute(item.automationId, item.runId),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      startedAt: null,
      finishedAt: null,
    })
  }
  for (const item of snapshot.inbox) {
    entries.push(automationInboxEntry(item, automations.get(item.automationId)))
  }
  for (const delivery of snapshot.deliveries) {
    const automation = automations.get(delivery.automationId)
    const status: WorkLedgerStatus = delivery.status === 'delivered' ? 'delivered' : 'failed'
    entries.push({
      id: sourceId('delivery', `automation_delivery:${delivery.id}`),
      sourceKind: 'delivery',
      sourceId: `automation_delivery:${delivery.id}`,
      title: titleWithPrefix('Delivery', delivery.title),
      summary: null,
      status,
      sourceLabel: automation?.title || 'Automation delivery',
      owner: automation?.projectDirectory || null,
      agents: automation?.preferredAgentNames || [],
      capabilities: compactStrings([delivery.provider]),
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([delivery.status]),
      reviewState: reviewFromStatus(status),
      needsUserAttention: delivery.status === 'failed',
      sourceRef: {
        kind: 'delivery',
        id: delivery.id,
        automationId: delivery.automationId,
        automationRunId: delivery.runId,
        deliveryId: delivery.id,
      },
      route: automationRoute(delivery.automationId, delivery.runId),
      createdAt: delivery.createdAt,
      updatedAt: delivery.createdAt,
      startedAt: null,
      finishedAt: delivery.createdAt,
    })
  }
  return entries
}

function automationInboxEntry(item: AutomationInboxItem, automation?: AutomationListPayload['automations'][number]): WorkLedgerUpsertInput {
  const sourceKind: WorkLedgerSourceKind = item.type === 'approval'
    ? 'approval'
    : item.type === 'clarification'
      ? 'question'
      : 'governance_incident'
  const status: WorkLedgerStatus = item.status === 'open'
    ? item.type === 'approval' ? 'approval_required' : 'needs_user'
    : item.status === 'dismissed' ? 'dismissed' : 'completed'
  return {
    id: sourceId(sourceKind, `automation_inbox:${item.id}`),
    sourceKind,
    sourceId: `automation_inbox:${item.id}`,
    title: item.title,
    summary: null,
    status,
    sourceLabel: automation?.title || 'Automation inbox',
    owner: automation?.projectDirectory || null,
    agents: automation?.preferredAgentNames || [],
    capabilities: [],
    usage: emptyUsage(),
    riskLabels: item.type === 'failure' ? ['failure'] : [],
    governanceLabels: compactStrings([item.type, item.status]),
    reviewState: item.status === 'open'
      ? item.type === 'approval' ? 'approval_requested' : 'needs_review'
      : 'resolved',
    needsUserAttention: item.status === 'open' && (item.type === 'approval' || item.type === 'clarification' || item.type === 'failure'),
    sourceRef: {
      kind: sourceKind,
      id: item.id,
      automationId: item.automationId,
      automationRunId: item.runId,
      sessionId: item.sessionId,
      questionId: item.questionId,
      approvalId: item.type === 'approval' ? item.id : null,
    },
    route: automationRoute(item.automationId, item.runId, item.sessionId),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    startedAt: null,
    finishedAt: item.status === 'open' ? null : item.updatedAt,
  }
}

function crewEntries(snapshot: WorkLedgerCrewSnapshot): WorkLedgerUpsertInput[] {
  const entries: WorkLedgerUpsertInput[] = []
  const crewItems = new Map(snapshot.catalog.crews.map((item) => [item.definition.id, item]))
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]))
  const workItems = new Map(snapshot.workItems.map((item) => [item.id, item]))
  for (const item of snapshot.catalog.crews) {
    const status = item.definition.status as WorkLedgerStatus
    entries.push({
      id: sourceId('crew', item.definition.id),
      sourceKind: 'crew',
      sourceId: item.definition.id,
      title: item.definition.name,
      summary: item.definition.description,
      status,
      sourceLabel: 'Crew',
      owner: item.activeVersion?.workspaceProfileId || null,
      agents: compactStrings(item.activeVersion?.members.map((member) => member.agentName) || []),
      capabilities: compactStrings([item.activeVersion?.evalSuiteId || null, item.activeVersion?.outcomeRubricId || null]),
      usage: emptyUsage(),
      riskLabels: compactStrings([item.activeVersion?.certificationStatus === 'required' ? 'certification-required' : null]),
      governanceLabels: compactStrings([item.definition.status]),
      reviewState: item.definition.status === 'review' ? 'needs_review' : reviewFromStatus(status),
      needsUserAttention: item.definition.status === 'review',
      sourceRef: {
        kind: 'crew',
        id: item.definition.id,
        crewId: item.definition.id,
        crewRunId: item.latestRun?.id,
      },
      route: crewRoute(item.definition.id, item.latestRun?.id),
      createdAt: item.definition.createdAt,
      updatedAt: item.definition.updatedAt,
      startedAt: item.latestRun?.startedAt || null,
      finishedAt: item.latestRun?.finishedAt || null,
    })
  }
  for (const run of snapshot.runs) {
    const crew = crewItems.get(run.crewId)
    const workItem = run.workItemId ? workItems.get(run.workItemId) : null
    const status = mapCrewRunStatus(run.status)
    entries.push({
      id: sourceId('crew_run', run.id),
      sourceKind: 'crew_run',
      sourceId: run.id,
      title: run.title,
      summary: run.summary || workItem?.description || null,
      status,
      sourceLabel: crew?.definition.name || 'Crew run',
      owner: crew?.activeVersion?.workspaceProfileId || null,
      agents: compactStrings(crew?.activeVersion?.members.map((member) => member.agentName) || []),
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([workItem?.source || null]),
      reviewState: reviewFromStatus(status),
      needsUserAttention: status === 'blocked' || status === 'failed',
      sourceRef: {
        kind: 'crew_run',
        id: run.id,
        crewId: run.crewId,
        crewRunId: run.id,
        sessionId: run.rootSessionId,
      },
      route: crewRoute(run.crewId, run.id, run.rootSessionId),
      createdAt: run.createdAt,
      updatedAt: run.finishedAt || run.startedAt || run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })
  }
  for (const node of snapshot.nodes) {
    if (!node.agentName && node.kind !== 'delegate') continue
    const run = runs.get(node.crewRunId)
    const crew = run ? crewItems.get(run.crewId) : null
    const status = mapCrewNodeStatus(node.status)
    entries.push({
      id: sourceId('delegated_task', `crew_node:${node.id}`),
      sourceKind: 'delegated_task',
      sourceId: `crew_node:${node.id}`,
      title: titleWithPrefix('Crew task', node.title),
      summary: null,
      status,
      sourceLabel: crew?.definition.name || 'Crew task',
      owner: node.agentName,
      agents: compactStrings([node.agentName]),
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([node.kind]),
      reviewState: reviewFromStatus(status),
      needsUserAttention: status === 'blocked' || status === 'failed',
      sourceRef: {
        kind: 'delegated_task',
        id: node.id,
        crewId: run?.crewId || null,
        crewRunId: node.crewRunId,
        crewNodeId: node.id,
        sessionId: node.sessionId,
      },
      route: crewRoute(run?.crewId, node.crewRunId, node.sessionId),
      createdAt: node.startedAt || run?.createdAt || new Date(0).toISOString(),
      updatedAt: node.finishedAt || node.startedAt || run?.createdAt || new Date(0).toISOString(),
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
    })
  }
  for (const approval of snapshot.approvals) {
    const run = runs.get(approval.crewRunId)
    const crew = run ? crewItems.get(run.crewId) : null
    const status = mapCrewApprovalStatus(approval.status)
    entries.push({
      id: sourceId('approval', `crew_approval:${approval.id}`),
      sourceKind: 'approval',
      sourceId: `crew_approval:${approval.id}`,
      title: titleWithPrefix('Approval', approval.title),
      summary: null,
      status,
      sourceLabel: crew?.definition.name || 'Crew approval',
      owner: approval.resolvedBy,
      agents: compactStrings(crew?.activeVersion?.members.map((member) => member.agentName) || []),
      capabilities: [],
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: compactStrings([approval.status]),
      reviewState: approval.status === 'requested' ? 'approval_requested' : approval.status === 'approved' ? 'approved' : approval.status === 'denied' ? 'denied' : 'resolved',
      needsUserAttention: approval.status === 'requested',
      sourceRef: {
        kind: 'approval',
        id: approval.id,
        crewId: run?.crewId || null,
        crewRunId: approval.crewRunId,
        crewNodeId: approval.nodeId,
        approvalId: approval.id,
      },
      route: crewRoute(run?.crewId, approval.crewRunId),
      createdAt: approval.requestedAt,
      updatedAt: approval.resolvedAt || approval.requestedAt,
      startedAt: approval.requestedAt,
      finishedAt: approval.resolvedAt,
    })
  }
  for (const decision of snapshot.policyDecisions) {
    const run = runs.get(decision.runId)
    const status = mapPolicyStatus(decision.status)
    entries.push({
      id: sourceId('approval', `policy_decision:${decision.id}`),
      sourceKind: 'approval',
      sourceId: `policy_decision:${decision.id}`,
      title: `Policy decision: ${decision.capabilityId || decision.runKind}`,
      summary: decision.reason,
      status,
      sourceLabel: 'Policy decision',
      owner: null,
      agents: [],
      capabilities: compactStrings([decision.capabilityId]),
      usage: emptyUsage(),
      riskLabels: decision.status === 'denied' || decision.status === 'approval_required' ? ['policy'] : [],
      governanceLabels: compactStrings([decision.status, decision.runKind]),
      reviewState: decision.status === 'approval_required' ? 'approval_requested' : decision.status === 'denied' ? 'denied' : 'approved',
      needsUserAttention: decision.status === 'approval_required' || decision.status === 'denied',
      sourceRef: {
        kind: 'approval',
        id: decision.id,
        crewId: run?.crewId || null,
        crewRunId: decision.runId,
        crewNodeId: decision.nodeId,
        approvalId: decision.id,
      },
      route: crewRoute(run?.crewId, decision.runId),
      createdAt: decision.createdAt,
      updatedAt: decision.createdAt,
      startedAt: null,
      finishedAt: decision.status === 'approval_required' ? null : decision.createdAt,
    })
  }
  for (const artifact of snapshot.artifacts) {
    const run = runs.get(artifact.crewRunId)
    entries.push({
      id: sourceId('delivery', `crew_artifact:${artifact.id}`),
      sourceKind: 'delivery',
      sourceId: `crew_artifact:${artifact.id}`,
      title: titleWithPrefix('Artifact', artifact.title),
      summary: null,
      status: 'delivered',
      sourceLabel: 'Crew artifact',
      owner: null,
      agents: [],
      capabilities: compactStrings([artifact.mime]),
      usage: emptyUsage(),
      riskLabels: [],
      governanceLabels: ['artifact'],
      reviewState: 'resolved',
      needsUserAttention: false,
      sourceRef: {
        kind: 'delivery',
        id: artifact.id,
        crewId: run?.crewId || null,
        crewRunId: artifact.crewRunId,
        crewNodeId: artifact.nodeId,
        artifactId: artifact.id,
      },
      route: crewRoute(run?.crewId, artifact.crewRunId),
      createdAt: artifact.createdAt,
      updatedAt: artifact.createdAt,
      startedAt: null,
      finishedAt: artifact.createdAt,
    })
  }
  return entries
}

function channelEntries(snapshot: ChannelListPayload): WorkLedgerUpsertInput[] {
  const entries: WorkLedgerUpsertInput[] = []
  const channels = new Map(snapshot.channels.map((channel) => [channel.id, channel]))
  for (const item of snapshot.inboundItems) entries.push(channelInboundEntry(item, channels.get(item.channelId)?.name || 'Channel event'))
  for (const delivery of snapshot.deliveries) entries.push(channelDeliveryEntry(delivery, channels.get(delivery.channelId)?.name || 'Channel delivery'))
  return entries
}

function channelInboundEntry(item: ChannelInboundItem, sourceLabel: string): WorkLedgerUpsertInput {
  const status = item.status as WorkLedgerStatus
  return {
    id: sourceId('channel_event', `channel_inbound:${item.id}`),
    sourceKind: 'channel_event',
    sourceId: `channel_inbound:${item.id}`,
    title: item.subject || `${item.provider} inbound message`,
    summary: null,
    status,
    sourceLabel,
    owner: item.sender,
    agents: [],
    capabilities: item.allowedCapabilityIds,
    usage: emptyUsage(),
    riskLabels: item.status === 'denied' || item.status === 'failed' ? [item.auditState] : [],
    governanceLabels: compactStrings([item.auditState, item.route.activationMode]),
    reviewState: item.status === 'needs_user' ? 'needs_review' : reviewFromStatus(status),
    needsUserAttention: item.status === 'needs_user' || item.status === 'failed',
    sourceRef: {
      kind: 'channel_event',
      id: item.id,
      channelId: item.channelId,
      channelEventId: item.id,
      deliveryId: item.deliveryRecordId,
    },
    route: channelRoute(item.channelId),
    createdAt: item.receivedAt,
    updatedAt: item.updatedAt,
    startedAt: null,
    finishedAt: item.status === 'dispatched' || item.status === 'failed' || item.status === 'denied' ? item.updatedAt : null,
  }
}

function channelDeliveryEntry(delivery: ChannelDeliveryRecord, sourceLabel: string): WorkLedgerUpsertInput {
  const status = delivery.status as WorkLedgerStatus
  return {
    id: sourceId('delivery', `channel_delivery:${delivery.id}`),
    sourceKind: 'delivery',
    sourceId: `channel_delivery:${delivery.id}`,
    title: titleWithPrefix('Delivery', delivery.title),
    summary: null,
    status,
    sourceLabel,
    owner: delivery.target,
    agents: [],
    capabilities: compactStrings([delivery.provider, ...delivery.artifactIds.map((id) => `artifact:${id}`)]),
    usage: emptyUsage(),
    riskLabels: delivery.status === 'failed' ? ['delivery_failed'] : [],
    governanceLabels: compactStrings([
      delivery.draftFirst ? 'draft-first' : null,
      delivery.runKind,
      ...delivery.policyDecisionIds.map((id) => `policy:${id}`),
    ]),
    reviewState: delivery.status === 'approval_required' ? 'approval_requested' : reviewFromStatus(status),
    needsUserAttention: delivery.status === 'approval_required' || delivery.status === 'failed',
    sourceRef: {
      kind: 'delivery',
      id: delivery.id,
      channelId: delivery.channelId,
      channelEventId: delivery.inboundItemId,
      deliveryId: delivery.id,
    },
    route: channelRoute(delivery.channelId),
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    startedAt: delivery.status === 'sending' ? delivery.updatedAt : null,
    finishedAt: delivery.status === 'delivered' || delivery.status === 'failed' || delivery.status === 'cancelled' ? delivery.updatedAt : null,
  }
}

function governanceEntries(events: GovernanceAuditEvent[]): WorkLedgerUpsertInput[] {
  return events.map((event) => {
    const status = mapGovernanceOutcome(event.outcome)
    return {
      id: sourceId('governance_incident', event.id),
      sourceKind: 'governance_incident',
      sourceId: event.id,
      title: `Governance: ${event.action.replaceAll('_', ' ')}`,
      summary: event.reason,
      status,
      sourceLabel: event.subjectKind,
      owner: event.actor.displayName,
      agents: event.subjectKind === 'agent' ? [event.subjectId] : [],
      capabilities: event.subjectKind === 'tool' ? [event.subjectId] : [],
      usage: emptyUsage(),
      riskLabels: event.outcome === 'failed' ? ['incident-control-failed'] : [],
      governanceLabels: compactStrings([event.kind, event.action, event.subjectKind, event.outcome]),
      reviewState: event.outcome === 'failed' ? 'failed' : 'resolved',
      needsUserAttention: event.outcome === 'failed',
      sourceRef: {
        kind: 'governance_incident',
        id: event.id,
        governanceAuditEventId: event.id,
      },
      route: governanceRoute(event.id),
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      startedAt: null,
      finishedAt: event.createdAt,
    }
  })
}

export function buildWorkLedgerEntriesFromSnapshot(snapshot: WorkLedgerSnapshot): WorkLedgerUpsertInput[] {
  return [
    ...threadEntries(snapshot.threads),
    ...automationEntries(snapshot.automations),
    ...crewEntries(snapshot.crews),
    ...channelEntries(snapshot.channels),
    ...governanceEntries(snapshot.governanceAuditEvents),
  ]
}

function loadAllIndexedThreads() {
  const service = getThreadIndexService()
  const threads: ThreadListItem[] = []
  let cursor: string | null = null
  do {
    const result = service.search({ limit: RECENT_THREAD_PAGE_LIMIT, cursor })
    threads.push(...result.threads)
    cursor = result.nextCursor
  } while (cursor)
  return threads
}

function loadDurableSnapshot(): WorkLedgerSnapshot {
  const runs = listCrewRunsForAudit()
  return {
    threads: loadAllIndexedThreads(),
    automations: listAutomationState(),
    crews: {
      catalog: listCrewCatalog(),
      runs,
      nodes: runs.flatMap((run) => listCrewRunNodes(run.id)),
      workItems: listCoworkWorkItems(),
      approvals: listCrewApprovalsForAudit(),
      policyDecisions: listPolicyDecisionsForAudit(),
      artifacts: runs.flatMap((run) => listCrewArtifactsForRun(run.id)),
    },
    channels: listChannelState(),
    governanceAuditEvents: listGovernanceAuditEvents({ limit: RECENT_GOVERNANCE_AUDIT_LIMIT }),
  }
}

export class WorkLedgerService {
  private lastRefreshAt = 0
  private readonly store: WorkLedgerStore
  private readonly loadSnapshot: WorkLedgerSnapshotLoader

  constructor(store: WorkLedgerStore = getWorkLedgerStore(), options: { loadSnapshot?: WorkLedgerSnapshotLoader } = {}) {
    this.store = store
    this.loadSnapshot = options.loadSnapshot || loadDurableSnapshot
  }

  reindex() {
    const snapshot = this.loadSnapshot()
    const entries = this.store.upsertEntries(buildWorkLedgerEntriesFromSnapshot(snapshot))
    this.store.deleteEntriesNotIn(entries.map((entry) => entry.id))
    this.lastRefreshAt = Date.now()
    return true
  }

  private ensureFresh() {
    if (Date.now() - this.lastRefreshAt < LEDGER_REFRESH_TTL_MS) return
    try {
      this.reindex()
    } catch (err) {
      log('work-ledger', `Reindex failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  search(query?: WorkLedgerSearchQuery) {
    this.ensureFresh()
    return this.store.searchEntries(normalizeWorkLedgerSearchQuery(query))
  }

  facets(query?: WorkLedgerSearchQuery) {
    this.ensureFresh()
    return this.store.listFacets(normalizeWorkLedgerSearchQuery(query))
  }
}

let workLedgerService: WorkLedgerService | null = null

export function getWorkLedgerService() {
  if (!workLedgerService) workLedgerService = new WorkLedgerService()
  return workLedgerService
}

export function clearWorkLedgerServiceCache() {
  workLedgerService = null
}
