import type {
  AutomationDeliveryRecord,
  AutomationInboxItem,
  AutomationListPayload,
  AutomationRun,
  AutomationSummary,
  AutomationWorkItem,
} from '@open-cowork/shared'
import { formatSchedule, formatStatus, formatTimestamp, summarizeWorkItems } from './automations-page-support'

export type AutomationColumnId =
  | 'draft'
  | 'planning'
  | 'needs-review'
  | 'ready-running'
  | 'delivered'
  | 'paused'

export type AutomationDropActionType =
  | 'previewBrief'
  | 'approveBrief'
  | 'runNow'
  | 'pause'
  | 'resume'

export type AutomationDropAction =
  | {
      valid: true
      automationId: string
      type: AutomationDropActionType
      targetColumn: AutomationColumnId
      title: string
      message: string
      confirm: boolean
    }
  | {
      valid: false
      automationId: string
      targetColumn: AutomationColumnId
      message: string
    }

export type AutomationCardModel = {
  automation: AutomationSummary
  columnId: AutomationColumnId
  inbox: AutomationInboxItem[]
  workItems: AutomationWorkItem[]
  runs: AutomationRun[]
  deliveries: AutomationDeliveryRecord[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
  latestDelivery: AutomationDeliveryRecord | null
  inboxCount: number
  hasApproval: boolean
  hasBlockingInbox: boolean
  workProgress: {
    total: number
    completed: number
    ready: number
    running: number
    blocked: number
    failed: number
  }
  scheduleLabel: string
  latestActivityLabel: string
}

export type AutomationColumn = {
  id: AutomationColumnId
  title: string
  description: string
  cards: AutomationCardModel[]
}

export const AUTOMATION_COLUMNS: Array<Omit<AutomationColumn, 'cards'>> = [
  {
    id: 'draft',
    title: 'Backlog',
    description: 'New programs that still need an execution brief.',
  },
  {
    id: 'planning',
    title: 'Planning',
    description: 'Cowork is enriching or supervising the work.',
  },
  {
    id: 'needs-review',
    title: 'Needs Review',
    description: 'Approvals, clarifications, or failures need attention.',
  },
  {
    id: 'ready-running',
    title: 'Ready / Running',
    description: 'Approved work that is ready or executing.',
  },
  {
    id: 'delivered',
    title: 'Delivered',
    description: 'Recent output is ready to review.',
  },
  {
    id: 'paused',
    title: 'Paused',
    description: 'Paused, failed, or archived programs.',
  },
]

const COLUMN_TITLES = new Map(AUTOMATION_COLUMNS.map((column) => [column.id, column.title]))

function byAutomationId<T extends { automationId: string }>(items: T[], automationId: string) {
  return items.filter((item) => item.automationId === automationId)
}

function latest<T extends { createdAt: string }>(items: T[]) {
  return items[0] || null
}

function getActiveRun(runs: AutomationRun[]) {
  return runs.find((run) => run.status === 'queued' || run.status === 'running') || null
}

function hasBlockingInboxItem(items: AutomationInboxItem[]) {
  return items.some((item) => item.type === 'approval' || item.type === 'clarification' || item.type === 'failure')
}

function resolveColumn(input: {
  automation: AutomationSummary
  inbox: AutomationInboxItem[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
  latestDelivery: AutomationDeliveryRecord | null
}): AutomationColumnId {
  const { automation, inbox, activeRun, latestRun, latestDelivery } = input
  if (automation.status === 'paused' || automation.status === 'failed' || automation.status === 'archived') return 'paused'
  if (automation.status === 'needs_user' || hasBlockingInboxItem(inbox)) return 'needs-review'
  if (activeRun?.kind === 'enrichment' || activeRun?.kind === 'heartbeat' || automation.status === 'enriching') return 'planning'
  if (automation.status === 'ready' || automation.status === 'running' || activeRun?.kind === 'execution') return 'ready-running'
  if (automation.status === 'completed' || latestDelivery || latestRun?.status === 'completed') return 'delivered'
  return 'draft'
}

export function buildAutomationCardModel(payload: AutomationListPayload, automation: AutomationSummary): AutomationCardModel {
  const inbox = byAutomationId(payload.inbox, automation.id)
  const workItems = byAutomationId(payload.workItems, automation.id)
  const runs = byAutomationId(payload.runs, automation.id)
  const deliveries = byAutomationId(payload.deliveries, automation.id)
  const activeRun = getActiveRun(runs)
  const latestRun = latest(runs)
  const latestDelivery = latest(deliveries)
  const columnId = resolveColumn({ automation, inbox, activeRun, latestRun, latestDelivery })
  return {
    automation,
    columnId,
    inbox,
    workItems,
    runs,
    deliveries,
    activeRun,
    latestRun,
    latestDelivery,
    inboxCount: inbox.length,
    hasApproval: inbox.some((item) => item.type === 'approval'),
    hasBlockingInbox: hasBlockingInboxItem(inbox),
    workProgress: summarizeWorkItems(workItems),
    scheduleLabel: formatSchedule(automation.schedule),
    latestActivityLabel: latestRun
      ? `${formatStatus(latestRun.status)} ${latestRun.kind} · ${formatTimestamp(latestRun.createdAt, '')}`
      : automation.nextRunAt
        ? `Next ${formatTimestamp(automation.nextRunAt, '')}`
        : 'No runs yet',
  }
}

export function buildAutomationBoard(payload: AutomationListPayload): AutomationColumn[] {
  const cards = payload.automations.map((automation) => buildAutomationCardModel(payload, automation))
  return AUTOMATION_COLUMNS.map((column) => ({
    ...column,
    cards: cards.filter((card) => card.columnId === column.id),
  }))
}

export function summarizeAutomationBoard(payload: AutomationListPayload) {
  const cards = payload.automations.map((automation) => buildAutomationCardModel(payload, automation))
  return {
    active: cards.filter((card) => card.automation.status !== 'archived').length,
    needsReview: cards.filter((card) => card.columnId === 'needs-review').length,
    running: cards.filter((card) => card.activeRun).length,
    delivered: cards.filter((card) => card.columnId === 'delivered').length,
  }
}

export function resolveAutomationDropAction(
  card: AutomationCardModel,
  targetColumn: AutomationColumnId,
): AutomationDropAction {
  const automationId = card.automation.id
  const targetTitle = COLUMN_TITLES.get(targetColumn) || 'that column'
  if (targetColumn === card.columnId) {
    return {
      valid: false,
      automationId,
      targetColumn,
      message: `${card.automation.title} is already in ${targetTitle}.`,
    }
  }
  if (card.automation.status === 'archived') {
    return {
      valid: false,
      automationId,
      targetColumn,
      message: 'Archived automations cannot be moved. Create a new automation if you want to run this program again.',
    }
  }
  if (targetColumn === 'planning' && card.columnId === 'draft') {
    return {
      valid: true,
      automationId,
      targetColumn,
      type: 'previewBrief',
      title: 'Preview execution brief',
      message: `Start planning ${card.automation.title} by asking OpenCode plan to create an execution brief.`,
      confirm: false,
    }
  }
  if (targetColumn === 'ready-running' && card.columnId === 'needs-review' && card.hasApproval) {
    return {
      valid: true,
      automationId,
      targetColumn,
      type: 'approveBrief',
      title: 'Approve execution brief',
      message: `Approve the brief for ${card.automation.title} so it can move into ready work.`,
      confirm: true,
    }
  }
  if (targetColumn === 'ready-running' && card.columnId === 'delivered') {
    return {
      valid: true,
      automationId,
      targetColumn,
      type: 'runNow',
      title: 'Run automation now',
      message: `Start a new execution run for ${card.automation.title}.`,
      confirm: true,
    }
  }
  if (targetColumn === 'ready-running' && card.automation.status === 'paused') {
    return {
      valid: true,
      automationId,
      targetColumn,
      type: 'resume',
      title: 'Resume automation',
      message: `Resume ${card.automation.title} so scheduled work can continue.`,
      confirm: true,
    }
  }
  if (targetColumn === 'paused' && card.automation.status !== 'paused') {
    return {
      valid: true,
      automationId,
      targetColumn,
      type: 'pause',
      title: 'Pause automation',
      message: `Pause ${card.automation.title}. Active or scheduled work will stop until you resume it.`,
      confirm: true,
    }
  }
  return {
    valid: false,
    automationId,
    targetColumn,
    message: `That move is not a direct lifecycle action. Open the card and use the focused action buttons for ${targetTitle}.`,
  }
}
