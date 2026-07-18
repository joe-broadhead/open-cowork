import { buildNeedsAttentionReport, type NeedsAttentionReport } from './human-loop.js'
import type { PendingPermissionRequest, PendingQuestionRequest } from './opencode-requests.js'
import {
  calculateTaskReadiness,
  listAlerts,
  listHumanGates,
  listSupervisorWakeupReceipts,
  listWorkEvents,
  listWorkTaskViews,
  loadWorkState,
  type AlertRecord,
  type HumanGateRecord,
  type RoadmapCompletionProposalRecord,
  type RunRecord,
  type SupervisorWakeupReceiptRecord,
  type WorkEventRecord,
  type WorkState,
  type WorkTaskView,
} from './work-store.js'

export interface BriefingLinkMap {
  [key: string]: string
}

export interface BriefingItem {
  id: string
  kind: string
  title: string
  status?: string
  summary: string
  action?: string
  links: BriefingLinkMap
  updatedAt?: string
  evidence?: string[]
}

export interface MainAgentBriefing {
  generatedAt: string
  summary: string
  counts: {
    changedWork: number
    activeRuns: number
    blockedIssues: number
    gates: number
    questions: number
    permissions: number
    recentCompletions: number
    delegatedWork: number
    teamProgress: number
    alerts: number
    supervisorReceipts: number
  }
  changedWork: BriefingItem[]
  activeRuns: BriefingItem[]
  blockedIssues: BriefingItem[]
  gates: BriefingItem[]
  openCodeRequests: BriefingItem[]
  recentCompletions: BriefingItem[]
  delegatedWork: BriefingItem[]
  teamProgress: BriefingItem[]
  alerts: BriefingItem[]
  supervisorReceipts: BriefingItem[]
  recommendedNextActions: BriefingItem[]
  attention: NeedsAttentionReport
  links: BriefingLinkMap
}

export interface MainAgentBriefingOptions {
  state?: WorkState
  questions?: PendingQuestionRequest[]
  permissions?: PendingPermissionRequest[]
  now?: number
  limit?: number
  filePath?: string
}

const DEFAULT_LIMIT = 8

export function buildMainAgentBriefing(options: MainAgentBriefingOptions = {}): MainAgentBriefing {
  const now = options.now || Date.now()
  const limit = Math.max(1, Math.min(options.limit || DEFAULT_LIMIT, 25))
  const state = options.state || loadWorkState(options.filePath)
  const tasks = listWorkTaskViews(state)
  const gates = listHumanGates({ status: 'open' }, options.filePath)
  const alerts = listAlerts({ status: 'open' }, options.filePath)
  const questions = options.questions || []
  const permissions = options.permissions || []
  const receipts = listSupervisorWakeupReceipts({ limit: Math.max(limit, 12) }, options.filePath)
  const events = listWorkEvents(Math.max(100, limit * 12), options.filePath)
  const attention = buildNeedsAttentionReport({ state, gates, questions, permissions, now })

  const changedWork = recentChangedWork(events, state, tasks, limit)
  const activeRuns = state.runs.filter(run => run.status === 'running').slice(-limit).reverse().map(run => runItem(run, state, 'Active run', `Inspect session ${run.sessionId}; renew, retry, or block the task if stale.`))
  const blockedIssues = tasks.filter(task => isBlockedTask(task, state, now)).slice(0, limit).map(task => blockedTaskItem(task, state, now))
  const gateItems = gates.slice(0, limit).map(gate => gateItem(gate, state))
  const requestItems = [
    ...questions.slice(0, limit).map(questionItem),
    ...permissions.slice(0, limit).map(permissionItem),
  ].slice(0, limit)
  const completions = recentCompletionItems(state, events, limit)
  const delegated = recentDelegatedItems(events, limit)
  const teamProgress = recentTeamProgressItems(events, limit)
  const alertItems = alerts.slice(0, limit).map(alertItem)
  const receiptItems = receipts.slice(0, limit).map(receiptItem)
  const recommended = recommendedActions({ attention, alerts, receipts, activeRuns, blockedIssues, gateItems, requestItems, completions, changedWork, limit })

  const counts = {
    changedWork: changedWork.length,
    activeRuns: state.runs.filter(run => run.status === 'running').length,
    blockedIssues: tasks.filter(task => isBlockedTask(task, state, now)).length,
    gates: gates.length,
    questions: questions.length,
    permissions: permissions.length,
    recentCompletions: completions.length,
    delegatedWork: delegated.length,
    teamProgress: teamProgress.length,
    alerts: alerts.length,
    supervisorReceipts: receipts.length,
  }

  return {
    generatedAt: new Date(now).toISOString(),
    summary: briefingSummary(counts),
    counts,
    changedWork,
    activeRuns,
    blockedIssues,
    gates: gateItems,
    openCodeRequests: requestItems,
    recentCompletions: completions,
    delegatedWork: delegated,
    teamProgress,
    alerts: alertItems,
    supervisorReceipts: receiptItems,
    recommendedNextActions: recommended,
    attention,
    links: {
      dashboard: '/dashboard',
      tasks: '/tasks',
      runs: '/runs',
      events: '/events?limit=100',
      gates: '/human-gates?status=open',
      alerts: '/alerts',
      questions: '/questions',
      permissions: '/permissions',
    },
  }
}

export function formatMainAgentBriefing(briefing: MainAgentBriefing): string {
  const lines = [
    '# Gateway Briefing',
    '',
    `Generated: ${briefing.generatedAt}`,
    `Summary: ${briefing.summary}`,
    '',
    `Counts: ${briefing.counts.changedWork} changed | ${briefing.counts.activeRuns} active runs | ${briefing.counts.blockedIssues} blocked | ${briefing.counts.gates} gates | ${briefing.counts.questions} questions | ${briefing.counts.permissions} permissions | ${briefing.counts.alerts} alerts`,
  ]
  appendSection(lines, 'Recommended Next Actions', briefing.recommendedNextActions)
  appendSection(lines, 'Changed Work', briefing.changedWork)
  appendSection(lines, 'Active Runs', briefing.activeRuns)
  appendSection(lines, 'Blocked Issues', briefing.blockedIssues)
  appendSection(lines, 'Gates And Requests', [...briefing.gates, ...briefing.openCodeRequests])
  appendSection(lines, 'Recent Completions', briefing.recentCompletions)
  appendSection(lines, 'Delegated Work', briefing.delegatedWork)
  appendSection(lines, 'Team Progress', briefing.teamProgress)
  appendSection(lines, 'Alerts', briefing.alerts)
  appendSection(lines, 'Supervisor Receipts', briefing.supervisorReceipts)
  lines.push('', `Inspect: ${Object.entries(briefing.links).map(([key, value]) => `${key}=${value}`).join(' | ')}`)
  return lines.join('\n')
}

function appendSection(lines: string[], title: string, items: BriefingItem[]): void {
  lines.push('', `## ${title}`)
  if (!items.length) {
    lines.push('None.')
    return
  }
  for (const item of items) {
    lines.push(`- [${item.status || item.kind}] ${item.title} (${item.id})`)
    lines.push(`  Summary: ${item.summary}`)
    if (item.action) lines.push(`  Next: ${item.action}`)
    const links = Object.entries(item.links || {})
    if (links.length) lines.push(`  Links: ${links.map(([key, value]) => `${key}=${value}`).join(' | ')}`)
  }
}

function recentChangedWork(events: WorkEventRecord[], state: WorkState, tasks: WorkTaskView[], limit: number): BriefingItem[] {
  return events
    .filter(event => event.type.startsWith('task.') || event.type.startsWith('roadmap.') || event.type.startsWith('human_gate.') || event.type.startsWith('alert.'))
    .slice(-limit)
    .reverse()
    .map(event => eventItem(event, state, tasks))
}

function eventItem(event: WorkEventRecord, state: WorkState, tasks: WorkTaskView[]): BriefingItem {
  const task = event.subjectId ? tasks.find(row => row.id === event.subjectId) : undefined
  const roadmapId = roadmapIdForEvent(event, state, task)
  return {
    id: `event:${event.id}`,
    kind: 'event',
    title: event.type,
    status: event.type,
    summary: eventSummary(event, task),
    action: actionForEvent(event),
    links: compactLinks({ event: `/events?limit=100`, task: task ? `/tasks/${task.id}` : undefined, roadmap: roadmapId ? `/roadmaps/${roadmapId}` : undefined }),
    updatedAt: event.createdAt,
    evidence: [`event:${event.id}`, event.subjectId ? `subject:${event.subjectId}` : 'subject:none'],
  }
}

function runItem(run: RunRecord, state: WorkState, title: string, action: string): BriefingItem {
  const task = state.tasks.find(row => row.id === run.taskId)
  return {
    id: run.id,
    kind: 'run',
    title: `${title}: ${run.stage}${task ? ` on ${task.title}` : ''}`,
    status: run.status,
    summary: `Session ${run.sessionId}, profile ${run.resolvedProfile || run.profile}, attempt ${run.attempt}.`,
    action,
    links: compactLinks({ run: `/runs/${run.id}`, task: `/tasks/${run.taskId}`, session: `/opencode/sessions/${run.sessionId}`, roadmap: task ? `/roadmaps/${task.roadmapId}` : undefined }),
    updatedAt: run.completedAt || run.startedAt,
  }
}

function blockedTaskItem(task: WorkTaskView, state: WorkState, now: number): BriefingItem {
  const readiness = task.readiness || calculateTaskReadiness(task, state, now)
  return {
    id: task.id,
    kind: 'issue',
    title: task.title,
    status: task.status,
    summary: task.note || readiness.reason,
    action: task.status === 'paused' ? `Resume or cancel task ${task.id}.` : `Resolve blocker, retry, or cancel task ${task.id}.`,
    links: compactLinks({ task: `/tasks/${task.id}`, roadmap: `/roadmaps/${task.roadmapId}`, readiness: `/tasks/${task.id}/readiness` }),
    updatedAt: task.updatedAt,
    evidence: readiness.blockers,
  }
}

function gateItem(gate: HumanGateRecord, state: WorkState): BriefingItem {
  const task = gate.taskId ? state.tasks.find(row => row.id === gate.taskId) : undefined
  return {
    id: gate.id,
    kind: 'gateway_gate',
    title: `${gate.type}${task ? ` for ${task.title}` : ''}`,
    status: gate.status,
    summary: gate.reason,
    action: `Approve or reject gate ${gate.id}.`,
    links: compactLinks({ gate: `/human-gates/${gate.id}`, task: gate.taskId ? `/tasks/${gate.taskId}` : undefined, roadmap: gate.roadmapId ? `/roadmaps/${gate.roadmapId}` : undefined, run: gate.runId ? `/runs/${gate.runId}` : undefined }),
    updatedAt: gate.updatedAt || gate.requestedAt,
  }
}

function questionItem(question: PendingQuestionRequest): BriefingItem {
  const prompt = question.questions?.[0]
  return {
    id: question.id,
    kind: 'opencode_question',
    title: prompt?.header || 'OpenCode question',
    status: 'pending',
    summary: prompt?.question || 'Question pending.',
    action: `Answer or reject OpenCode question ${question.id}.`,
    links: compactLinks({ question: `/questions/${question.id}`, session: `/opencode/sessions/${question.sessionID}` }),
  }
}

function permissionItem(permission: PendingPermissionRequest): BriefingItem {
  return {
    id: permission.id,
    kind: 'opencode_permission',
    title: permission.permission,
    status: 'pending',
    summary: permission.patterns?.length ? permission.patterns.join(', ') : 'Permission pending.',
    action: `Approve once, approve always, or reject permission ${permission.id}.`,
    links: compactLinks({ permission: `/permissions/${permission.id}`, session: `/opencode/sessions/${permission.sessionID}` }),
  }
}

function recentCompletionItems(state: WorkState, events: WorkEventRecord[], limit: number): BriefingItem[] {
  const runCompletions = state.runs
    .filter(run => run.completedAt && ['passed', 'blocked', 'failed', 'errored'].includes(run.status))
    .slice(-limit)
    .reverse()
    .map(run => runItem(run, state, 'Recent run', run.status === 'passed' ? 'Use the result evidence or continue the next stage.' : 'Inspect the failed or blocked run.'))
  const proposalItems = state.completionProposals
    .slice(0, limit)
    .map(proposal => completionProposalItem(proposal, state))
  const manualDone = events
    .filter(event => event.type === 'task.done' || event.type === 'task.done.manual' || event.type === 'roadmap.completion.approved')
    .slice(-limit)
    .reverse()
    .map(event => eventItem(event, state, listWorkTaskViews(state)))
  return dedupeItems([...proposalItems, ...runCompletions, ...manualDone], limit)
}

function completionProposalItem(proposal: RoadmapCompletionProposalRecord, state: WorkState): BriefingItem {
  const roadmap = state.roadmaps.find(row => row.id === proposal.roadmapId)
  return {
    id: proposal.id,
    kind: 'completion_proposal',
    title: `Completion proposal for ${roadmap?.title || proposal.roadmapId}`,
    status: proposal.status,
    summary: `${proposal.recommendation}${proposal.unresolvedRisks.length ? `; ${proposal.unresolvedRisks.length} unresolved risk(s)` : ''}`,
    action: proposal.status === 'pending' ? `Approve or reject completion proposal ${proposal.id}.` : 'No action required unless reopening work.',
    links: compactLinks({ proposal: `/roadmap-completion-proposals/${proposal.id}`, roadmap: `/roadmaps/${proposal.roadmapId}` }),
    updatedAt: proposal.updatedAt,
    evidence: proposal.evidence,
  }
}

function recentDelegatedItems(events: WorkEventRecord[], limit: number): BriefingItem[] {
  return events
    .filter(event => event.type === 'delegation.mapped' || event.type === 'delegation.progress')
    .slice(-limit)
    .reverse()
    .map(event => ({
      id: String(event.payload?.['progressKey'] || event.payload?.['idempotencyKey'] || `event:${event.id}`),
      kind: 'delegated_work',
      title: String(event.payload?.['progress'] || event.type),
      status: String(event.payload?.['progress'] || event.type),
      summary: String(event.payload?.['objective'] || event.payload?.['summary'] || event.payload?.['targetType'] || event.subjectId || 'Delegated work update'),
      action: delegatedAction(event),
      links: linkMapFromPayload(event.payload, { event: '/events?limit=100' }),
      updatedAt: event.createdAt,
      evidence: [`event:${event.id}`],
    }))
}

function recentTeamProgressItems(events: WorkEventRecord[], limit: number): BriefingItem[] {
  return events
    .filter(event => event.type.startsWith('team_assignment.briefing.'))
    .slice(-limit)
    .reverse()
    .map(event => ({
      id: String(event.payload?.['dedupeKey'] || `event:${event.id}`),
      kind: 'team_progress',
      title: String(event.payload?.['progress'] || event.type),
      status: `${event.payload?.['delivery'] || 'unknown'}/${event.payload?.['attention'] || 'monitor'}`,
      summary: teamProgressSummary(event),
      action: teamProgressAction(event),
      links: compactLinks({
        event: '/events?limit=100',
        teamAssignments: typeof event.payload?.['assignmentId'] === 'string' ? `/team-assignments/${event.payload['assignmentId']}` : '/team-assignments',
        task: typeof event.payload?.['taskId'] === 'string' ? `/tasks/${event.payload['taskId']}` : undefined,
        roadmap: typeof event.payload?.['roadmapId'] === 'string' ? `/roadmaps/${event.payload['roadmapId']}` : undefined,
        run: typeof event.payload?.['runId'] === 'string' ? `/runs/${event.payload['runId']}` : undefined,
      }),
      updatedAt: event.createdAt,
      evidence: [
        `event:${event.id}`,
        typeof event.payload?.['assignmentReceiptId'] === 'string' ? `receipt:${event.payload['assignmentReceiptId']}` : undefined,
        typeof event.payload?.['teamId'] === 'string' ? `team:${event.payload['teamId']}` : undefined,
        typeof event.payload?.['memberId'] === 'string' ? `member:${event.payload['memberId']}` : undefined,
      ].filter(Boolean) as string[],
    }))
}

function alertItem(alert: AlertRecord): BriefingItem {
  return {
    id: alert.id,
    kind: 'alert',
    title: alert.summary,
    status: `${alert.severity}/${alert.status}`,
    summary: alert.evidence.slice(0, 3).join('; ') || alert.source,
    action: alert.nextAction,
    links: compactLinks({ alert: `/alerts/${alert.id}`, target: alert.target ? targetLink(alert.target) : undefined }),
    updatedAt: alert.lastSeenAt,
    evidence: alert.evidence,
  }
}

function receiptItem(receipt: SupervisorWakeupReceiptRecord): BriefingItem {
  return {
    id: receipt.id,
    kind: 'supervisor_receipt',
    title: `${receipt.wakeReason} for ${receipt.roadmapId}`,
    status: receipt.status,
    summary: receipt.summary || receipt.reasonDetail,
    action: receipt.nextAction || receipt.recommendation || 'Inspect the supervisor receipt and latest roadmap state.',
    links: compactLinks({ supervisor: `/roadmap-supervisors/${receipt.supervisorId}`, roadmap: `/roadmaps/${receipt.roadmapId}`, events: '/events?limit=100' }),
    updatedAt: receipt.completedAt || receipt.updatedAt,
    evidence: [...receipt.inspectedInputs.slice(0, 8), ...receipt.changedObjectIds.slice(0, 8)],
  }
}

function recommendedActions(input: {
  attention: NeedsAttentionReport
  alerts: AlertRecord[]
  receipts: SupervisorWakeupReceiptRecord[]
  activeRuns: BriefingItem[]
  blockedIssues: BriefingItem[]
  gateItems: BriefingItem[]
  requestItems: BriefingItem[]
  completions: BriefingItem[]
  changedWork: BriefingItem[]
  limit: number
}): BriefingItem[] {
  const actions: BriefingItem[] = []
  for (const item of input.attention.items.slice(0, input.limit)) {
    actions.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: item.severity,
      summary: item.summary,
      action: item.action,
      links: compactLinks({ task: item.taskId ? `/tasks/${item.taskId}` : undefined, roadmap: item.roadmapId ? `/roadmaps/${item.roadmapId}` : undefined, run: item.runId ? `/runs/${item.runId}` : undefined, gate: item.gateId ? `/human-gates/${item.gateId}` : undefined, session: item.sessionId ? `/opencode/sessions/${item.sessionId}` : undefined }),
      updatedAt: item.createdAt,
    })
  }
  if (!actions.length) {
    const receipt = input.receipts.find(row => row.nextAction || row.recommendation)
    if (receipt) actions.push(receiptItem(receipt))
  }
  if (!actions.length && input.alerts.length) actions.push(alertItem(input.alerts[0]!))
  if (!actions.length && input.activeRuns.length) actions.push(input.activeRuns[0]!)
  if (!actions.length && input.completions.some(item => item.status === 'pending')) actions.push(input.completions.find(item => item.status === 'pending')!)
  if (!actions.length) {
    actions.push({
      id: 'briefing:monitor',
      kind: 'monitor',
      title: 'Monitor Gateway work',
      status: 'ok',
      summary: input.changedWork.length ? 'Recent changes are available for review.' : 'No active Gateway work or human attention is pending.',
      action: input.changedWork.length ? 'Review changed work and continue the current plan.' : 'No immediate action required.',
      links: { dashboard: '/dashboard', tasks: '/tasks' },
    })
  }
  return dedupeItems(actions, input.limit)
}

function briefingSummary(counts: MainAgentBriefing['counts']): string {
  if (counts.alerts || counts.gates || counts.questions || counts.permissions || counts.blockedIssues) {
    return `${counts.alerts + counts.gates + counts.questions + counts.permissions + counts.blockedIssues} item(s) need attention; ${counts.activeRuns} active run(s).`
  }
  if (counts.activeRuns) return `${counts.activeRuns} active run(s); no blockers detected.`
  if (counts.recentCompletions) return `${counts.recentCompletions} recent completion(s); no blockers detected.`
  return 'No active Gateway work or human attention is pending.'
}

function isBlockedTask(task: WorkTaskView, state: WorkState, now: number): boolean {
  if (task.status === 'blocked' || task.status === 'paused') return true
  const readiness = task.readiness || calculateTaskReadiness(task, state, now)
  return readiness.status === 'blocked' || readiness.status === 'waiting'
}

function eventSummary(event: WorkEventRecord, task?: WorkTaskView): string {
  if (task) return `${task.title}: ${event.type}`
  if (typeof event.payload?.['summary'] === 'string') return event.payload['summary']
  if (typeof event.payload?.['title'] === 'string') return event.payload['title']
  if (typeof event.payload?.['note'] === 'string') return event.payload['note']
  return event.subjectId || 'Gateway workflow event'
}

function actionForEvent(event: WorkEventRecord): string | undefined {
  if (event.type.includes('blocked') || event.type.includes('failed')) return 'Inspect the referenced task/run and choose retry, block, or cancel.'
  if (event.type.includes('human_gate')) return 'Review the gate and decide approve or reject.'
  if (event.type.includes('completion')) return 'Review completion evidence and residual risk.'
  if (event.type.includes('wakeup')) return 'Inspect the supervisor receipt or latest roadmap state.'
  return undefined
}

function delegatedAction(event: WorkEventRecord): string {
  const progress = String(event.payload?.['progress'] || '')
  if (progress === 'blocked' || progress === 'failed') return 'Inspect delegated work and decide retry, unblock, or cancel.'
  if (progress === 'gate_opened' || progress === 'completion_proposed') return 'Review the pending approval or completion proposal.'
  if (progress === 'completed') return 'Fold the delegated result back into the parent session.'
  return 'Monitor delegated work progress.'
}

function teamProgressSummary(event: WorkEventRecord): string {
  const team = [event.payload?.['teamName'], event.payload?.['role']].filter(value => typeof value === 'string' && value).join('/')
  const gate = typeof event.payload?.['gateId'] === 'string' ? ` gate=${event.payload['gateId']}` : ''
  const evidence = typeof event.payload?.['evidenceStatus'] === 'string' ? ` evidence=${event.payload['evidenceStatus']}` : ''
  return `${team || event.payload?.['assignmentId'] || 'team assignment'} ${event.payload?.['progress'] || 'progress'}${gate}${evidence}`.trim()
}

function teamProgressAction(event: WorkEventRecord): string {
  const progress = String(event.payload?.['progress'] || '')
  if (progress === 'gate_waiting') return 'Review the assignment gate and record a durable gate receipt.'
  if (progress === 'blocked') return 'Resolve the blocker, then record a resumed gate or review receipt.'
  if (progress === 'failed') return 'Decide retry or replacement and preserve the failed assignment receipt.'
  if (progress === 'completed') return 'Fold assignment evidence back into parent work.'
  if (progress === 'scheduled_digest') return 'Review the team digest for stale gates or evidence.'
  return 'Monitor team assignment progress.'
}

function roadmapIdForEvent(event: WorkEventRecord, state: WorkState, task?: WorkTaskView): string | undefined {
  if (typeof event.payload?.['roadmapId'] === 'string') return event.payload['roadmapId']
  if (task) return task.roadmapId
  if (event.subjectId && state.roadmaps.some(row => row.id === event.subjectId)) return event.subjectId
  return undefined
}

function linkMapFromPayload(payload: Record<string, unknown>, fallback: BriefingLinkMap = {}): BriefingLinkMap {
  const links = payload?.['links'] && typeof payload['links'] === 'object' && !Array.isArray(payload['links']) ? payload['links'] as Record<string, unknown> : {}
  return compactLinks({
    ...fallback,
    roadmap: typeof payload?.['roadmapId'] === 'string' ? `/roadmaps/${payload['roadmapId']}` : stringLink(links['roadmap']),
    task: typeof payload?.['taskId'] === 'string' ? `/tasks/${payload['taskId']}` : stringLink(links['task']),
    supervisor: typeof payload?.['supervisorId'] === 'string' ? `/roadmap-supervisors/${payload['supervisorId']}` : stringLink(links['supervisor']),
    projectBinding: typeof payload?.['projectBindingId'] === 'string' ? `/project-bindings/${payload['projectBindingId']}` : stringLink(links['projectBinding']),
  })
}

function targetLink(target: string): string | undefined {
  if (target.startsWith('task_')) return `/tasks/${target}`
  if (target.startsWith('roadmap_')) return `/roadmaps/${target}`
  if (target.startsWith('run_')) return `/runs/${target}`
  return undefined
}

function stringLink(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function compactLinks(links: Record<string, string | undefined>): BriefingLinkMap {
  const result: BriefingLinkMap = {}
  for (const [key, value] of Object.entries(links)) if (value) result[key] = value
  return result
}

function dedupeItems(items: BriefingItem[], limit: number): BriefingItem[] {
  const seen = new Set<string>()
  const result: BriefingItem[] = []
  for (const item of items) {
    const key = `${item.kind}:${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}
