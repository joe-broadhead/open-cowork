import type { ChannelMessage } from './channels/provider.js'
import { getConfig, updateSchedulerConfig } from './config.js'
import { formatOpenCodeSessionLinks, formatOpenCodeUnavailableSessionLinks, gatewayLocalBaseUrl } from './opencode-web.js'
import { clearChannelSession, getChannelSession, listChannelSessions, setChannelSession, type ChannelSessionLink } from './channel-sessions.js'
import { getWorkQueueSnapshot, schedulerCycle } from './scheduler.js'
import { appendAuditEvent, appendWorkEvent, applyActiveRunControl, applyWorkTaskAction, createRoadmap, createRoadmapSupervisor, decideHumanGate, decideRoadmapCompletionProposal, getDefaultRoadmapSupervisor, getHumanGate, getRoadmapCompletionProposal, getRun, getWorkTask, listHumanGates, listRecentWorkEvents, listRoadmapCompletionProposals, listWorkTaskViews, loadWorkState, updateAlertStatus, updateRoadmapSupervisor, type HumanGateRecord, type ProjectNotificationMode, type RoadmapCompletionProposalRecord, type WorkTaskAction, type WorkTaskView } from './work-store.js'
import { getRunsForRoadmap, getRunsForTask } from './work-store/queries.js'
import { createSqliteWorkStoreBindingsPort } from './work-store/bindings-port.js'
import { normalizeProjectAlias } from './work-store/validators.js'
import { formatPermissionRequest, formatQuestionRequest, listPendingPermissions, listPendingQuestions, rejectQuestion, replyToPermission, replyToQuestion } from './opencode-requests.js'
import { buildGovernanceReport, formatGovernanceReport } from './governance.js'
import { buildNeedsAttentionReport, formatHumanGate, formatNeedsAttentionReport } from './human-loop.js'
import { formatAlerts, generateIncidentReport, runAlertEngine } from './alerts.js'
import { formatProjectDigest, formatProjectStatus, getProjectDigest, getProjectStatus, requestProjectReview } from './project-ux.js'
import { channelTargetFingerprint, isTrustedChannelActor, isTrustedChannelTarget, redactedChannelTargetLabel } from './security.js'
import { decideChannelCommandSecurityPolicy, summarizeSecurityPolicyDecision } from './security-policy.js'
import { channelActionMenuItems, formatChannelUxTruthForHelp } from './channel-actions.js'
import { channelActionDeniedDecision, type OperatorDecisionSummary } from './operator-decisions.js'
import {
  bindingMatches,
  channelPreTrustHelpText,
  cleanTitle,
  commandOperation,
  describeChannelBinding,
  displayBindingMode,
  formatChannelDecisionHint,
  formatCompletionProposal,
  formatProjectBinding,
  formatTaskSummary,
  gatewaySessionTitle,
  isActionDenial,
  isChannelCommandMenuRequest,
  isClockTime,
  isExpired,
  isPrivilegedChannelAction,
  parseChannelCommand,
  type ChannelCommandAction,
  type ParsedChannelCommand,
} from './channel-commands-helpers.js'

export type { ParsedChannelCommand, ChannelCommandAction } from './channel-commands-helpers.js'
export {
  parseChannelCommand,
  isChannelCommandMenuRequest,
  isPreTrustChannelCommandText,
  channelPreTrustHelpText,
  channelBindingSystemContext,
} from './channel-commands-helpers.js'

export interface ChannelCommandClient {
  session: {
    create(args: { body: { title: string } }): Promise<{ data?: any }>
    get(args: { path: { id: string } }): Promise<{ data?: any }>
    abort?(args: { path: { id: string } }): Promise<unknown>
  }
}

const PRIVILEGED_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const ACTION_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const CHANNEL_ACTION_RECEIPT_EVENT = 'channel.action.accepted'
const projectBindings = createSqliteWorkStoreBindingsPort()


export async function handleChannelCommand(client: ChannelCommandClient, msg: ChannelMessage): Promise<string | null> {
  const command = parseChannelCommand(msg.text)
  if (!command) return null
  const trusted = isTrustedCommandTarget(msg)
  if (!trusted && isChannelCommandMenuRequest(command.name)) return channelPreTrustHelpText()
  if (!trusted && command.name !== 'whereami') return `Channel target is not trusted: ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}`

  const privileged = isPrivilegedChannelAction(command)
  if (privileged) {
    const gate = preflightPrivilegedChannelAction(msg, command)
    if (gate) return gate
  }

  let reply: string
  switch (command.name) {
    case 'help':
    case 'start':
    case 'commands':
      reply = channelCommandHelpText()
      break
    case 'new':
      reply = await newSession(client, msg, command.rest)
      break
    case 'whereami':
      reply = whereami(msg)
      break
    case 'session':
      reply = await sessionCommand(client, msg, command.args)
      break
    case 'sessions':
      reply = await sessionCommand(client, msg, command.args)
      break
    case 'switch':
      reply = await switchSession(client, msg, command.args[0])
      break
    case 'bind':
      reply = await bindTarget(client, msg, command.args)
      break
    case 'unbind':
      reply = unbind(msg)
      break
    case 'status':
      reply = await status(client, msg)
      break
    case 'current':
      reply = await current(client, msg)
      break
    case 'open':
      reply = await openCommand(client, msg, command.args)
      break
    case 'latest':
      reply = await latest(client, msg)
      break
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'retry':
    case 'done':
    case 'block':
      reply = await boundTaskAction(client, msg, command.name, command.rest)
      break
    case 'tasks':
    case 'issues':
      reply = tasks()
      break
    case 'roadmaps':
    case 'initiatives':
      reply = roadmaps()
      break
    case 'project':
    case 'p':
      reply = await projectCommand(client, msg, command.args)
      break
    case 'digest':
      reply = await projectCommand(client, msg, ['digest', ...command.args])
      break
    case 'watch':
      reply = await projectCommand(client, msg, ['watch', ...command.args])
      break
    case 'unwatch':
      reply = await projectCommand(client, msg, ['unwatch', ...command.args])
      break
    case 'completion':
    case 'complete':
      reply = completionCommand(command.args, msg)
      break
    case 'task':
    case 'issue':
      reply = await taskCommand(client, msg, command.args)
      break
    case 'scheduler':
      reply = await schedulerCommand(client, command.args)
      break
    case 'governance':
    case 'budget':
      reply = formatGovernanceReport(buildGovernanceReport())
      break
    case 'attention':
    case 'needs-attention':
      reply = await needsAttention()
      break
    case 'gates':
      reply = gates()
      break
    case 'gate':
      reply = await gateCommand(command.args, msg)
      break
    case 'alerts':
      reply = await alerts()
      break
    case 'alert':
      reply = alertCommand(command.args, msg)
      break
    case 'incident':
      reply = generateIncidentReport(command.args[0])
      break
    case 'questions':
      reply = await questions()
      break
    case 'permissions':
      reply = await permissions()
      break
    case 'answer':
      reply = await answerQuestion(command.args, command.rest, msg)
      break
    case 'reject-question':
      reply = await rejectQuestionCommand(command.args[0], msg)
      break
    case 'approve':
      reply = await approvePermission(command.args, msg)
      break
    case 'deny':
      reply = await denyPermission(command.args[0], command.args.slice(1).join(' '), msg)
      break
    default:
      reply = `Unknown command: /${command.name}\n\n${channelCommandHelpText()}`
      break
  }
  if (privileged && !isActionDenial(reply)) recordPrivilegedChannelAction(msg, command)
  return reply
}

export function channelCommandHelpText(): string {
  return [
    'Gateway Command Center',
    '',
    'Start here:',
    '1. /whereami - confirm this channel is trusted and see what it is bound to',
    '2. /new [title] - create a fresh OpenCode Session from this chat',
    '3. /project create <alias> <title> - create a supervised Project',
    '4. /status - see queue health, current binding, and the next useful command',
    '5. /open - get Web, TUI, Mission Control, and evidence links',
    '',
    'Sessions:',
    '/session [list|select <sessionId>], /sessions, /switch <sessionId|projectAlias|roadmapId>',
    '/bind session <sessionId> [--rebind], /unbind',
    '',
    'Projects and Issues:',
    '/project <create|bind|status|digest|watch|unwatch|notify|quiet|review-now|complete|open|pause|resume|unbind> [alias]',
    '/p, /digest, /watch, /unwatch - project shortcuts',
    '/completion [list|approve|reject] [proposalId] [note]',
    '/bind project <alias> <roadmapId> [--rebind], /bind issue <taskId> [--rebind]',
    '/issues, /initiatives, /current, /latest, /pause, /resume, /retry, /done, /block, /cancel',
    '/issue <pause|resume|cancel|retry|done|block> <taskId> [note]',
    '',
    'Attention and governance:',
    '/attention, /gates, /gate <approve|reject> <gateId> [once|always] [note]',
    '/questions, /answer <questionId> <label>, /permissions, /approve <permissionId> [once|always], /deny <permissionId> [message]',
    '/alerts, /alert <ack|resolve|suppress> <alertId> [note], /incident [alertId]',
    '/scheduler <status|pause|resume|run>, /governance',
    '',
    ...formatChannelUxTruthForHelp(),
  ].join('\n')
}

export function channelCommandMenuActions(): ChannelCommandAction[] {
  return channelActionMenuItems()
}

async function newSession(client: ChannelCommandClient, msg: ChannelMessage, title: string): Promise<string> {
  const label = title || `${msg.provider}:${msg.chatId}`
  const created = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).createSession({ title: gatewaySessionTitle(msg, label) })
  const sessionId = created.id
  if (!sessionId) return 'Could not create an OpenCode Session.'

  setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'chat', title: label })
  const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(sessionId)
  const session = got.data
  const links = session ? formatOpenCodeSessionLinks(getConfig().opencodeUrl, session, { gatewayBaseUrl: configuredGatewayBaseUrl() }) : ''
  return [`Created and bound Session: ${sessionId}`, links].filter(Boolean).join('\n')
}

function whereami(msg: ChannelMessage): string {
  const trusted = isTrustedCommandTarget(msg)
  const lines = [
    `Channel target: ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}`,
    `Trust: ${trusted ? 'trusted' : 'untrusted'}`,
  ]
  if (!trusted) return lines.join('\n')

  const binding = currentBinding(msg)
  lines.push(binding ? `Bound Session: ${binding.sessionId} context=${displayBindingMode(binding.mode)}` : 'Bound Session: none')
  if (binding?.taskId) lines.push(`Issue: ${binding.taskId}`)
  if (binding?.roadmapId) lines.push(`Project ID: ${binding.roadmapId}`)

  const resolution = projectBindings.resolveProjectContext({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, sessionId: binding?.sessionId })
  if (resolution.status === 'resolved' && resolution.roadmap) {
    lines.push(`Project: ${resolution.binding?.alias || resolution.roadmap.title}`)
    lines.push(`Project record: ${resolution.roadmap.title} (${resolution.roadmap.id})`)
    if (resolution.supervisor) lines.push(`Supervisor Session: ${resolution.supervisor.sessionId}`)
    lines.push(`Notification mode: ${resolution.binding?.notificationMode || 'unbound'}`)
    lines.push(`Resolved by: ${resolution.reason}`)
  } else if (resolution.status === 'ambiguous') {
    lines.push(`Project context: ambiguous`)
    lines.push(resolution.reason)
    const candidates = (resolution.candidates || []).slice(0, 6).map(formatProjectBinding)
    if (candidates.length) lines.push('Candidates:', ...candidates)
    lines.push('Notification mode: unknown')
  } else {
    lines.push('Project context: none')
    lines.push(`Notification mode: ${binding ? 'unbound' : 'none'}`)
  }
  return lines.join('\n')
}

async function sessionCommand(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const action = args[0] || 'list'
  if (action === 'list' || action === 'recent') return listSessions(msg)
  if (action === 'select') return switchSession(client, msg, args[1])
  if (action.startsWith('ses_') || action) return switchSession(client, msg, action)
  return 'Usage: /session [list|select <sessionId>]'
}

function listSessions(msg: ChannelMessage): string {
  const rows = relevantSessionRows(msg)
  if (rows.length === 0) return 'No relevant Sessions found for this chat. Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId>.'
  return rows.map(row => {
    const parts = [row.sessionId, `source=${row.source}`]
    if (row.mode) parts.push(`context=${displayBindingMode(row.mode)}`)
    if (row.threadId) parts.push(`thread=${row.threadId}`)
    if (row.taskId) parts.push(`issue=${row.taskId}`)
    if (row.roadmapId) parts.push(`project=${row.roadmapId}`)
    if (row.title) parts.push(`title=${row.title}`)
    return parts.join(' ')
  }).join('\n')
}

async function switchSession(client: ChannelCommandClient, msg: ChannelMessage, sessionId?: string): Promise<string> {
  if (!sessionId) return 'Usage: /switch <sessionId>'
  const project = projectBindings.resolveProjectContext(projectIdentifierInput(sessionId))
  if (project.status === 'resolved' && project.roadmap) {
    const selection = await selectUsableProjectSession(client, msg, project.roadmap.title, project.binding?.sessionId, project.supervisor)
    if (!selection.sessionId) return 'No project assistant session is available for this project.'
    const binding = projectBindings.upsertProjectBinding({
      alias: project.binding?.alias || project.roadmap.title,
      roadmapId: project.roadmap.id,
      sessionId: selection.sessionId,
      provider: msg.provider,
      chatId: msg.chatId,
      threadId: msg.threadId,
      title: project.roadmap.title,
      allowRebind: true,
      notificationMode: project.binding?.notificationMode,
    })
    const links = await sessionLinksText(client, binding.sessionId)
    return [`Switched this chat to project: ${binding.alias}`, selection.recoveryNote, `Project record: ${project.roadmap.title} (${project.roadmap.id})`, `Session: ${binding.sessionId}`, links].filter(Boolean).join('\n')
  }
  if (project.status === 'ambiguous') return `${project.reason}\nCandidates:\n${(project.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`

  let session: any
  try {
    const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(sessionId)
    if (got.missing || !got.data) return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
    session = got.data
  } catch {
    return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
  }
  setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'chat', title: cleanTitle(session?.title) })
  const links = session ? formatOpenCodeSessionLinks(getConfig().opencodeUrl, session, { gatewayBaseUrl: configuredGatewayBaseUrl() }) : ''
  return [`Bound this chat to Session: ${sessionId}`, links].filter(Boolean).join('\n')
}

async function bindTarget(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const allowRebind = args.includes('--rebind')
  const clean = args.filter(arg => arg !== '--rebind')
  const [rawKind, id] = clean
  if (rawKind === 'session') return bindSession(client, msg, id, allowRebind)
  if (rawKind === 'project') return bindProject(client, msg, [...clean.slice(1), ...(allowRebind ? ['--rebind'] : [])])
  const kind = normalizeBindingKind(rawKind)
  if (!kind || !id) return 'Usage: /bind session <sessionId> [--rebind] OR /bind project <alias> <roadmapId> [--rebind] OR /bind issue <taskId> [--rebind] OR /bind initiative <roadmapId> [--rebind].'
  const conflict = currentBinding(msg)
  if (conflict && !allowRebind && !bindingMatches(conflict, kind, id)) return `This chat is already bound to ${describeChannelBinding(conflict)}.\nUse /bind ${rawKind} ${id} --rebind to replace it.`

  if (kind === 'task') {
    const task = getWorkTask(id)
    if (!task) return `Issue not found: ${id}`
    const sessionId = await currentOrNewSession(client, msg, task.title)
    setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'task', taskId: task.id, title: task.title })
    return `Bound this chat to Issue ${task.id}: ${task.title}\nSession: ${sessionId}`
  }

  const roadmap = loadWorkState().roadmaps.find(row => row.id === id)
  if (!roadmap) return `Project not found: ${id}`
  const sessionId = await currentOrNewSession(client, msg, roadmap.title)
  setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'roadmap', roadmapId: roadmap.id, title: roadmap.title })
  return `Bound this chat to Project ${roadmap.id}: ${roadmap.title}\nSession: ${sessionId}`
}

function normalizeBindingKind(kind?: string): 'task' | 'roadmap' | undefined {
  if (kind === 'issue') return 'task'
  if (kind === 'initiative') return 'roadmap'
  return undefined
}

async function bindSession(client: ChannelCommandClient, msg: ChannelMessage, sessionId: string | undefined, allowRebind: boolean): Promise<string> {
  if (!sessionId) return 'Usage: /bind session <sessionId> [--rebind]'
  const conflict = currentBinding(msg)
  if (conflict && conflict.sessionId !== sessionId && !allowRebind) return `This chat is already bound to ${describeChannelBinding(conflict)}.\nUse /bind session ${sessionId} --rebind to replace it.`
  let session: any
  try {
    const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(sessionId)
    if (got.missing || !got.data) return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
    session = got.data
  } catch {
    return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
  }
  setChannelSession(msg.provider, msg.chatId, sessionId, { threadId: msg.threadId, mode: 'chat', title: cleanTitle(session?.title) })
  const links = session ? formatOpenCodeSessionLinks(getConfig().opencodeUrl, session, { gatewayBaseUrl: configuredGatewayBaseUrl() }) : ''
  return [`Session bound: ${sessionId}`, links].filter(Boolean).join('\n')
}

function unbind(msg: ChannelMessage): string {
  const removed = clearChannelSession(msg.provider, msg.chatId, msg.threadId)
  return removed ? 'Removed this chat binding.' : 'No binding found for this chat.'
}

async function status(client: ChannelCommandClient, msg: ChannelMessage): Promise<string> {
  const binding = currentBinding(msg)
  const snapshot = getWorkQueueSnapshot()
  const lines = [
    `Issues: ${snapshot.counts.pending} pending, ${snapshot.counts.running} running, ${snapshot.counts.done} done, ${snapshot.counts.blocked} blocked`,
    `Projects: ${snapshot.state.roadmaps.length}`,
    `Governance: ${buildGovernanceReport(snapshot.state).summary}`,
  ]
  if (!binding) return [
    'No Session bound to this chat.',
    ...lines,
    'Next: /new [title] to start a Session, or /project create <alias> <title> for supervised roadmap work.',
  ].join('\n')

  lines.unshift(`Binding: ${binding.sessionId} context=${displayBindingMode(binding.mode)}`)
  if (binding.taskId) lines.push(`Issue: ${binding.taskId}`)
  if (binding.roadmapId) lines.push(`Project: ${binding.roadmapId}`)
  try {
    const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(binding.sessionId)
    if (got.missing) lines.push(unavailableSessionLinks(binding.sessionId, 'session not found in OpenCode API'))
    else if (got.data) lines.push(formatOpenCodeSessionLinks(getConfig().opencodeUrl, got.data, { gatewayBaseUrl: configuredGatewayBaseUrl() }))
    else lines.push(unavailableSessionLinks(binding.sessionId, 'session metadata missing from OpenCode response'))
  } catch {
    lines.push(unavailableSessionLinks(binding.sessionId, 'session not found in OpenCode API'))
  }
  lines.push(statusNextAction(binding))
  return lines.join('\n')
}

function statusNextAction(binding: ChannelSessionLink): string {
  if (binding.mode === 'roadmap') return 'Next: /project status for roadmap progress, /attention for decisions, or /project review-now to wake the supervisor.'
  if (binding.mode === 'task') return 'Next: /latest for the current run, /open for links, or /attention for decisions.'
  return 'Next: /open for links, /current for context, or /project create <alias> <title> to start supervised roadmap work.'
}

async function current(client: ChannelCommandClient, msg: ChannelMessage): Promise<string> {
  const binding = currentBinding(msg)
  if (!binding) return 'No binding found. Use /new [title] to create a Session, /project create <alias> <title> for supervised work, or /session list to pick an existing Session.'

  const lines = [`Current binding: ${displayBindingMode(binding.mode)}`, `Session: ${binding.sessionId}`]
  if (binding.taskId) {
    const task = getWorkTask(binding.taskId)
    if (task) lines.push('', ...formatTaskSummary(task))
    else lines.push(`Issue: ${binding.taskId} (not found)`)
  } else if (binding.roadmapId) {
    const roadmap = loadWorkState().roadmaps.find(row => row.id === binding.roadmapId)
    lines.push(roadmap ? `Project: ${roadmap.title} (${roadmap.id}) status=${roadmap.status}` : `Project: ${binding.roadmapId} (not found)`)
  } else if (binding.title) {
    lines.push(`Title: ${binding.title}`)
  }

  const links = await sessionLinksText(client, binding.sessionId)
  if (links) lines.push(links)
  return lines.join('\n')
}

async function openCommand(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const requested = args.join(' ').trim()
  if (requested) {
    const resolved = resolveOpenTarget(msg, requested)
    if (resolved.status === 'ambiguous') return `${resolved.reason}\nCandidates:\n${resolved.candidates.join('\n')}`
    if (resolved.status === 'not_found') return resolved.reason
    const links = await sessionLinksText(client, resolved.sessionId)
    return links || unavailableSessionLinks(resolved.sessionId, 'session links unavailable')
  }

  const project = projectBindings.resolveProjectContext({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId })
  if (project.status === 'resolved') {
    const sessionId = project.binding?.sessionId || project.supervisor?.sessionId
    if (sessionId) {
      const links = await sessionLinksText(client, sessionId)
      return links || unavailableSessionLinks(sessionId, 'session links unavailable')
    }
  }
  if (project.status === 'ambiguous') return `${project.reason}\nCandidates:\n${(project.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`

  const binding = currentBinding(msg)
  if (!binding) return 'No binding found. Use /new [title] for a Session, /project create <alias> <title> for supervised roadmap work, or /session list to pick an existing Session.'
  const links = await sessionLinksText(client, binding.sessionId)
  return links || unavailableSessionLinks(binding.sessionId, 'session links unavailable')
}

async function latest(client: ChannelCommandClient, msg: ChannelMessage): Promise<string> {
  const task = boundTask(msg)
  if (!task) return 'No bound Issue. Use /bind issue <taskId> first.'
  if (!task.lastRun) return `No runs yet for ${task.title}.`
  const lines = [
    `Latest run for ${task.title}`,
    `Stage: ${task.lastRun.stage}`,
    `Status: ${task.lastRun.status}`,
    `Attempt: ${task.lastRun.attempt}`,
    `Session: ${task.lastRun.sessionId}`,
  ]
  const links = await sessionLinksText(client, task.lastRun.sessionId)
  if (links) lines.push(links)
  if (task.lastRun.result?.summary) lines.push(`Summary: ${task.lastRun.result.summary}`)
  return lines.join('\n')
}

async function boundTaskAction(client: ChannelCommandClient, msg: ChannelMessage, action: WorkTaskAction, note?: string): Promise<string> {
  const task = boundTask(msg)
  if (!task) return `No bound Issue. Use /bind issue <taskId> before /${action}.`
  return applyChannelTaskAction(client, msg, task, action, note)
}

function tasks(): string {
  const views = listWorkTaskViews(loadWorkState()).slice(0, 12)
  if (views.length === 0) return 'No Issues.'
  return views.map(task => `[${task.status}] ${task.priority}: ${task.title} (${task.id}) stage=${task.currentStage || 'complete'}`).join('\n')
}

function roadmaps(): string {
  const rows = loadWorkState().roadmaps.slice(0, 12)
  if (rows.length === 0) return 'No Projects.'
  return rows.map(roadmap => `[${roadmap.status}] ${roadmap.priority}: ${roadmap.title} (${roadmap.id})`).join('\n')
}

function completionCommand(args: string[], msg: ChannelMessage): string {
  const action = args[0] || 'list'
  if (action === 'list' || action === 'status') {
    const resolution = projectBindings.resolveProjectContext({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId })
    const roadmapId = resolution.status === 'resolved' ? resolution.roadmap?.id : undefined
    const proposals = listRoadmapCompletionProposals({ roadmapId, status: 'open' }).slice(0, 8)
    if (!proposals.length) return roadmapId ? `No pending completion proposals for ${roadmapId}.` : 'No pending completion proposals.'
    return proposals.map(formatCompletionProposal).join('\n')
  }
  if (action !== 'approve' && action !== 'reject') return 'Usage: /completion [list|approve|reject] [proposalId] [note]'
  const proposalId = args[1]
  if (!proposalId) return `Usage: /completion ${action} <proposalId> [note]`
  const denied = authorizeCompletionProposalAction(msg, proposalId)
  if (denied) return denied
  const result = decideRoadmapCompletionProposal(proposalId, { decision: action, actor: msg.userId || msg.provider, source: `${msg.provider}:${msg.chatId}`, note: args.slice(2).join(' ') || undefined })
  if (!result) return `Completion proposal not found: ${proposalId}`
  return [`Completion ${action}: ${result.proposal.id}`, `Status: ${result.proposal.status}`, result.roadmap ? `Project: ${result.roadmap.title} (${result.roadmap.status})` : ''].filter(Boolean).join('\n')
}

async function projectCommand(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const action = args[0] || 'status'
  if (action === 'create') return createProject(client, msg, args.slice(1))
  if (action === 'bind') return bindProject(client, msg, args.slice(1))
  if (action === 'status') return projectStatus(msg, args[1])
  if (action === 'digest') return projectDigest(msg, args[1])
  if (action === 'watch') return watchProject(msg, args[1], 'immediate')
  if (action === 'unwatch') return watchProject(msg, args[1], 'muted')
  if (action === 'notify') return projectNotify(msg, args.slice(1))
  if (action === 'quiet') return projectQuietHours(msg, args.slice(1))
  if (action === 'decisions') return projectDecisions(msg, args[1])
  if (action === 'review-now' || action === 'review') return projectReviewNow(msg, args[1])
  if (action === 'complete') return projectComplete(msg, args.slice(1))
  if (action === 'open') return openProject(client, msg, args[1])
  if (action === 'pause' || action === 'resume') return projectSupervisorAction(msg, args[1], action)
  if (action === 'unbind') return unbindProject(msg, args[1])
  return 'Usage: /project <create|bind|status|digest|watch|unwatch|notify|quiet|decisions|review-now|complete|open|pause|resume|unbind> [alias]'
}

async function createProject(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const allowRebind = args.includes('--rebind')
  const clean = args.filter(arg => arg !== '--rebind')
  const rawAlias = clean[0]
  const aliasCheck = validateChannelProjectAlias(rawAlias, msg)
  if (aliasCheck.error) return aliasCheck.error
  const alias = aliasCheck.alias!
  if (!alias) return 'Usage: /project create <alias> [title] [--rebind]'
  if (!allowRebind) {
    const aliasConflict = projectBindings.listProjectBindings({ alias, scope: msg.provider as any })[0]
    const surfaceConflict = projectBindings.listProjectBindings({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' })[0]
    if (aliasConflict) return `Project alias already exists: ${aliasConflict.alias} -> ${aliasConflict.roadmapId}\nUse /project create ${alias} [title] --rebind to replace it.`
    if (surfaceConflict) return `This chat is already bound to project ${surfaceConflict.alias} -> ${surfaceConflict.roadmapId}\nUse /project create ${alias} [title] --rebind to replace it.`
  }
  const title = clean.slice(1).join(' ') || alias
  const roadmap = createRoadmap({ title })
  const sessionId = await createFreshSession(client, msg, title)
  const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId, isDefault: true, note: `Created from ${msg.provider}:${msg.chatId}` })
  try {
    const binding = projectBindings.upsertProjectBinding({ alias, roadmapId: roadmap.id, sessionId, provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, title: roadmap.title, allowRebind })
    return [`Project created: ${binding.alias}`, `Project record: ${roadmap.title} (${roadmap.id})`, `Supervisor: ${supervisor.supervisorId}`, `Session: ${sessionId}`, 'Next: /project status'].join('\n')
  } catch (err: any) {
    if (String(err?.message || err).includes('already bound')) return `${err.message}\nUse /project create ${alias} ${title} --rebind to replace the existing binding.`
    throw err
  }
}

function validateChannelProjectAlias(rawAlias: string | undefined, msg: ChannelMessage): { alias?: string; error?: string } {
  if (!rawAlias) return {}
  if (!['telegram', 'whatsapp', 'discord'].includes(msg.provider)) {
    return { error: `Project bindings are supported for telegram, whatsapp, or discord channels, not ${msg.provider}.` }
  }
  if (!isTrustedChannelTarget(msg.provider, msg.chatId, msg.threadId, getConfig())) {
    return { error: `Channel target is not trusted: ${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}` }
  }
  try {
    return { alias: normalizeProjectAlias(rawAlias) }
  } catch (err: any) {
    return { error: err?.message || String(err) }
  }
}

async function bindProject(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const allowRebind = args.includes('--rebind')
  const clean = args.filter(arg => arg !== '--rebind')
  const rawAlias = clean[0]
  const aliasCheck = validateChannelProjectAlias(rawAlias, msg)
  if (aliasCheck.error) return aliasCheck.error
  const alias = aliasCheck.alias!
  const roadmapId = clean[1]
  if (!alias || !roadmapId) return 'Usage: /project bind <alias> <roadmapId> [--rebind]'
  if (!allowRebind) {
    const aliasConflict = projectBindings.listProjectBindings({ alias, scope: msg.provider as any })[0]
    const surfaceConflict = projectBindings.listProjectBindings({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' })[0]
    if (aliasConflict) return `Project alias already exists: ${aliasConflict.alias} -> ${aliasConflict.roadmapId}\nUse /project bind ${alias} ${roadmapId} --rebind to replace it.`
    if (surfaceConflict) return `This chat is already bound to project ${surfaceConflict.alias} -> ${surfaceConflict.roadmapId}\nUse /project bind ${alias} ${roadmapId} --rebind to replace it.`
  }
  const state = loadWorkState()
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) return `Project not found: ${roadmapId}`
  let supervisor = getDefaultRoadmapSupervisor(roadmap.id)
  const selection = await selectUsableProjectSession(client, msg, roadmap.title, supervisor?.sessionId, supervisor)
  const sessionId = selection.sessionId
  if (!supervisor) supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId, isDefault: true, note: `Bound from ${msg.provider}:${msg.chatId}` })
  try {
    const binding = projectBindings.upsertProjectBinding({ alias, roadmapId: roadmap.id, sessionId, provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, title: roadmap.title, allowRebind })
    return [`Project bound: ${binding.alias}`, selection.recoveryNote, `Project record: ${roadmap.title} (${roadmap.id})`, `Supervisor: ${supervisor.supervisorId}`, `Session: ${binding.sessionId}`].filter(Boolean).join('\n')
  } catch (err: any) {
    if (String(err?.message || err).includes('already bound')) return `${err.message}\nUse /project bind ${alias} ${roadmapId} --rebind to replace the existing binding.`
    throw err
  }
}

function projectStatus(msg: ChannelMessage, alias?: string): string {
  return formatProjectStatus(getProjectStatus(projectContextInput(msg, alias)))
}

function projectDigest(msg: ChannelMessage, alias?: string): string {
  return formatProjectDigest(getProjectDigest(projectContextInput(msg, alias)))
}

function watchProject(msg: ChannelMessage, alias: string | undefined, mode: 'immediate' | 'muted'): string {
  const resolution = projectBindings.resolveProjectContext(projectContextInput(msg, alias))
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (resolution.status === 'not_found' || !resolution.roadmap) return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`

  let binding = resolution.binding
  if (binding?.provider !== msg.provider || binding?.chatId !== msg.chatId || (binding.threadId || '') !== (msg.threadId || '')) {
    const sessionId = binding?.sessionId || resolution.supervisor?.sessionId
    if (!sessionId) return 'No project assistant session is available for this project. Use /project bind <alias> <roadmapId> first.'
    try {
      binding = projectBindings.upsertProjectBinding({ alias: alias || binding?.alias || resolution.roadmap.title, roadmapId: resolution.roadmap.id, sessionId, provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, title: resolution.roadmap.title, notificationMode: mode })
    } catch (err: any) {
      if (String(err?.message || err).includes('already bound')) return `${err.message}\nUse /project bind ${alias || resolution.roadmap.id} ${resolution.roadmap.id} --rebind to replace the existing binding.`
      throw err
    }
  } else {
    binding = projectBindings.updateProjectBinding(binding.id, { notificationMode: mode }) || binding
  }
  return mode === 'immediate'
    ? `Watching project: ${binding.alias}\nNotifications: immediate`
    : `Unwatched project: ${binding.alias}\nNotifications: muted`
}

function projectNotify(msg: ChannelMessage, args: string[]): string {
  const mode = args[0] as ProjectNotificationMode | undefined
  if (mode !== 'immediate' && mode !== 'digest' && mode !== 'muted') return 'Usage: /project notify <immediate|digest|muted> [alias]'
  const binding = updateCurrentProjectBinding(msg, args[1])
  if (typeof binding === 'string') return binding
  const updated = projectBindings.updateProjectBinding(binding.id, { notificationMode: mode }) || binding
  return `Project notifications: ${updated.alias}\nNotifications: ${updated.notificationMode}`
}

function projectQuietHours(msg: ChannelMessage, args: string[]): string {
  const first = args[0]
  if (!first) return 'Usage: /project quiet <HH:MM> <HH:MM> [alias] OR /project quiet off [alias]'
  if (first === 'off') {
    const binding = updateCurrentProjectBinding(msg, args[1])
    if (typeof binding === 'string') return binding
    const updated = projectBindings.updateProjectBinding(binding.id, { quietHours: null }) || binding
    return `Project quiet hours: ${updated.alias}\nQuiet hours: off`
  }
  const start = args[0]
  const end = args[1]
  if (!isClockTime(start) || !isClockTime(end)) return 'Usage: /project quiet <HH:MM> <HH:MM> [alias] OR /project quiet off [alias]'
  const binding = updateCurrentProjectBinding(msg, args[2])
  if (typeof binding === 'string') return binding
  const updated = projectBindings.updateProjectBinding(binding.id, { quietHours: { start, end, timezone: 'UTC' } }) || binding
  return `Project quiet hours: ${updated.alias}\nQuiet hours: ${updated.quietHours['start']}-${updated.quietHours['end']} UTC`
}

function updateCurrentProjectBinding(msg: ChannelMessage, alias?: string) {
  const resolution = projectBindings.resolveProjectContext(projectContextInput(msg, alias))
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (resolution.status === 'not_found' || !resolution.roadmap) return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`
  const binding = resolution.binding
  if (!binding) return 'No project binding is available for this project. Use /project bind <alias> <roadmapId> first.'
  return binding
}

function projectDecisions(msg: ChannelMessage, alias?: string): string {
  const resolution = projectBindings.resolveProjectContext(projectContextInput(msg, alias))
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (resolution.status === 'not_found' || !resolution.roadmap) return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`
  const gates = listHumanGates({ roadmapId: resolution.roadmap.id, status: 'open' })
  const proposals = listRoadmapCompletionProposals({ roadmapId: resolution.roadmap.id, status: 'open' })
  const lines = [`Project decisions: ${resolution.binding?.alias || resolution.roadmap.title}`]
  if (!gates.length && !proposals.length) lines.push('No pending project decisions.')
  for (const proposal of proposals.slice(0, 6)) lines.push(formatCompletionProposal(proposal))
  for (const gate of gates.slice(0, 6)) lines.push(formatHumanGate(gate))
  return lines.join('\n\n')
}

function projectReviewNow(msg: ChannelMessage, alias?: string): string {
  const result = requestProjectReview(projectContextInput(msg, alias))
  if (result.resolution.status === 'ambiguous') return `${result.reason}\nCandidates:\n${(result.resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (result.resolution.status === 'not_found') return `${result.reason}\nUse /project bind <alias> <roadmapId> first.`
  return [`Project review: ${result.queued ? 'queued' : 'not queued'}`, `Reason: ${result.reason}`, result.supervisorId ? `Supervisor: ${result.supervisorId}` : '', result.nextReviewAt ? `Next review: ${result.nextReviewAt}` : ''].filter(Boolean).join('\n')
}

function projectComplete(msg: ChannelMessage, args: string[]): string {
  const action = args[0] || 'list'
  if (action === 'list' || action === 'status') return projectDecisions(msg, args[1])
  if (action !== 'approve' && action !== 'reject') return 'Usage: /project complete [list|approve|reject] [proposalId] [note]'
  let proposalId = args[1]?.startsWith('completion_') ? args[1] : undefined
  let noteStart = proposalId ? 2 : 1
  if (!proposalId) {
    const resolution = projectBindings.resolveProjectContext(projectContextInput(msg))
    if (resolution.status !== 'resolved' || !resolution.roadmap) return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`
    const proposals = listRoadmapCompletionProposals({ roadmapId: resolution.roadmap.id, status: 'open' })
    if (proposals.length !== 1) return proposals.length ? `Multiple completion proposals exist. Specify one:\n${proposals.map(formatCompletionProposal).join('\n')}` : 'No pending completion proposal for this project.'
    proposalId = proposals[0]!.id
    noteStart = 1
  }
  const denied = authorizeCompletionProposalAction(msg, proposalId)
  if (denied) return denied
  const result = decideRoadmapCompletionProposal(proposalId, { decision: action, actor: msg.userId || msg.provider, source: `${msg.provider}:${msg.chatId}`, note: args.slice(noteStart).join(' ') || undefined })
  if (!result) return `Completion proposal not found: ${proposalId}`
  return [`Completion ${action}: ${result.proposal.id}`, `Status: ${result.proposal.status}`, result.roadmap ? `Project: ${result.roadmap.title} (${result.roadmap.status})` : ''].filter(Boolean).join('\n')
}

async function openProject(client: ChannelCommandClient, msg: ChannelMessage, alias?: string): Promise<string> {
  const resolution = projectBindings.resolveProjectContext(projectContextInput(msg, alias))
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (resolution.status === 'not_found') return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`
  const sessionId = resolution.binding?.sessionId || resolution.supervisor?.sessionId
  if (!sessionId) return 'No project assistant session is available for this project.'
  const links = await sessionLinksText(client, sessionId)
  return links || unavailableSessionLinks(sessionId, 'session links unavailable')
}

function projectSupervisorAction(msg: ChannelMessage, alias: string | undefined, action: 'pause' | 'resume'): string {
  const resolution = projectBindings.resolveProjectContext(projectContextInput(msg, alias))
  if (resolution.status === 'ambiguous') return `${resolution.reason}\nCandidates:\n${(resolution.candidates || []).slice(0, 6).map(formatProjectBinding).join('\n')}`
  if (resolution.status === 'not_found' || !resolution.roadmap) return `${resolution.reason}\nUse /project bind <alias> <roadmapId> first.`
  if (!resolution.supervisor) return 'No active supervisor for this project.'
  const supervisor = updateRoadmapSupervisor(resolution.supervisor.supervisorId, { status: action === 'pause' ? 'paused' : 'active', note: `${action} from ${msg.provider}:${msg.chatId}` })
  return supervisor ? `Project assistant ${action}d: ${resolution.binding?.alias || resolution.roadmap.title}\nSupervisor: ${supervisor.supervisorId}\nStatus: ${supervisor.status}` : `Supervisor not found: ${resolution.supervisor.supervisorId}`
}

function unbindProject(msg: ChannelMessage, alias?: string): string {
  const binding = alias
    ? projectBindings.listProjectBindings({ alias, provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' })[0]
    : projectBindings.resolveProjectContext({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId }).binding
  if (!binding) return 'No project binding found for this chat.'
  return projectBindings.deleteProjectBinding(binding.id) ? `Project unbound: ${binding.alias}` : `Project binding not found: ${binding.id}`
}

function projectContextInput(msg: ChannelMessage, value?: string): { alias?: string; roadmapId?: string; provider: string; chatId: string; threadId?: string } {
  const state = value ? loadWorkState() : undefined
  const roadmapId = value && (state?.roadmaps.some(roadmap => roadmap.id === value) || value.startsWith('roadmap_')) ? value : undefined
  return { alias: roadmapId ? undefined : value, roadmapId, provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId }
}

function projectIdentifierInput(value?: string): { alias?: string; roadmapId?: string } {
  const state = value ? loadWorkState() : undefined
  const roadmapId = value && (state?.roadmaps.some(roadmap => roadmap.id === value) || value.startsWith('roadmap_')) ? value : undefined
  return { alias: roadmapId ? undefined : value, roadmapId }
}

function currentBinding(msg: ChannelMessage): ChannelSessionLink | undefined {
  return listChannelSessions({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' })[0]
}

function isTrustedCommandTarget(msg: ChannelMessage): boolean {
  return isTrustedChannelTarget(msg.provider, msg.chatId, msg.threadId, getConfig())
}

interface RelevantSessionRow {
  sessionId: string
  source: string
  mode?: string
  threadId?: string
  taskId?: string
  roadmapId?: string
  title?: string
}

function relevantSessionRows(msg: ChannelMessage): RelevantSessionRow[] {
  const rows: RelevantSessionRow[] = []
  const seen = new Set<string>()
  const add = (row: RelevantSessionRow) => {
    const key = `${row.sessionId}:${row.source}:${row.taskId || ''}:${row.roadmapId || ''}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push(row)
  }

  for (const link of listChannelSessions({ provider: msg.provider, chatId: msg.chatId })) {
    add({ sessionId: link.sessionId, source: 'channel', mode: link.mode, threadId: link.threadId, taskId: link.taskId, roadmapId: link.roadmapId, title: link.title })
  }

  const resolution = projectBindings.resolveProjectContext({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId })
  if (resolution.status === 'resolved' && resolution.roadmap) {
    if (resolution.binding?.sessionId) add({ sessionId: resolution.binding.sessionId, source: 'project-binding', mode: 'roadmap', roadmapId: resolution.roadmap.id, title: resolution.binding.alias })
    if (resolution.supervisor?.sessionId) add({ sessionId: resolution.supervisor.sessionId, source: 'supervisor', mode: 'roadmap', roadmapId: resolution.roadmap.id, title: resolution.roadmap.title })
    const state = loadWorkState()
    for (const run of getRunsForRoadmap(resolution.roadmap.id, { limit: 12 })) {
      const task = state.tasks.find(row => row.id === run.taskId)
      add({ sessionId: run.sessionId, source: `run:${run.id}`, mode: 'task', taskId: run.taskId, roadmapId: resolution.roadmap.id, title: task?.title })
    }
  }

  return rows.slice(0, 12)
}

type OpenTargetResolution =
  | { status: 'resolved'; sessionId: string }
  | { status: 'ambiguous'; reason: string; candidates: string[] }
  | { status: 'not_found'; reason: string }

function resolveOpenTarget(_msg: ChannelMessage, requested: string): OpenTargetResolution {
  const [maybeKind, maybeId] = requested.split(/\s+/, 2)
  const kind = maybeKind && ['session', 'task', 'issue', 'run', 'project', 'roadmap'].includes(maybeKind) ? maybeKind : ''
  const id = kind ? maybeId : requested
  if (!id) return { status: 'not_found', reason: 'Usage: /open [sessionId|issueId|runId|projectAlias]' }

  if (kind === 'run' || id.startsWith('run_')) {
    const run = getRun(id)
    return run ? { status: 'resolved', sessionId: run.sessionId } : { status: 'not_found', reason: `Run not found: ${id}` }
  }

  if (kind === 'task' || kind === 'issue' || id.startsWith('task_')) {
    const task = loadWorkState().tasks.find(row => row.id === id)
    if (!task) return { status: 'not_found', reason: `Issue not found: ${id}` }
    const run = getRunsForTask(task.id, { limit: 1 })[0]
    if (!run) return { status: 'not_found', reason: `No OpenCode Session is known for Issue ${task.id}.` }
    return { status: 'resolved', sessionId: run.sessionId }
  }

  if (kind === 'session' || id.startsWith('ses_')) return { status: 'resolved', sessionId: id }

  const project = projectBindings.resolveProjectContext(projectIdentifierInput(id))
  if (project.status === 'ambiguous') return { status: 'ambiguous', reason: project.reason, candidates: (project.candidates || []).slice(0, 6).map(formatProjectBinding) }
  if (project.status === 'resolved') {
    const sessionId = project.binding?.sessionId || project.supervisor?.sessionId
    return sessionId ? { status: 'resolved', sessionId } : { status: 'not_found', reason: 'No project assistant session is available for this project.' }
  }

  const channel = listChannelSessions({ sessionId: id })[0]
  if (channel) return { status: 'resolved', sessionId: channel.sessionId }
  return { status: 'resolved', sessionId: id }
}

function boundTask(msg: ChannelMessage): WorkTaskView | undefined {
  const binding = currentBinding(msg)
  return binding?.taskId ? getWorkTask(binding.taskId) : undefined
}

async function sessionLinksText(client: ChannelCommandClient, sessionId: string): Promise<string> {
  try {
    const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(sessionId)
    if (got.missing) return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
    return got.data
      ? formatOpenCodeSessionLinks(getConfig().opencodeUrl, got.data, { gatewayBaseUrl: configuredGatewayBaseUrl() })
      : unavailableSessionLinks(sessionId, 'session metadata missing from OpenCode response')
  } catch {
    return unavailableSessionLinks(sessionId, 'session not found in OpenCode API')
  }
}

async function taskCommand(client: ChannelCommandClient, msg: ChannelMessage, args: string[]): Promise<string> {
  const action = args[0] as any
  const taskId = args[1]
  if (!['pause', 'resume', 'cancel', 'retry', 'done', 'block'].includes(action) || !taskId) return 'Usage: /issue <pause|resume|cancel|retry|done|block> <taskId> [note] (/task remains supported)'
  const denied = authorizeTaskAction(msg, taskId)
  if (denied) return denied
  const task = (listWorkTaskViews(loadWorkState()).find(row => row.id === taskId) || getWorkTask(taskId)) as WorkTaskView | undefined
  if (!task) return `Issue not found: ${taskId}`
  return applyChannelTaskAction(client, msg, task, action, args.slice(2).join(' ') || undefined)
}

async function applyChannelTaskAction(client: ChannelCommandClient, msg: ChannelMessage, task: WorkTaskView, action: WorkTaskAction, note?: string): Promise<string> {
  const state = loadWorkState()
  const durableTask = state.tasks.find(row => row.id === task.id)
  const activeRun = task.activeRun?.status === 'running'
    ? task.activeRun
    : durableTask?.currentRunId
      ? state.runs.find(run => run.id === durableTask.currentRunId && run.status === 'running')
      : undefined
  const runControlAction = action === 'cancel' ? 'cancel' : action === 'retry' ? 'retry' : action === 'block' ? 'stop' : undefined
  if (activeRun && runControlAction) {
    const control = applyActiveRunControl({
      runId: activeRun.id,
      action: runControlAction,
      note: note || undefined,
      expectedLeaseOwner: activeRun.leaseOwner,
      expectedSchedulerGeneration: activeRun.schedulerGeneration,
      actor: `channel:${msg.provider}`,
      source: 'channel-command',
    })
    if (control.applied && control.abortedSessionId) await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).abort(control.abortedSessionId)
    return [
      `${action}: ${control.task?.title || task.title}`,
      `Outcome: ${control.outcome}`,
      `Reason: ${control.reason}`,
      control.task ? `Status: ${control.task.status}` : undefined,
      control.task?.currentStage ? `Stage: ${control.task.currentStage}` : undefined,
      control.restartBehavior ? `Restart behavior: ${control.restartBehavior}` : undefined,
      control.abortedSessionId ? `Aborted session: ${control.abortedSessionId}` : undefined,
      `Next: ${control.nextAction}`,
    ].filter(Boolean).join('\n')
  }
  const result = applyWorkTaskAction(task.id, action, { note: note || undefined })
  if (!result) return `Issue not found: ${task.id}`
  if (result.abortedSessionId) await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).abort(result.abortedSessionId)
  return `${action}: ${result.task.title}\nStatus: ${result.task.status}${result.task.currentStage ? `\nStage: ${result.task.currentStage}` : ''}${result.abortedSessionId ? `\nAborted session: ${result.abortedSessionId}` : ''}`
}

async function schedulerCommand(client: ChannelCommandClient, args: string[]): Promise<string> {
  const action = args[0] || 'status'
  if (action === 'status') {
    const snapshot = getWorkQueueSnapshot()
    const cfg = getConfig().scheduler
    return `Scheduler: ${cfg.enabled ? 'enabled' : 'paused'}\nMax concurrent: ${cfg.maxConcurrent}\nPipeline: ${cfg.defaultPipeline.join(' -> ')}\nIssues: ${snapshot.counts.pending} pending, ${snapshot.counts.running} running, ${snapshot.counts.paused} paused, ${snapshot.counts.blocked} blocked`
  }
  if (action === 'pause') return `Scheduler paused.\n${JSON.stringify(updateSchedulerConfig({ enabled: false }), null, 2)}`
  if (action === 'resume') return `Scheduler resumed.\n${JSON.stringify(updateSchedulerConfig({ enabled: true }), null, 2)}`
  if (action === 'run') {
    const state = await schedulerCycle(client as any)
    return `Scheduler cycle complete. Issues: ${state.tasks.length}`
  }
  return 'Usage: /scheduler <status|pause|resume|run>'
}

async function questions(): Promise<string> {
  const rows = await listPendingQuestions()
  if (rows.length === 0) return 'No pending OpenCode questions.'
  return rows.map(formatQuestionRequest).join('\n\n')
}

async function needsAttention(): Promise<string> {
  const [questions, permissions] = await Promise.all([
    listPendingQuestions().catch(() => []),
    listPendingPermissions().catch(() => []),
  ])
  return formatNeedsAttentionReport(buildNeedsAttentionReport({ questions, permissions }))
}

function gates(): string {
  const rows = listHumanGates({ status: 'open' })
  if (rows.length === 0) return 'No pending Gateway human gates.'
  return rows.slice(0, 8).map(formatHumanGate).join('\n\n')
}

async function alerts(): Promise<string> {
  const result = await runAlertEngine().catch(() => ({ active: [] as any[] }))
  return formatAlerts(result.active)
}

function alertCommand(args: string[], msg: ChannelMessage): string {
  const rawAction = args[0]
  const alertId = args[1]
  const action = rawAction === 'ack' ? 'acknowledge' : rawAction
  if (!['acknowledge', 'resolve', 'suppress'].includes(action || '') || !alertId) return 'Usage: /alert <ack|resolve|suppress> <alertId> [note]'
  const alert = updateAlertStatus(alertId, action as any, { note: args.slice(2).join(' ') || undefined })
  if (!alert) appendSecurityAudit(msg, 'alert.action', alertId, 'not_found')
  return alert ? `${action}: ${alert.summary}\nStatus: ${alert.status}` : `Alert not found: ${alertId}`
}

async function gateCommand(args: string[], msg: ChannelMessage): Promise<string> {
  const action = args[0]
  const gateId = args[1]
  if (!action || !['approve', 'reject'].includes(action) || !gateId) return 'Usage: /gate <approve|reject> <gateId> [once|always] [note]'
  const denied = authorizeHumanGateAction(msg, gateId)
  if (denied) return denied
  const maybeScope = args[2]
  const scope = maybeScope === 'always' ? 'always' : 'once'
  const noteStart = maybeScope === 'always' || maybeScope === 'once' ? 3 : 2
  const result = decideHumanGate(gateId, { decision: action as any, scope, actor: msg.userId || msg.provider, source: `${msg.provider}:${msg.chatId}`, note: args.slice(noteStart).join(' ') || undefined })
  if (!result) return `Gateway human gate not found: ${gateId}`
  const [questions, permissions] = await Promise.all([
    listPendingQuestions().catch(() => []),
    listPendingPermissions().catch(() => []),
  ])
  return [`${action}: ${result.gate.id}`, `Status: ${result.gate.status}`, result.task ? `Issue: ${result.task.status} ${result.task.title}` : '', '', formatNeedsAttentionReport(buildNeedsAttentionReport({ questions, permissions }))].filter(Boolean).join('\n')
}

async function permissions(): Promise<string> {
  const rows = await listPendingPermissions()
  if (rows.length === 0) return 'No pending OpenCode permissions.'
  return rows.map(formatPermissionRequest).join('\n\n')
}

async function answerQuestion(args: string[], rest: string, msg: ChannelMessage): Promise<string> {
  const requestId = args[0]
  if (!requestId) return 'Usage: /answer <questionId> <label>[|label2][; next-question-label]'
  const answerText = rest.slice(requestId.length).trim()
  if (!answerText) return 'Usage: /answer <questionId> <label>[|label2][; next-question-label]'
  const denied = await authorizeOpenCodeQuestionAction(msg, requestId)
  if (denied) return denied
  const answers = answerText.split(';').map(group => group.split('|').map(label => label.trim()).filter(Boolean)).filter(group => group.length > 0)
  await replyToQuestion(requestId, answers)
  return `Answered question ${requestId}. Forwarded to OpenCode; OpenCode owns the final question receipt. Run /questions or /status if the Session still appears blocked.`
}

async function rejectQuestionCommand(requestId: string | undefined, msg: ChannelMessage): Promise<string> {
  if (!requestId) return 'Usage: /reject-question <questionId>'
  const denied = await authorizeOpenCodeQuestionAction(msg, requestId)
  if (denied) return denied
  await rejectQuestion(requestId)
  return `Rejected question ${requestId}. Forwarded to OpenCode; OpenCode owns the final question receipt. Run /questions or /status if the Session still appears blocked.`
}

async function approvePermission(args: string[], msg: ChannelMessage): Promise<string> {
  const requestId = args[0]
  if (!requestId) return 'Usage: /approve <permissionId> [once|always]'
  const mode = args[1] === 'always' ? 'always' : 'once'
  const denied = await authorizeOpenCodePermissionAction(msg, requestId)
  if (denied) return denied
  await replyToPermission(requestId, mode)
  return `Approved permission ${requestId} (${mode}). Forwarded to OpenCode; OpenCode owns the final permission receipt. Run /permissions or /status if the Session still appears blocked.`
}

async function denyPermission(requestId: string | undefined, message: string | undefined, msg: ChannelMessage): Promise<string> {
  if (!requestId) return 'Usage: /deny <permissionId> [message]'
  const denied = await authorizeOpenCodePermissionAction(msg, requestId)
  if (denied) return denied
  await replyToPermission(requestId, 'reject', message)
  return `Denied permission ${requestId}. Forwarded to OpenCode; OpenCode owns the final permission receipt. Run /permissions or /status if the Session still appears blocked.`
}

// Fail closed: every channel command is privileged (per-sender actor preflight)
// unless it is on this explicit allowlist of known-safe read-only surfaces. A
// new mutating command is therefore actor-gated by default instead of silently
// skipping the preflight in a trusted group chat.
function preflightPrivilegedChannelAction(msg: ChannelMessage, command: ParsedChannelCommand): string | null {
  if (isStaleChannelAction(msg)) return denyChannelAction(msg, commandOperation(command), 'this channel action is too old to process', actionReceiptKey(msg) || command.name, 'stale')
  if (hasAcceptedActionReceipt(msg)) return denyChannelAction(msg, commandOperation(command), 'this channel action was already processed', actionReceiptKey(msg), 'replayed')
  const actor = isTrustedChannelActor({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId, userId: msg.userId, privileged: true }, getConfig())
  if (!actor.allowed) {
    const policy = decideChannelCommandSecurityPolicy({
      command: commandOperation(command),
      provider: msg.provider,
      actorRef: `${msg.provider}:${msg.userId || 'unknown-sender'}`,
      targetRef: actionReceiptKey(msg) || redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId),
      trusted: false,
    })
    appendAuditEvent({
      actor: msg.userId || msg.provider,
      source: channelSource(msg),
      operation: `channel.${commandOperation(command)}`,
      target: actionReceiptKey(msg) || redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId),
      result: 'denied',
      details: {
        provider: msg.provider,
        target: redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId),
        reason: actor.reason,
        securityPolicy: summarizeSecurityPolicyDecision(policy),
        operatorDecision: channelActionDeniedDecision({
          operation: commandOperation(command),
          targetId: actionReceiptKey(msg),
          reason: actor.reason,
          reasonCode: 'wrong_actor',
        }),
      },
    })
    const decision = channelActionDeniedDecision({
      operation: commandOperation(command),
      targetId: actionReceiptKey(msg),
      reason: actor.reason,
      reasonCode: 'wrong_actor',
    })
    return [
      `Privileged channel action denied: ${actor.reason}.`,
      formatChannelDecisionHint(decision),
      `Allowlist recovery: Add this sender to security.channelAllowlists.${msg.provider}.adminUserIds (or userIds) for this target, or run from a private trusted chat.`,
    ].join('\n')
  }
  reservePrivilegedChannelAction(msg, command)
  return null
}

function isStaleChannelAction(msg: ChannelMessage): boolean {
  const timestamp = Date.parse(msg.timestamp || '')
  return Number.isFinite(timestamp) && Date.now() - timestamp > PRIVILEGED_ACTION_MAX_AGE_MS
}

function hasAcceptedActionReceipt(msg: ChannelMessage): boolean {
  const key = actionReceiptKey(msg)
  if (!key) return false
  const since = new Date(Date.now() - ACTION_RECEIPT_RETENTION_MS)
  return listRecentWorkEvents(CHANNEL_ACTION_RECEIPT_EVENT, key, since, 1).length > 0
}

function reservePrivilegedChannelAction(msg: ChannelMessage, command: ParsedChannelCommand): void {
  const key = actionReceiptKey(msg)
  if (!key) return
  appendWorkEvent(CHANNEL_ACTION_RECEIPT_EVENT, key, {
    state: 'reserved',
    operation: commandOperation(command),
    actor: msg.userId || msg.provider,
    source: channelSource(msg),
    command: command.name,
  })
}

function recordPrivilegedChannelAction(msg: ChannelMessage, command: ParsedChannelCommand): void {
  const key = actionReceiptKey(msg)
  if (!key) return
  appendWorkEvent(CHANNEL_ACTION_RECEIPT_EVENT, key, {
    state: 'completed',
    operation: commandOperation(command),
    actor: msg.userId || msg.provider,
    source: channelSource(msg),
    command: command.name,
  })
}

function actionReceiptKey(msg: ChannelMessage): string | undefined {
  const source = msg.messageId
    ? `message:${msg.messageId}`
    : `fallback:${msg.userId || msg.provider}:${msg.timestamp || ''}:${String(msg.text || '').trim()}`
  if (!msg.messageId && (!msg.timestamp || !String(msg.text || '').trim())) return undefined
  return `${redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)}:${msg.messageId ? 'message' : 'fallback'}:${channelTargetFingerprint(msg.provider, source, msg.threadId)}`.substring(0, 500)
}

function authorizeHumanGateAction(msg: ChannelMessage, gateId: string): string | null {
  const gate = getHumanGate(gateId)
  if (!gate) return denyChannelAction(msg, 'human_gate.decide', 'Gateway human gate is not available', gateId, 'not_found')
  if (!['pending', 'escalated'].includes(gate.status)) return denyChannelAction(msg, 'human_gate.decide', 'Gateway human gate is no longer pending', gate.id, `status:${gate.status}`)
  if (isExpired(gate.expiresAt)) return denyChannelAction(msg, 'human_gate.decide', 'Gateway human gate has expired', gate.id, 'expired')
  if (!isGateBoundToChannel(msg, gate)) return denyChannelAction(msg, 'human_gate.decide', 'this channel is not bound to that human gate', gate.id, 'wrong_channel')
  return null
}

function authorizeCompletionProposalAction(msg: ChannelMessage, proposalId: string): string | null {
  const proposal = getRoadmapCompletionProposal(proposalId)
  if (!proposal) return denyChannelAction(msg, 'roadmap_completion.decide', 'completion proposal is not available', proposalId, 'not_found')
  if (proposal.status !== 'pending') return denyChannelAction(msg, 'roadmap_completion.decide', 'completion proposal is no longer pending', proposal.id, `status:${proposal.status}`)
  if (isExpired(proposal.expiresAt)) return denyChannelAction(msg, 'roadmap_completion.decide', 'completion proposal has expired', proposal.id, 'expired')
  if (!isCompletionProposalBoundToChannel(msg, proposal)) return denyChannelAction(msg, 'roadmap_completion.decide', 'this channel is not bound to that completion proposal', proposal.id, 'wrong_channel')
  return null
}

async function authorizeOpenCodePermissionAction(msg: ChannelMessage, requestId: string): Promise<string | null> {
  const request = (await listPendingPermissions()).find(row => row.id === requestId)
  if (!request) return denyChannelAction(msg, 'opencode_permission.reply', 'permission request is no longer pending', requestId, 'not_pending')
  if (!isSessionBoundToChannel(msg, request.sessionID)) return denyChannelAction(msg, 'opencode_permission.reply', 'this channel is not bound to that OpenCode Session', requestId, 'wrong_channel')
  return null
}

async function authorizeOpenCodeQuestionAction(msg: ChannelMessage, requestId: string): Promise<string | null> {
  const request = (await listPendingQuestions()).find(row => row.id === requestId)
  if (!request) return denyChannelAction(msg, 'opencode_question.reply', 'question request is no longer pending', requestId, 'not_pending')
  if (!isSessionBoundToChannel(msg, request.sessionID)) return denyChannelAction(msg, 'opencode_question.reply', 'this channel is not bound to that OpenCode Session', requestId, 'wrong_channel')
  return null
}

function authorizeTaskAction(msg: ChannelMessage, taskId: string): string | null {
  if (!getWorkTask(taskId)) return denyChannelAction(msg, 'task.action', 'Issue is not available', taskId, 'not_found')
  if (!isTaskBoundToChannel(msg, taskId)) return denyChannelAction(msg, 'task.action', 'this channel is not bound to that Issue', taskId, 'wrong_channel')
  return null
}

function isGateBoundToChannel(msg: ChannelMessage, gate: HumanGateRecord): boolean {
  if (gate.runId) {
    const run = getRun(gate.runId)
    if (run && isSessionBoundToChannel(msg, run.sessionId)) return true
    if (run && isTaskBoundToChannel(msg, run.taskId)) return true
  }
  if (gate.taskId && isTaskBoundToChannel(msg, gate.taskId)) return true
  if (gate.roadmapId && isRoadmapBoundToChannel(msg, gate.roadmapId)) return true
  if (gate.type === 'destructive_action') return false
  return !gate.runId && !gate.taskId && !gate.roadmapId && Boolean(currentBinding(msg))
}

function isCompletionProposalBoundToChannel(msg: ChannelMessage, proposal: RoadmapCompletionProposalRecord): boolean {
  if (proposal.sessionId && isSessionBoundToChannel(msg, proposal.sessionId)) return true
  return isRoadmapBoundToChannel(msg, proposal.roadmapId)
}

function isSessionBoundToChannel(msg: ChannelMessage, sessionId: string | undefined): boolean {
  if (!sessionId) return false
  const binding = currentBinding(msg)
  if (binding?.sessionId === sessionId) return true
  const state = loadWorkState()
  const run = state.runs.find(row => row.sessionId === sessionId)
  if (run && isTaskBoundToChannel(msg, run.taskId)) return true
  const supervisor = state.supervisors.find(row => row.sessionId === sessionId && row.status !== 'archived')
  if (supervisor && isRoadmapBoundToChannel(msg, supervisor.roadmapId)) return true
  const projectBinding = projectBindings.listProjectBindings({ sessionId })[0]
  if (projectBinding && isRoadmapBoundToChannel(msg, projectBinding.roadmapId)) return true
  return false
}

function isTaskBoundToChannel(msg: ChannelMessage, taskId: string): boolean {
  const binding = currentBinding(msg)
  if (binding?.taskId === taskId) return true
  const state = loadWorkState()
  const task = state.tasks.find(row => row.id === taskId)
  if (!task) return false
  if (binding?.roadmapId === task.roadmapId) return true
  if (binding?.sessionId && state.runs.some(row => row.taskId === task.id && row.sessionId === binding.sessionId)) return true
  return isRoadmapBoundToChannel(msg, task.roadmapId)
}

function isRoadmapBoundToChannel(msg: ChannelMessage, roadmapId: string | undefined): boolean {
  if (!roadmapId) return false
  const binding = currentBinding(msg)
  if (binding?.roadmapId === roadmapId) return true
  if (binding?.taskId && loadWorkState().tasks.find(task => task.id === binding.taskId)?.roadmapId === roadmapId) return true
  if (binding?.sessionId) {
    const state = loadWorkState()
    if (projectBindings.listProjectBindings({ roadmapId, sessionId: binding.sessionId }).length > 0) return true
    if (state.supervisors.some(row => row.roadmapId === roadmapId && row.sessionId === binding.sessionId && row.status !== 'archived')) return true
  }
  return projectBindings.listProjectBindings({ provider: msg.provider, chatId: msg.chatId, threadId: msg.threadId || '' }).some(row => row.roadmapId === roadmapId)
}

function configuredGatewayBaseUrl(): string {
  const config = getConfig()
  return gatewayLocalBaseUrl(config.httpPort, config.security.httpHost)
}

function denyChannelAction(msg: ChannelMessage, operation: string, reason: string, target: string | undefined, detail: string): string {
  const decision = channelActionDeniedDecision({ operation, targetId: target, reason, reasonCode: detail })
  appendSecurityAudit(msg, operation, target, detail, decision)
  return [`Action denied: ${reason}.`, formatChannelDecisionHint(decision)].join('\n')
}

function appendSecurityAudit(msg: ChannelMessage, operation: string, target: string | undefined, reason: string, decision?: OperatorDecisionSummary): void {
  appendAuditEvent({
    actor: msg.userId || msg.provider,
    source: channelSource(msg),
    operation: `channel.${operation}`,
    target,
    result: 'denied',
    details: { reason, ...(decision ? { operatorDecision: decision } : {}) },
  })
}

function channelSource(msg: ChannelMessage): string {
  return redactedChannelTargetLabel(msg.provider, msg.chatId, msg.threadId)
}

async function currentOrNewSession(client: ChannelCommandClient, msg: ChannelMessage, title: string): Promise<string> {
  const existing = getChannelSession(msg.provider, msg.chatId, msg.threadId)
  if (existing && await openCodeSessionAvailable(client, existing)) return existing
  return createFreshSession(client, msg, title)
}

async function selectUsableProjectSession(client: ChannelCommandClient, msg: ChannelMessage, title: string, preferredSessionId: string | undefined, supervisor: { supervisorId: string; sessionId: string } | undefined): Promise<{ sessionId: string; recoveryNote?: string }> {
  if (preferredSessionId && await openCodeSessionAvailable(client, preferredSessionId)) return { sessionId: preferredSessionId }
  if (supervisor?.sessionId && supervisor.sessionId !== preferredSessionId && await openCodeSessionAvailable(client, supervisor.sessionId)) {
    return {
      sessionId: supervisor.sessionId,
      recoveryNote: preferredSessionId
        ? `Recovery: replaced unavailable Project Session ${preferredSessionId} with Supervisor Session ${supervisor.sessionId}.`
        : undefined,
    }
  }
  const sessionId = await currentOrNewSession(client, msg, title)
  if (supervisor && sessionId !== supervisor.sessionId) {
    updateRoadmapSupervisor(supervisor.supervisorId, { sessionId, note: `Recovered stale OpenCode Session ${supervisor.sessionId}; rebound from ${msg.provider}:${msg.chatId}` })
  }
  return {
    sessionId,
    recoveryNote: preferredSessionId && preferredSessionId !== sessionId
      ? `Recovery: replaced unavailable Project Session ${preferredSessionId} with ${sessionId}.`
      : undefined,
  }
}

async function openCodeSessionAvailable(client: ChannelCommandClient, sessionId: string): Promise<boolean> {
  try {
    const got = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).getSession(sessionId)
    return Boolean(got.data?.id)
  } catch {
    return false
  }
}

function unavailableSessionLinks(sessionId: string, reason: string): string {
  return formatOpenCodeUnavailableSessionLinks(sessionId, {
    gatewayBaseUrl: configuredGatewayBaseUrl(),
    reason,
    actionHint: 'Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.',
  })
}

async function createFreshSession(client: ChannelCommandClient, msg: ChannelMessage, title: string): Promise<string> {
  const created = await (await import('./opencode-session-runtime.js')).createOpenCodeSessionRuntime(client as any).createSession({ title: gatewaySessionTitle(msg, title) })
  if (!created.id) throw new Error('OpenCode session creation returned no id')
  return created.id
}

