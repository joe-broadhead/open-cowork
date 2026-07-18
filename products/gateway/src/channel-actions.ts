export type ChannelActionCategory =
  | 'setup'
  | 'session'
  | 'binding'
  | 'project'
  | 'issue'
  | 'scheduler'
  | 'governance'
  | 'attention'
  | 'human_loop'
  | 'diagnostics'

export type ChannelActionBoundaryGroup = 'read' | 'session_binding' | 'work_control' | 'human_loop'
export type ChannelActionTrust = 'pre_trust' | 'trusted' | 'trusted_privileged'
export type ChannelActionSurfaceStatus = 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable'
export type ChannelActionProvider = 'telegram' | 'whatsapp' | 'discord'
export type ChannelActionSafetyClass = 'read_only' | 'binding_change' | 'work_mutation' | 'human_decision'
export type ChannelActionNativeFallback = 'typed_command' | 'copy_command' | 'text_menu'
export type ChannelActionPresenceIndicator = 'typing' | 'none'
export type ChannelActionEvidenceGate =
  | 'handler_alignment'
  | 'telegram_set_my_commands'
  | 'telegram_send_chat_action'
  | 'renderer_fallback'
  | 'adapter_contract'
  | 'live_provider_proof'

export interface ChannelActionNativeUiHints {
  slashCommand: string
  slashAliases: string[]
  autocomplete: ChannelActionSurfaceStatus
  argumentAutocomplete: ChannelActionSurfaceStatus
  argumentFallback: ChannelActionNativeFallback
  menu: ChannelActionSurfaceStatus
  richAction: ChannelActionSurfaceStatus
  callbackPayload: 'command' | 'none'
  fallbackCopy: string
}

export interface ChannelActionPresencePolicy {
  status: ChannelActionSurfaceStatus
  indicator: ChannelActionPresenceIndicator
  startsAfter: 'trusted_inbound' | 'not_applicable'
  heartbeatMs?: number
  timeoutMs: number
  failureMode: 'record_degraded_and_continue' | 'not_applicable'
  masksBlockedState: false
  evidence: ChannelActionEvidenceGate[]
}

export interface ChannelActionProviderControl {
  provider: ChannelActionProvider
  slash: ChannelActionSurfaceStatus
  argumentAutocomplete: ChannelActionSurfaceStatus
  nativeAction: ChannelActionSurfaceStatus
  presence: ChannelActionSurfaceStatus
  fallback: ChannelActionNativeFallback
  evidence: ChannelActionEvidenceGate[]
  summary: string
}

export interface ChannelActionProviderControlSummary {
  provider: ChannelActionProvider
  typedCommand: ChannelActionSurfaceStatus
  slash: ChannelActionSurfaceStatus
  argumentAutocomplete: ChannelActionSurfaceStatus
  nativeAction: ChannelActionSurfaceStatus
  presence: ChannelActionSurfaceStatus
  actionCount: number
  fallback: ChannelActionNativeFallback[]
  evidence: ChannelActionEvidenceGate[]
  summary: string
}

export interface ChannelPermissionDecisionContract {
  gatewayOwned: Array<{
    action: string
    owner: 'gateway'
    command: string
    receipt: string
  }>
  opencodeOwned: Array<{
    action: string
    owner: 'opencode'
    command: string
    receipt: string
  }>
  boundary: string
}

export interface ChannelUxContractReport {
  schemaVersion: 1
  mode: 'm41_channel_command_presence_permission_action_contract'
  status: 'passed' | 'failed'
  releaseClaimEffect: 'local_beta_channel_ux_contract_only_no_universal_or_whatsapp_live_claim'
  summary: string
  telegramNative: ChannelActionNativeSlashManifest
  providerControls: ChannelActionProviderControlSummary[]
  permissionDecisionContract: ChannelPermissionDecisionContract
  acceptance: {
    typedFallbackVisible: boolean
    telegramNativeCommandsAligned: boolean
    telegramArgumentFallbackExplicit: boolean
    providerPresenceTruthful: boolean
    permissionOwnershipExplicit: boolean
    whatsappDiscordNotOverclaimed: boolean
  }
  errors: string[]
  unsupportedClaims: string[]
}

export interface ChannelUxContractReportInputs {
  telegramNative?: ChannelActionNativeSlashManifest
  providerControls?: ChannelActionProviderControlSummary[]
  permissionDecisionContract?: ChannelPermissionDecisionContract
}

export interface ChannelOperatorAction {
  id: string
  label: string
  primaryCommand: string
  aliases?: string[]
  nativeCommand?: string
  nativeAliases?: ChannelActionNativeSlashCommand[]
  description: string
  usage: string
  category: ChannelActionCategory
  boundaryGroup: ChannelActionBoundaryGroup
  trust: ChannelActionTrust
  safetyClass: ChannelActionSafetyClass
  capabilityRequirements: string[]
  nativeUi: ChannelActionNativeUiHints
  providerControls: ChannelActionProviderControl[]
  presence: ChannelActionPresencePolicy
  evidenceGates: ChannelActionEvidenceGate[]
  menu?: boolean
  menuDescription?: string
  surface: {
    typedCommand: ChannelActionSurfaceStatus
    telegramSlash: ChannelActionSurfaceStatus
    richAction: ChannelActionSurfaceStatus
    mcp: ChannelActionSurfaceStatus
    cli: ChannelActionSurfaceStatus
    missionControl: ChannelActionSurfaceStatus
  }
  evidence: string
}

export interface ChannelActionMenuItem {
  label: string
  command: string
  description: string
}

export interface ChannelActionNativeSlashCommand {
  command: string
  description: string
}

export interface ChannelActionNativeSlashManifest {
  provider: 'telegram'
  registration: 'setMyCommands'
  commands: ChannelActionNativeSlashCommand[]
  commandCount: number
  commandLimit: number
  commandPattern: string
  descriptionLimit: number
  commandVerbAutocomplete: ChannelActionSurfaceStatus
  argumentAutocomplete: ChannelActionSurfaceStatus
  argumentFallback: ChannelActionNativeFallback
  valid: boolean
  violations: string[]
  unsupportedClaims: string[]
}

export interface ChannelActionParityRow {
  id: string
  label: string
  command: string
  category: ChannelActionCategory
  trust: ChannelActionTrust
  safetyClass: ChannelActionSafetyClass
  capabilityRequirements: string[]
  nativeUi: ChannelActionNativeUiHints
  providerControls: Record<ChannelActionProvider, ChannelActionProviderControl>
  presence: ChannelActionPresencePolicy
  evidenceGates: ChannelActionEvidenceGate[]
  surfaces: ChannelOperatorAction['surface']
  evidence: string
}

export const CHANNEL_ACTION_TYPING_HEARTBEAT_MS = 4000
export const CHANNEL_ACTION_TYPING_TIMEOUT_MS = 60_000
export const TELEGRAM_NATIVE_COMMAND_LIMIT = 100
export const TELEGRAM_NATIVE_COMMAND_DESCRIPTION_LIMIT = 256
export const TELEGRAM_NATIVE_COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/
const CHANNEL_ACTION_PROVIDERS: ChannelActionProvider[] = ['telegram', 'whatsapp', 'discord']

const supported = {
  typedCommand: 'supported',
  telegramSlash: 'supported',
  richAction: 'partial',
  mcp: 'partial',
  cli: 'partial',
  missionControl: 'partial',
} satisfies ChannelOperatorAction['surface']

const readSurface = {
  ...supported,
  richAction: 'supported',
} satisfies ChannelOperatorAction['surface']

const mutationSurface = {
  ...supported,
  richAction: 'partial',
} satisfies ChannelOperatorAction['surface']

const humanLoopSurface = {
  ...supported,
  richAction: 'supported',
  missionControl: 'supported',
} satisfies ChannelOperatorAction['surface']

function action(input: Omit<ChannelOperatorAction,
  'surface' |
  'evidence' |
  'safetyClass' |
  'capabilityRequirements' |
  'nativeUi' |
  'providerControls' |
  'presence' |
  'evidenceGates'
> & {
  surface?: Partial<ChannelOperatorAction['surface']>
  evidence?: string
  safetyClass?: ChannelActionSafetyClass
  capabilityRequirements?: string[]
  nativeUi?: Partial<ChannelActionNativeUiHints>
  providerControls?: Partial<Record<ChannelActionProvider, Partial<ChannelActionProviderControl>>>
  presence?: Partial<ChannelActionPresencePolicy>
  evidenceGates?: ChannelActionEvidenceGate[]
}): ChannelOperatorAction {
  const base = input.boundaryGroup === 'read'
    ? readSurface
    : input.boundaryGroup === 'human_loop'
      ? humanLoopSurface
      : mutationSurface
  const surface = { ...base, ...input.surface }
  const slashCommand = input.nativeCommand || input.primaryCommand
  const slashAliases = [
    ...(input.aliases || []).filter(alias => /^[a-z0-9_]+$/.test(alias)),
    ...(input.nativeAliases || []).map(alias => alias.command),
  ].filter((alias, index, all) => all.indexOf(alias) === index)
  const safetyClass = input.safetyClass || safetyClassForBoundary(input.boundaryGroup)
  const evidenceGates = input.evidenceGates || evidenceGatesForAction(input.boundaryGroup)
  const nativeUi: ChannelActionNativeUiHints = {
    slashCommand,
    slashAliases,
    autocomplete: surface.telegramSlash,
    argumentAutocomplete: actionNeedsArguments(input.usage) ? 'deferred' : 'not_applicable',
    argumentFallback: 'copy_command',
    menu: input.menu ? 'supported' : 'partial',
    richAction: surface.richAction,
    callbackPayload: input.boundaryGroup === 'read' ? 'none' : 'command',
    fallbackCopy: input.usage,
    ...input.nativeUi,
  }
  const presence: ChannelActionPresencePolicy = {
    status: input.trust === 'pre_trust' ? 'not_applicable' : 'supported',
    indicator: input.trust === 'pre_trust' ? 'none' : 'typing',
    startsAfter: input.trust === 'pre_trust' ? 'not_applicable' : 'trusted_inbound',
    heartbeatMs: input.trust === 'pre_trust' ? undefined : CHANNEL_ACTION_TYPING_HEARTBEAT_MS,
    timeoutMs: CHANNEL_ACTION_TYPING_TIMEOUT_MS,
    failureMode: input.trust === 'pre_trust' ? 'not_applicable' : 'record_degraded_and_continue',
    masksBlockedState: false,
    evidence: input.trust === 'pre_trust' ? ['handler_alignment'] : ['telegram_send_chat_action', 'handler_alignment'],
    ...input.presence,
  }
  return {
    ...input,
    surface,
    safetyClass,
    capabilityRequirements: input.capabilityRequirements || capabilityRequirementsForBoundary(input.boundaryGroup),
    nativeUi,
    providerControls: providerControlsForAction(surface, input.trust, nativeUi, input.providerControls),
    presence,
    evidenceGates,
    evidence: input.evidence || 'canonical_channel_action_registry',
  }
}

function safetyClassForBoundary(boundary: ChannelActionBoundaryGroup): ChannelActionSafetyClass {
  if (boundary === 'read') return 'read_only'
  if (boundary === 'session_binding') return 'binding_change'
  if (boundary === 'human_loop') return 'human_decision'
  return 'work_mutation'
}

function capabilityRequirementsForBoundary(boundary: ChannelActionBoundaryGroup): string[] {
  if (boundary === 'read') return ['channel:read']
  if (boundary === 'session_binding') return ['channel:read', 'session:bind']
  if (boundary === 'human_loop') return ['channel:read', 'operator:decide']
  return ['channel:read', 'work:mutate']
}

function evidenceGatesForAction(boundary: ChannelActionBoundaryGroup): ChannelActionEvidenceGate[] {
  const gates: ChannelActionEvidenceGate[] = ['handler_alignment', 'renderer_fallback', 'adapter_contract']
  if (boundary !== 'read') gates.push('live_provider_proof')
  return gates
}

function actionNeedsArguments(usage: string): boolean {
  const text = String(usage || '').trim()
  return /^\/[a-z0-9_-]+\s+/i.test(text) || /[<[].+[>\]]/.test(text)
}

function providerControlsForAction(
  surface: ChannelOperatorAction['surface'],
  trust: ChannelActionTrust,
  nativeUi: ChannelActionNativeUiHints,
  overrides: Partial<Record<ChannelActionProvider, Partial<ChannelActionProviderControl>>> = {},
): ChannelActionProviderControl[] {
  const defaults: Record<ChannelActionProvider, ChannelActionProviderControl> = {
    telegram: {
      provider: 'telegram',
      slash: surface.telegramSlash,
      argumentAutocomplete: nativeUi.argumentAutocomplete,
      nativeAction: surface.richAction,
      presence: trust === 'pre_trust' ? 'not_applicable' : 'supported',
      fallback: 'copy_command',
      evidence: ['telegram_set_my_commands', 'telegram_send_chat_action', 'renderer_fallback'],
      summary: trust === 'pre_trust'
        ? 'Telegram exposes safe command verbs before trust; command arguments remain typed/copy fallback and typing feedback starts only after a target is trusted.'
        : 'Telegram registers native slash command verbs, keeps command arguments as typed/copy fallback, renders rich/copy actions where supported, and sends bounded typing feedback for trusted inbound work.',
    },
    whatsapp: {
      provider: 'whatsapp',
      slash: 'not_applicable',
      argumentAutocomplete: 'not_applicable',
      nativeAction: surface.richAction === 'supported' ? 'partial' : surface.richAction,
      presence: 'deferred',
      fallback: 'typed_command',
      evidence: ['renderer_fallback', 'adapter_contract', 'live_provider_proof'],
      summary: 'WhatsApp has typed-command and list/button fallback metadata; provider-native slash and typing are not claimed without live provider proof.',
    },
    discord: {
      provider: 'discord',
      slash: 'deferred',
      argumentAutocomplete: 'deferred',
      nativeAction: 'deferred',
      presence: 'deferred',
      fallback: 'typed_command',
      evidence: ['renderer_fallback', 'adapter_contract', 'live_provider_proof'],
      summary: 'Discord controls remain contract-level alpha metadata until an enabled provider adapter and live proof exist.',
    },
  }
  return CHANNEL_ACTION_PROVIDERS.map(provider => ({ ...defaults[provider], ...(overrides[provider] || {}) }))
}

export const CHANNEL_OPERATOR_ACTIONS: ChannelOperatorAction[] = [
  action({
    id: 'gateway.help',
    label: 'Help',
    primaryCommand: 'help',
    aliases: ['start', 'commands'],
    nativeAliases: [
      { command: 'start', description: 'Start Gateway and show help' },
      { command: 'commands', description: 'Show command menu' },
    ],
    description: 'Show command help',
    usage: '/help',
    category: 'setup',
    boundaryGroup: 'read',
    trust: 'pre_trust',
    menu: true,
    menuDescription: 'Show typed command help',
  }),
  action({
    id: 'session.new',
    label: 'New Session',
    primaryCommand: 'new',
    description: 'Create and bind a fresh OpenCode Session from this channel.',
    usage: '/new [title]',
    category: 'session',
    boundaryGroup: 'session_binding',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'channel.whereami',
    label: 'Where Am I',
    primaryCommand: 'whereami',
    description: 'Show channel trust, binding, project, and notification context.',
    usage: '/whereami',
    category: 'setup',
    boundaryGroup: 'read',
    trust: 'pre_trust',
  }),
  action({
    id: 'session.list_select',
    label: 'Sessions',
    primaryCommand: 'session',
    aliases: ['sessions'],
    description: 'List or select recent OpenCode Sessions for this channel.',
    usage: '/session [list|select <sessionId>]',
    category: 'session',
    boundaryGroup: 'session_binding',
    trust: 'trusted_privileged',
    menu: true,
    menuDescription: 'List bound Sessions',
  }),
  action({
    id: 'session.switch',
    label: 'Switch',
    primaryCommand: 'switch',
    description: 'Switch this channel to a Session, Project alias, or Project record.',
    usage: '/switch <sessionId|projectAlias|roadmapId>',
    category: 'session',
    boundaryGroup: 'session_binding',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'binding.bind',
    label: 'Bind',
    primaryCommand: 'bind',
    description: 'Bind this channel to a Session, Project, or Issue.',
    usage: '/bind <session|project|issue> ... [--rebind]',
    category: 'binding',
    boundaryGroup: 'session_binding',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'binding.unbind',
    label: 'Unbind',
    primaryCommand: 'unbind',
    description: 'Remove this channel binding.',
    usage: '/unbind',
    category: 'binding',
    boundaryGroup: 'session_binding',
    trust: 'trusted_privileged',
    menu: true,
    menuDescription: 'Remove this chat binding',
  }),
  action({
    id: 'status.summary',
    label: 'Status',
    primaryCommand: 'status',
    description: 'Show Channel binding and Issue queue status',
    usage: '/status',
    category: 'diagnostics',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Channel binding and Issue queue status',
    surface: { missionControl: 'supported' },
  }),
  action({
    id: 'status.current',
    label: 'Current',
    primaryCommand: 'current',
    description: 'Show current Issue, Project, or Session binding target.',
    usage: '/current',
    category: 'diagnostics',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Bound Issue or Session',
  }),
  action({
    id: 'status.open',
    label: 'Open',
    primaryCommand: 'open',
    description: 'Return OpenCode Web/TUI, Mission Control, and evidence fallback links.',
    usage: '/open [sessionId|projectAlias|roadmapId]',
    category: 'diagnostics',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'OpenCode Web/TUI links',
  }),
  action({
    id: 'status.latest',
    label: 'Latest',
    primaryCommand: 'latest',
    description: 'Show latest Issue/Run context for the current binding.',
    usage: '/latest',
    category: 'diagnostics',
    boundaryGroup: 'read',
    trust: 'trusted',
  }),
  ...(['pause', 'resume', 'cancel', 'retry', 'done', 'block'] as const).map(command => action({
    id: `issue.${command}`,
    label: command[0]!.toUpperCase() + command.slice(1),
    primaryCommand: command,
    description: `${command[0]!.toUpperCase() + command.slice(1)} the bound Issue.`,
    usage: `/${command} [note]`,
    category: 'issue',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
  })),
  action({
    id: 'issue.list',
    label: 'Issues',
    primaryCommand: 'issues',
    aliases: ['tasks'],
    description: 'List active Issues.',
    usage: '/issues',
    category: 'issue',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'List current Issues',
  }),
  action({
    id: 'project.list',
    label: 'Initiatives',
    primaryCommand: 'initiatives',
    aliases: ['roadmaps'],
    description: 'List active Projects/Initiatives.',
    usage: '/initiatives',
    category: 'project',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'List current Projects/Initiatives',
  }),
  action({
    id: 'project.manage',
    label: 'Project',
    primaryCommand: 'project',
    aliases: ['p'],
    description: 'Create, bind, inspect, and manage a Project',
    usage: '/project <create|bind|status|digest|watch|unwatch|notify|quiet|review-now|complete|open|pause|resume|unbind> [alias]',
    category: 'project',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'project.digest',
    label: 'Digest',
    primaryCommand: 'digest',
    description: 'Show the current Project digest.',
    usage: '/digest [alias]',
    category: 'project',
    boundaryGroup: 'read',
    trust: 'trusted',
  }),
  action({
    id: 'project.watch',
    label: 'Watch',
    primaryCommand: 'watch',
    description: 'Watch Project notifications.',
    usage: '/watch [alias]',
    category: 'project',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'project.unwatch',
    label: 'Unwatch',
    primaryCommand: 'unwatch',
    description: 'Mute Project notifications.',
    usage: '/unwatch [alias]',
    category: 'project',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'project.completion',
    label: 'Completion',
    primaryCommand: 'completion',
    aliases: ['complete'],
    description: 'Review, approve, or reject Project completion proposals.',
    usage: '/completion [list|approve|reject] [proposalId] [note]',
    category: 'project',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
    menu: true,
    menuDescription: 'Review Project completion proposals',
  }),
  action({
    id: 'issue.manage',
    label: 'Issue',
    primaryCommand: 'issue',
    aliases: ['task'],
    description: 'Act on an Issue by ID.',
    usage: '/issue <pause|resume|cancel|retry|done|block> <taskId> [note]',
    category: 'issue',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'scheduler.manage',
    label: 'Scheduler',
    primaryCommand: 'scheduler',
    description: 'Show or control scheduler state.',
    usage: '/scheduler <status|pause|resume|run>',
    category: 'scheduler',
    boundaryGroup: 'work_control',
    trust: 'trusted_privileged',
    menu: true,
    menuDescription: 'Scheduler state',
  }),
  action({
    id: 'governance.budget',
    label: 'Budget',
    primaryCommand: 'governance',
    aliases: ['budget'],
    description: 'Show budget, token, cost, and runtime governance state.',
    usage: '/governance',
    category: 'governance',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Budget status',
  }),
  action({
    id: 'attention.list',
    label: 'Attention',
    primaryCommand: 'attention',
    aliases: ['needs-attention'],
    nativeCommand: 'needs_attention',
    nativeAliases: [
      { command: 'attention', description: 'Show human decisions needed' },
      { command: 'needs_attention', description: 'Alias for attention' },
    ],
    description: 'Show human decisions needed',
    usage: '/attention',
    category: 'attention',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Unified Needs Attention',
    surface: { missionControl: 'supported' },
  }),
  action({
    id: 'gate.list',
    label: 'Gates',
    primaryCommand: 'gates',
    description: 'List pending Gateway human gates.',
    usage: '/gates',
    category: 'human_loop',
    boundaryGroup: 'read',
    trust: 'trusted',
  }),
  action({
    id: 'gate.decide',
    label: 'Gate',
    primaryCommand: 'gate',
    description: 'Approve or reject a Gateway human gate.',
    usage: '/gate <approve|reject> <gateId> [once|always] [note]',
    category: 'human_loop',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'alert.list',
    label: 'Alerts',
    primaryCommand: 'alerts',
    description: 'Show active Gateway alerts.',
    usage: '/alerts',
    category: 'attention',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Active Gateway alerts',
  }),
  action({
    id: 'alert.manage',
    label: 'Alert',
    primaryCommand: 'alert',
    description: 'Acknowledge, resolve, or suppress an alert.',
    usage: '/alert <ack|resolve|suppress> <alertId> [note]',
    category: 'attention',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'incident.generate',
    label: 'Incident',
    primaryCommand: 'incident',
    description: 'Generate a redacted incident report.',
    usage: '/incident [alertId]',
    category: 'diagnostics',
    boundaryGroup: 'read',
    trust: 'trusted',
  }),
  action({
    id: 'question.list',
    label: 'Questions',
    primaryCommand: 'questions',
    description: 'List pending OpenCode-native questions.',
    usage: '/questions',
    category: 'human_loop',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Pending OpenCode Questions',
  }),
  action({
    id: 'permission.list',
    label: 'Permissions',
    primaryCommand: 'permissions',
    description: 'List pending OpenCode-native permission requests.',
    usage: '/permissions',
    category: 'human_loop',
    boundaryGroup: 'read',
    trust: 'trusted',
    menu: true,
    menuDescription: 'Pending OpenCode Permissions',
  }),
  action({
    id: 'question.answer',
    label: 'Answer',
    primaryCommand: 'answer',
    description: 'Answer an OpenCode-native question.',
    usage: '/answer <questionId> <label-or-answer>',
    category: 'human_loop',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'question.reject',
    label: 'Reject Question',
    primaryCommand: 'reject-question',
    nativeCommand: 'reject_question',
    description: 'Reject an OpenCode question',
    usage: '/reject-question <questionId>',
    category: 'human_loop',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'permission.approve',
    label: 'Approve',
    primaryCommand: 'approve',
    description: 'Approve an OpenCode-native permission request.',
    usage: '/approve <permissionId> [once|always]',
    category: 'human_loop',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
  action({
    id: 'permission.deny',
    label: 'Deny',
    primaryCommand: 'deny',
    description: 'Deny an OpenCode-native permission request.',
    usage: '/deny <permissionId> [message]',
    category: 'human_loop',
    boundaryGroup: 'human_loop',
    trust: 'trusted_privileged',
  }),
]

export function channelActionMenuItems(): ChannelActionMenuItem[] {
  return CHANNEL_OPERATOR_ACTIONS
    .filter(action => action.menu)
    .map(action => ({
      label: action.label,
      command: `/${action.primaryCommand}`,
      description: action.menuDescription || action.description,
    }))
}

export function channelActionNativeSlashCommands(): ChannelActionNativeSlashCommand[] {
  return CHANNEL_OPERATOR_ACTIONS.flatMap(action => {
    const commands = [action.nativeCommand || action.primaryCommand]
    for (const alias of action.aliases || []) {
      if (/^[a-z0-9_]+$/.test(alias)) commands.push(alias)
    }
    const native = [...new Set(commands)].map(command => ({ command, description: action.description }))
    const byCommand = new Map(native.map(command => [command.command, command]))
    for (const alias of action.nativeAliases || []) byCommand.set(alias.command, alias)
    return [...byCommand.values()]
  })
}

export function telegramNativeSlashCommandManifest(): ChannelActionNativeSlashManifest {
  const commands = channelActionNativeSlashCommands()
  const violations: string[] = []
  if (commands.length > TELEGRAM_NATIVE_COMMAND_LIMIT) {
    violations.push(`command_count_exceeds_${TELEGRAM_NATIVE_COMMAND_LIMIT}`)
  }
  const seen = new Set<string>()
  for (const command of commands) {
    if (!TELEGRAM_NATIVE_COMMAND_PATTERN.test(command.command)) violations.push(`invalid_command:${command.command}`)
    if (seen.has(command.command)) violations.push(`duplicate_command:${command.command}`)
    seen.add(command.command)
    if (!command.description || command.description.length > TELEGRAM_NATIVE_COMMAND_DESCRIPTION_LIMIT) {
      violations.push(`invalid_description:${command.command}`)
    }
  }
  return {
    provider: 'telegram',
    registration: 'setMyCommands',
    commands,
    commandCount: commands.length,
    commandLimit: TELEGRAM_NATIVE_COMMAND_LIMIT,
    commandPattern: TELEGRAM_NATIVE_COMMAND_PATTERN.source,
    descriptionLimit: TELEGRAM_NATIVE_COMMAND_DESCRIPTION_LIMIT,
    commandVerbAutocomplete: 'supported',
    argumentAutocomplete: 'deferred',
    argumentFallback: 'copy_command',
    valid: violations.length === 0,
    violations,
    unsupportedClaims: [
      'telegram_argument_autocomplete',
      'telegram_subcommand_autocomplete',
      'provider_native_slashability_across_all_channels',
    ],
  }
}

export function channelActionParityMatrix(): ChannelActionParityRow[] {
  return CHANNEL_OPERATOR_ACTIONS.map(action => ({
    id: action.id,
    label: action.label,
    command: `/${action.primaryCommand}`,
    category: action.category,
    trust: action.trust,
    safetyClass: action.safetyClass,
    capabilityRequirements: action.capabilityRequirements,
    nativeUi: action.nativeUi,
    providerControls: providerControlsByProvider(action.providerControls),
    presence: action.presence,
    evidenceGates: action.evidenceGates,
    surfaces: action.surface,
    evidence: action.evidence,
  }))
}

export function channelActionProviderControlSummary(provider: ChannelActionProvider): ChannelActionProviderControlSummary {
  const controls = CHANNEL_OPERATOR_ACTIONS.map(action => action.providerControls.find(control => control.provider === provider)).filter((control): control is ChannelActionProviderControl => Boolean(control))
  const fallback = [...new Set(controls.map(control => control.fallback))].sort() as ChannelActionNativeFallback[]
  const evidence = [...new Set(controls.flatMap(control => control.evidence))].sort() as ChannelActionEvidenceGate[]
  return {
    provider,
    typedCommand: 'supported',
    slash: aggregateControlStatus(controls.map(control => control.slash)),
    argumentAutocomplete: aggregateControlStatus(controls.map(control => control.argumentAutocomplete)),
    nativeAction: aggregateControlStatus(controls.map(control => control.nativeAction)),
    presence: aggregateControlStatus(controls.map(control => control.presence)),
    actionCount: controls.length,
    fallback,
    evidence,
    summary: providerControlSummaryText(provider, controls),
  }
}

export function channelActionProviderControlSummaries(): ChannelActionProviderControlSummary[] {
  return CHANNEL_ACTION_PROVIDERS.map(channelActionProviderControlSummary)
}

export function channelPermissionDecisionContract(): ChannelPermissionDecisionContract {
  return {
    gatewayOwned: [
      {
        action: 'gateway.human_gate',
        owner: 'gateway',
        command: '/gate <approve|reject> <gateId> [once|always] [note]',
        receipt: 'Gateway records the human-gate decision in durable work state before continuing delegated work.',
      },
      {
        action: 'gateway.completion_proposal',
        owner: 'gateway',
        command: '/completion <approve|reject> <proposalId> [note]',
        receipt: 'Gateway records the roadmap completion proposal decision and emits work events.',
      },
    ],
    opencodeOwned: [
      {
        action: 'opencode.permission_reply',
        owner: 'opencode',
        command: '/approve <permissionId> [once|always] or /deny <permissionId> [message]',
        receipt: 'Gateway forwards the answer to OpenCode; OpenCode owns the final permission receipt.',
      },
      {
        action: 'opencode.question_reply',
        owner: 'opencode',
        command: '/answer <questionId> <label-or-answer> or /reject-question <questionId>',
        receipt: 'Gateway forwards the answer to OpenCode; OpenCode owns the final question receipt.',
      },
    ],
    boundary: 'Gateway-owned human gates mutate Gateway state; OpenCode permissions/questions are channel fallbacks that forward decisions and wait for OpenCode-owned receipts.',
  }
}

export function buildChannelUxContractReport(inputs: ChannelUxContractReportInputs = {}): ChannelUxContractReport {
  const telegramNative = inputs.telegramNative || telegramNativeSlashCommandManifest()
  const providerControls = inputs.providerControls || channelActionProviderControlSummaries()
  const permissionDecisionContract = inputs.permissionDecisionContract || channelPermissionDecisionContract()
  const telegram = providerControls.find(row => row.provider === 'telegram')
  const whatsapp = providerControls.find(row => row.provider === 'whatsapp')
  const discord = providerControls.find(row => row.provider === 'discord')
  const acceptance = {
    typedFallbackVisible: providerControls.every(row => row.typedCommand === 'supported' && row.fallback.length > 0),
    telegramNativeCommandsAligned: telegramNative.valid
      && telegramNative.commandVerbAutocomplete === 'supported'
      && telegramNative.commands.every(command => TELEGRAM_NATIVE_COMMAND_PATTERN.test(command.command)),
    telegramArgumentFallbackExplicit: telegramNative.argumentAutocomplete === 'deferred'
      && telegramNative.argumentFallback === 'copy_command'
      && telegram?.argumentAutocomplete === 'deferred',
    providerPresenceTruthful: telegram?.presence === 'supported'
      && whatsapp?.presence === 'deferred'
      && discord?.presence === 'deferred',
    permissionOwnershipExplicit: permissionDecisionContract.gatewayOwned.length > 0
      && permissionDecisionContract.opencodeOwned.length > 0
      && permissionDecisionContract.opencodeOwned.every(row => row.receipt.includes('OpenCode owns')),
    whatsappDiscordNotOverclaimed: whatsapp?.slash === 'not_applicable'
      && whatsapp?.nativeAction !== 'supported'
      && whatsapp?.presence === 'deferred'
      && discord?.slash === 'deferred'
      && discord?.nativeAction === 'deferred'
      && discord?.presence === 'deferred',
  }
  const errors = Object.entries(acceptance)
    .filter(([, ok]) => !ok)
    .map(([name]) => `acceptance_failed:${name}`)
  if (telegramNative.unsupportedClaims.length === 0) errors.push('telegram_native_unsupported_claims_missing')
  return {
    schemaVersion: 1,
    mode: 'm41_channel_command_presence_permission_action_contract',
    status: errors.length ? 'failed' : 'passed',
    releaseClaimEffect: 'local_beta_channel_ux_contract_only_no_universal_or_whatsapp_live_claim',
    summary: errors.length
      ? 'Channel UX contract has unresolved command, presence, permission, or provider-fallback drift.'
      : 'Channel UX contract aligns typed commands, Telegram native command verbs, provider fallbacks, bounded presence, and permission ownership without expanding channel claims.',
    telegramNative,
    providerControls,
    permissionDecisionContract,
    acceptance,
    errors,
    unsupportedClaims: [
      ...telegramNative.unsupportedClaims,
      'universal_channel_readiness',
      'whatsapp_live_readiness_without_redacted_live_provider_proof',
      'discord_live_or_production_readiness',
      'provider_native_typing_parity_across_all_channels',
      'provider_native_argument_autocomplete',
    ],
  }
}

export function formatChannelUxTruthForHelp(report: ChannelUxContractReport = buildChannelUxContractReport()): string[] {
  const telegram = report.providerControls.find(row => row.provider === 'telegram')
  const whatsapp = report.providerControls.find(row => row.provider === 'whatsapp')
  const discord = report.providerControls.find(row => row.provider === 'discord')
  return [
    'Channel UX truth:',
    `- Telegram: / menu completes command verbs only; arguments/subcommands stay ${fallbackLabel(report.telegramNative.argumentFallback)} fallback.`,
    `- Telegram typing: bounded trusted-chat feedback (${Math.round(CHANNEL_ACTION_TYPING_HEARTBEAT_MS / 1000)}s heartbeat, ${Math.round(CHANNEL_ACTION_TYPING_TIMEOUT_MS / 1000)}s max); failures are degraded and replies continue.`,
    `- WhatsApp: ${surfaceLabel(whatsapp?.slash || 'not_applicable')} slash, ${surfaceLabel(whatsapp?.presence || 'deferred')} presence; typed/list fallback remains the safe path until live proof.`,
    `- Discord: ${surfaceLabel(discord?.slash || 'deferred')} slash, ${surfaceLabel(discord?.presence || 'deferred')} presence; alpha metadata only until adapter/live proof.`,
    `- Permissions: ${report.permissionDecisionContract.boundary}`,
    `- Telegram native evidence: verbs ${surfaceLabel(telegram?.slash || 'unknown')}, argument autocomplete ${surfaceLabel(report.telegramNative.argumentAutocomplete)}; no universal-channel or WhatsApp-live claim.`,
  ]
}

function fallbackLabel(fallback: ChannelActionNativeFallback): string {
  switch (fallback) {
    case 'copy_command':
      return 'typed/copy'
    case 'typed_command':
      return 'typed-command'
    case 'text_menu':
      return 'text-menu'
    default:
      return assertNeverFallback(fallback)
  }
}

function surfaceLabel(status: ChannelActionSurfaceStatus | 'unknown'): string {
  if (status === 'not_applicable') return 'no provider-native'
  return status.replace(/_/g, '-')
}

function assertNeverFallback(fallback: never): never {
  throw new Error(`Unsupported channel action fallback: ${String(fallback)}`)
}

function providerControlsByProvider(controls: ChannelActionProviderControl[]): Record<ChannelActionProvider, ChannelActionProviderControl> {
  const byProvider = new Map(controls.map(control => [control.provider, control]))
  return {
    telegram: byProvider.get('telegram')!,
    whatsapp: byProvider.get('whatsapp')!,
    discord: byProvider.get('discord')!,
  }
}

function aggregateControlStatus(statuses: ChannelActionSurfaceStatus[]): ChannelActionSurfaceStatus {
  const actionable = statuses.filter(status => status !== 'not_applicable')
  if (!actionable.length) return 'not_applicable'
  if (actionable.includes('blocked')) return 'blocked'
  if (actionable.includes('deferred')) return 'deferred'
  if (actionable.includes('partial')) return 'partial'
  return 'supported'
}

function providerControlSummaryText(provider: ChannelActionProvider, controls: ChannelActionProviderControl[]): string {
  const slash = aggregateControlStatus(controls.map(control => control.slash))
  const argumentAutocomplete = aggregateControlStatus(controls.map(control => control.argumentAutocomplete))
  const nativeAction = aggregateControlStatus(controls.map(control => control.nativeAction))
  const presence = aggregateControlStatus(controls.map(control => control.presence))
  if (provider === 'telegram') return `Telegram controls: slash verbs ${slash}, argument autocomplete ${argumentAutocomplete}, native actions ${nativeAction}, presence ${presence}; typed command fallback remains available.`
  if (provider === 'whatsapp') return `WhatsApp controls: slash ${slash}, argument autocomplete ${argumentAutocomplete}, native actions ${nativeAction}, presence ${presence}; typed/list fallback remains the safe path until live proof.`
  return `Discord controls: slash ${slash}, argument autocomplete ${argumentAutocomplete}, native actions ${nativeAction}, presence ${presence}; alpha metadata only until adapter/live proof.`
}
