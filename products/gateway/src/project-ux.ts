import { buildNeedsAttentionReport } from './human-loop.js'
import {
  appendWorkEvent,
  listHumanGates,
  listRoadmapCompletionProposals,
  listWorkEvents,
  loadWorkState,
  resolveProjectContext,
  summarizeWorkTasks,
  updateRoadmapSupervisor,
  type ProjectContextResolution,
  type WorkEventRecord,
  type WorkState,
} from './work-store.js'

export interface ProjectContextInput {
  alias?: string
  roadmapId?: string
  provider?: string
  chatId?: string
  threadId?: string
  sessionId?: string
}

export interface ProjectStatusData {
  resolution: ProjectContextResolution
  counts?: ReturnType<typeof summarizeWorkTasks>
  blockedTasks?: Array<{ id: string; title: string; note?: string }>
  pendingGates?: number
  pendingCompletionProposals?: number
  attentionItems?: number
  notificationBindings?: Array<{ id: string; alias: string; provider?: string; chatId?: string; notificationMode: string }>
}

export interface ProjectDigestData {
  resolution: ProjectContextResolution
  events: WorkEventRecord[]
}

export interface ProjectReviewRequestResult {
  resolution: ProjectContextResolution
  queued: boolean
  reason: string
  supervisorId?: string
  nextReviewAt?: string
}

export function getProjectStatus(input: ProjectContextInput, state: WorkState = loadWorkState()): ProjectStatusData {
  const resolution = resolveProjectContext(input)
  if (resolution.status !== 'resolved' || !resolution.roadmap) return { resolution }
  const roadmapId = resolution.roadmap.id
  const tasks = state.tasks.filter(task => task.roadmapId === roadmapId)
  const gates = listHumanGates({ roadmapId, status: 'open' })
  const proposals = listRoadmapCompletionProposals({ roadmapId, status: 'open' })
  const attention = buildNeedsAttentionReport({ state }).projects.find(project => project.roadmapId === roadmapId)
  return {
    resolution,
    counts: summarizeWorkTasks(tasks),
    blockedTasks: tasks.filter(task => task.status === 'blocked').slice(0, 6).map(task => ({ id: task.id, title: task.title, note: task.note })),
    pendingGates: gates.length,
    pendingCompletionProposals: proposals.length,
    attentionItems: attention?.items.length || 0,
    notificationBindings: state.projectBindings.filter(binding => binding.roadmapId === roadmapId).map(binding => ({ id: binding.id, alias: binding.alias, provider: binding.provider, chatId: binding.chatId, notificationMode: binding.notificationMode })),
  }
}

export function formatProjectStatus(data: ProjectStatusData): string {
  const resolution = data.resolution
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(binding => `- ${binding.alias} -> ${binding.roadmapId} (${binding.scope})`).join('\n')}`
  if (resolution.status === 'not_found') return `${resolution.reason}\nUse /project bind <alias> <roadmapId> or /project create <alias> [title].`
  const roadmap = resolution.roadmap!
  const supervisor = resolution.supervisor
  const counts = data.counts
  const lines = [
    `Project: ${resolution.binding?.alias || roadmap.title}`,
    `Project record: ${roadmap.title} (${roadmap.id}) status=${roadmap.status} priority=${roadmap.priority}`,
    counts ? `Issues: ${counts.pending} pending, ${counts.running} running, ${counts.done} done, ${counts.blocked} blocked, ${counts.paused} paused` : '',
    `Blocked: ${data.blockedTasks?.length || 0}; gates: ${data.pendingGates || 0}; completion proposals: ${data.pendingCompletionProposals || 0}; attention: ${data.attentionItems || 0}`,
    supervisor ? `Supervisor: ${supervisor.supervisorId} status=${supervisor.status} Session=${supervisor.sessionId}` : 'Supervisor: none',
    supervisor?.lastReviewAt ? `Last review: ${supervisor.lastReviewAt}` : 'Last review: never',
    supervisor?.nextReviewAt ? `Next review: ${supervisor.nextReviewAt}` : 'Next review: not scheduled',
    data.notificationBindings?.length ? `Notifications: ${data.notificationBindings.map(binding => `${binding.alias}:${binding.notificationMode}`).join(', ')}` : 'Notifications: no project surfaces bound',
  ].filter(Boolean)
  for (const task of data.blockedTasks || []) lines.push(`- Blocked: ${task.title} (${task.id})${task.note ? `: ${task.note}` : ''}`)
  lines.push(`Resolved by: ${resolution.reason}`)
  return lines.join('\n')
}

export function getProjectDigest(input: ProjectContextInput, state: WorkState = loadWorkState(), limit = 20): ProjectDigestData {
  const resolution = resolveProjectContext(input)
  if (resolution.status !== 'resolved' || !resolution.roadmap) return { resolution, events: [] }
  const roadmapId = resolution.roadmap.id
  const tasks = new Set(state.tasks.filter(task => task.roadmapId === roadmapId).map(task => task.id))
  const events = listWorkEvents(300).filter(event => event.subjectId === roadmapId || (event.subjectId && tasks.has(event.subjectId)) || event.payload?.['roadmapId'] === roadmapId).slice(-limit)
  return { resolution, events }
}

export function formatProjectDigest(data: ProjectDigestData): string {
  const resolution = data.resolution
  if (resolution.status !== 'resolved' || !resolution.roadmap) return formatProjectStatus({ resolution })
  const lines = [`Project digest: ${resolution.binding?.alias || resolution.roadmap.title}`, `Project record: ${resolution.roadmap.title} (${resolution.roadmap.id}) status=${resolution.roadmap.status}`]
  if (!data.events.length) lines.push('No recent project events.')
  for (const event of data.events.slice(-12)) lines.push(`- #${event.id} ${event.createdAt} ${event.type}${event.subjectId ? ` ${event.subjectId}` : ''}`)
  lines.push('Commands: /project status | /project review-now | /attention')
  return lines.join('\n')
}

export function requestProjectReview(input: ProjectContextInput): ProjectReviewRequestResult {
  const resolution = resolveProjectContext(input)
  if (resolution.status !== 'resolved' || !resolution.roadmap) return { resolution, queued: false, reason: resolution.reason }
  const supervisor = resolution.supervisor
  if (!supervisor) return { resolution, queued: false, reason: 'No active supervisor for this project.' }
  if (supervisor.wakeLeaseOwner) return { resolution, queued: false, reason: 'Supervisor review is already running.', supervisorId: supervisor.supervisorId, nextReviewAt: supervisor.nextReviewAt }
  const now = new Date().toISOString()
  const due = Date.parse(supervisor.nextReviewAt || '') <= Date.parse(now)
  if (due) return { resolution, queued: false, reason: 'Supervisor review is already queued.', supervisorId: supervisor.supervisorId, nextReviewAt: supervisor.nextReviewAt }
  updateRoadmapSupervisor(supervisor.supervisorId, { nextReviewAt: now })
  appendWorkEvent('roadmap.supervisor.review_requested', resolution.roadmap.id, { supervisorId: supervisor.supervisorId, requestedBy: 'project_ux' })
  return { resolution, queued: true, reason: 'Supervisor review queued.', supervisorId: supervisor.supervisorId, nextReviewAt: now }
}
