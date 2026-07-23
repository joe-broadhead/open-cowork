/**
 * Pure channel-command helpers (LOC façade split).
 * Leaf relative to channel-commands.ts — parse, format, and pure classification live here.
 */
import type { ChannelMessage } from './channels/provider.js'
import type { ChannelSessionLink } from './channel-sessions.js'
import type { OperatorDecisionSummary } from './operator-decisions.js'
import type { WorkTaskView } from './work-store.js'

export interface ParsedChannelCommand {
  name: string
  args: string[]
  rest: string
}

export interface ChannelCommandAction {
  label: string
  command: string
  description: string
}

export function parseChannelCommand(text: string): ParsedChannelCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [raw = '', ...args] = trimmed.split(/\s+/)
  const name = raw.slice(1).split('@')[0]!.toLowerCase().replace(/_/g, '-')
  return { name, args, rest: trimmed.slice(raw.length).trim() }
}

export function isChannelCommandMenuRequest(commandName: string): boolean {
  return ['help', 'start', 'commands'].includes(commandName)
}

export function isPreTrustChannelCommandText(text: string): boolean {
  const command = parseChannelCommand(text)
  if (!command) return false
  return command.name === 'whereami' || isChannelCommandMenuRequest(command.name)
}

export function channelBindingSystemContext(binding?: ChannelSessionLink): string {
  if (!binding) return ''
  if (binding.mode === 'task' && binding.taskId) return `This channel is bound to Gateway Issue ${binding.taskId}. Keep replies focused on that Issue unless the user asks otherwise.`
  if (binding.mode === 'roadmap' && binding.roadmapId) return `This channel is bound to Gateway Project ${binding.roadmapId}. Keep replies focused on that Project unless the user asks otherwise.`
  return ''
}

export function formatCompletionProposal(proposal: { id: string; roadmapId: string; recommendation: string; unresolvedRisks: string[]; evidence: string[] }): string {
  return `Project completion proposal ${proposal.id}: ${proposal.roadmapId}\nRecommendation: ${proposal.recommendation}\nProof: ${proposal.evidence.length}; risks: ${proposal.unresolvedRisks.length}\nAction: /completion approve ${proposal.id} OR /completion reject ${proposal.id} [note]`
}

export function formatProjectBinding(binding: { alias: string; roadmapId: string; scope: string; provider?: string; chatId?: string; threadId?: string }): string {
  const channel = binding.provider && binding.chatId ? ` ${binding.provider}:${binding.chatId}${binding.threadId ? `:${binding.threadId}` : ''}` : ''
  return `- ${binding.alias} -> ${binding.roadmapId} (${binding.scope}${channel})`
}

export function bindingMatches(binding: ChannelSessionLink, kind: string, id: string): boolean {
  if (kind === 'task') return binding.mode === 'task' && binding.taskId === id
  if (kind === 'roadmap') return binding.mode === 'roadmap' && binding.roadmapId === id
  return false
}

export function describeChannelBinding(binding: ChannelSessionLink): string {
  if (binding.mode === 'task' && binding.taskId) return `Issue ${binding.taskId} (Session ${binding.sessionId})`
  if (binding.mode === 'roadmap' && binding.roadmapId) return `Project ${binding.roadmapId} (Session ${binding.sessionId})`
  return `Session ${binding.sessionId}`
}

export function displayBindingMode(mode?: string): string {
  if (mode === 'task') return 'issue'
  if (mode === 'roadmap') return 'project'
  return mode || 'session'
}

export function formatTaskSummary(task: WorkTaskView): string[] {
  return [
    `Issue: ${task.title}`,
    `ID: ${task.id}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Stage: ${task.currentStage || 'complete'}`,
    task.lastRun ? `Latest run: ${task.lastRun.status} ${task.lastRun.stage} (${task.lastRun.id})` : 'Latest run: none',
  ]
}

export const READ_ONLY_CHANNEL_COMMANDS = new Set([
  'help', 'start', 'commands', 'whereami',
  'status', 'current', 'open', 'latest',
  'tasks', 'issues', 'roadmaps', 'initiatives',
  'governance', 'budget', 'attention', 'needs-attention',
  'gates', 'alerts', 'incident', 'questions', 'permissions', 'digest',
])

export const READ_ONLY_PROJECT_ACTIONS = new Set(['status', 'digest', 'decisions', 'open'])

export function isPrivilegedChannelAction(command: ParsedChannelCommand): boolean {
  if (READ_ONLY_CHANNEL_COMMANDS.has(command.name)) return false
  if (command.name === 'session' || command.name === 'sessions') {
    const action = command.args[0] || 'list'
    // Listing is read-only; select/switch rebinds this chat and stays privileged.
    return action !== 'list' && action !== 'recent'
  }
  if (command.name === 'scheduler') return (command.args[0] || 'status') !== 'status'
  if (command.name === 'completion' || command.name === 'complete') {
    const action = command.args[0] || 'list'
    return action !== 'list' && action !== 'status'
  }
  if (command.name === 'project' || command.name === 'p') {
    return !READ_ONLY_PROJECT_ACTIONS.has(command.args[0] || 'status')
  }
  // Everything else — including unknown/new commands — is privileged by default.
  return true
}

export function commandOperation(command: ParsedChannelCommand): string {
  if (command.name === 'approve' || command.name === 'deny') return 'opencode_permission.reply'
  if (command.name === 'answer' || command.name === 'reject-question') return 'opencode_question.reply'
  return `${command.name}${command.args[0] ? `.${command.args[0]}` : ''}`.substring(0, 120)
}

export function isExpired(iso: string | undefined, nowMs = Date.now()): boolean {
  const expires = Date.parse(iso || '')
  return Number.isFinite(expires) && expires <= nowMs
}

export function isClockTime(value: string | undefined): value is string {
  return typeof value === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value)
}

export function formatChannelDecisionHint(decision: OperatorDecisionSummary): string {
  return [
    `Decision owner: ${formatDecisionOwner(decision)}; State: ${decision.state}.`,
    `Authority: ${decision.authority}`,
    `Next action: ${decision.safeNextAction}`,
    `Evidence: ${decision.evidenceRef}`,
  ].join('\n')
}

export function formatDecisionOwner(decision: OperatorDecisionSummary): string {
  if (decision.owner === 'opencode') return 'OpenCode'
  if (decision.owner === 'gateway') return 'Gateway'
  return 'Gateway channel security'
}

export function isActionDenial(reply: string): boolean {
  return reply.startsWith('Action denied:')
}

export function gatewaySessionTitle(msg: Pick<ChannelMessage, 'provider' | 'chatId' | 'threadId'>, title: string): string {
  const thread = msg.threadId ? `:${msg.threadId}` : ''
  return `GW:${msg.provider}:${msg.chatId}${thread}: ${title}`.substring(0, 200)
}

export function cleanTitle(title: string | undefined): string | undefined {
  return title?.replace(/^GW:/, '').trim()
}

export function channelPreTrustHelpText(): string {
  return [
    'Gateway setup',
    '',
    'This channel is not trusted yet, so only setup-safe commands are available.',
    'Ask the local operator to create a Gateway channel claim for this provider, then send the displayed claim code here before it expires.',
    '',
    'Safe before trust: /start, /help, /commands, /whereami.',
  ].join('\n')
}
