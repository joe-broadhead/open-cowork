export type OperatorJourneySurface =
  | 'opencode_web_tui'
  | 'trusted_channel'
  | 'cli_mcp'
  | 'mission_control'
  | 'channel_controls'
  | 'support_diagnosis'

export type OperatorJourneyWaitOwner = 'none' | 'operator' | 'opencode' | 'gateway' | 'channel' | 'provider'

export type OperatorJourneyPermissionState =
  | 'not_required'
  | 'opencode_permission_required'
  | 'opencode_request_required'
  | 'gateway_decision_required'
  | 'channel_security_blocked'
  | 'operator_attention_required'
  | 'blocked'

export type OperatorJourneyRecoveryState = 'ready' | 'recoverable' | 'fallback' | 'blocked' | 'deferred'
export type OperatorJourneyCapabilityState = 'supported' | 'partial' | 'fallback' | 'blocked' | 'deferred'
export type OperatorJourneyProofState = 'passed' | 'partial' | 'missing' | 'blocked' | 'deferred' | 'waived'

export interface OperatorJourneyRecoveryPath {
  state: OperatorJourneyRecoveryState
  summary: string
  safeNextAction: string
  primarySurface: OperatorJourneySurface
  fallbackSurfaces: OperatorJourneySurface[]
}

export interface OperatorJourneySnapshot {
  schemaVersion: 1
  id: string
  surface: OperatorJourneySurface
  currentAction: string
  waitOwner: OperatorJourneyWaitOwner
  permissionState: OperatorJourneyPermissionState
  recoveryPath: OperatorJourneyRecoveryPath
  channelCapability: OperatorJourneyCapabilityState
  proofState: OperatorJourneyProofState
  safeNextAction: string
  limitations: string[]
  evidenceRefs: string[]
  releaseClaim: 'local_operator_journey_truth_only'
}

export interface OpenCodeSessionLinkJourneyInput {
  sessionId: string
  webStatus: 'metadata_only' | 'unavailable'
  webStatusReason: string
  webRecoveryHint: string
  webUrl?: string
  tuiCommand?: string
  missionControlUrl?: string
  sessionEvidenceUrl?: string
}

export interface ChannelControlSummaryLike {
  provider: string
  typedCommand: 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable' | string
  slash: 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable' | string
  argumentAutocomplete: 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable' | string
  nativeAction: 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable' | string
  presence: 'supported' | 'partial' | 'deferred' | 'blocked' | 'not_applicable' | string
  fallback: string[]
  evidence: string[]
  summary: string
}

export function openCodeSessionLinkJourney(links: OpenCodeSessionLinkJourneyInput): OperatorJourneySnapshot {
  const unavailable = links.webStatus === 'unavailable'
  const webMayBeStale = links.webStatus === 'metadata_only'
  const safeNextAction = links.webRecoveryHint || (unavailable ? 'Recover or rebind the OpenCode Session before opening Web.' : 'Open Web; if it fails, use TUI or Mission Control evidence.')
  return journey({
    id: `opencode-session:${safeId(links.sessionId)}`,
    surface: 'opencode_web_tui',
    currentAction: unavailable ? 'Recover OpenCode Session link' : 'Open or recover OpenCode Session',
    waitOwner: unavailable || webMayBeStale ? 'operator' : 'none',
    permissionState: 'not_required',
    recoveryPath: {
      state: unavailable ? 'recoverable' : 'fallback',
      summary: unavailable
        ? `OpenCode Web link is unavailable: ${clean(links.webStatusReason)}.`
        : `OpenCode Web link is metadata-only: ${clean(links.webStatusReason)}.`,
      safeNextAction,
      primarySurface: 'opencode_web_tui',
      fallbackSurfaces: ['cli_mcp', 'mission_control'],
    },
    channelCapability: unavailable ? 'fallback' : 'partial',
    proofState: unavailable ? 'missing' : 'partial',
    safeNextAction,
    limitations: [
      unavailable
        ? 'No stale Web deep link is emitted when OpenCode cannot resolve Session directory metadata.'
        : 'OpenCode Web can transiently report a metadata-only Session as missing; TUI and Mission Control are the deterministic fallback surfaces.',
      'OpenCode owns Session state, questions, permissions, and tool approval; Gateway only routes recovery links and evidence.',
    ],
    evidenceRefs: [
      `opencode_session:${safeId(links.sessionId)}:${links.webStatus}`,
      links.sessionEvidenceUrl ? `opencode_session_evidence:${safeId(links.sessionId)}` : undefined,
      links.missionControlUrl ? 'mission_control:dashboard' : undefined,
    ].filter((value): value is string => Boolean(value)),
  })
}

export function channelControlOperatorJourneys(summaries: ChannelControlSummaryLike[]): OperatorJourneySnapshot[] {
  return summaries.flatMap(summary => [
    channelControlJourney(summary, 'typedCommand', 'Use typed command fallback', 'Typed command input remains the canonical fallback for this provider.'),
    channelControlJourney(summary, 'slash', 'Use provider slash command', 'Provider-native command-verb discovery is optional; typed commands are the fallback.'),
    channelControlJourney(summary, 'argumentAutocomplete', 'Use typed command arguments', 'Provider-native argument autocomplete is not required; command arguments must remain copyable or typed.'),
    channelControlJourney(summary, 'nativeAction', 'Use rich action or menu control', 'Native rich controls must preserve the same command payload as typed fallback.'),
    channelControlJourney(summary, 'presence', 'Show typing or presence feedback', 'Presence must never mask blocked state or missing operator permission.'),
  ])
}

export function summarizeOperatorJourney(journeySnapshot: OperatorJourneySnapshot): string {
  return [
    `${journeySnapshot.currentAction}: ${journeySnapshot.channelCapability}`,
    `wait=${journeySnapshot.waitOwner}`,
    `permission=${journeySnapshot.permissionState}`,
    `proof=${journeySnapshot.proofState}`,
    `next=${journeySnapshot.safeNextAction}`,
  ].join('; ')
}

function channelControlJourney(
  summary: ChannelControlSummaryLike,
  field: 'typedCommand' | 'slash' | 'argumentAutocomplete' | 'nativeAction' | 'presence',
  currentAction: string,
  limitation: string,
): OperatorJourneySnapshot {
  const rawStatus = String(summary[field] || 'blocked')
  const capability = capabilityFromChannelStatus(rawStatus)
  const provider = safeId(summary.provider)
  const feature = field === 'typedCommand' ? 'typed_command' : field === 'nativeAction' ? 'native_action' : field === 'argumentAutocomplete' ? 'argument_autocomplete' : field
  const fallback = summary.fallback?.length ? summary.fallback.join(', ') : 'typed_command'
  const safeNextAction = channelControlNextAction(summary.provider, field, rawStatus, fallback)
  return journey({
    id: `channel:${provider}:${feature}`,
    surface: 'channel_controls',
    currentAction: `${displayProvider(summary.provider)} ${currentAction}`,
    waitOwner: waitOwnerFromChannelStatus(rawStatus),
    permissionState: 'not_required',
    recoveryPath: {
      state: recoveryFromChannelStatus(rawStatus),
      summary: `${displayProvider(summary.provider)} ${feature.replace(/_/g, ' ')} is ${rawStatus}.`,
      safeNextAction,
      primarySurface: 'channel_controls',
      fallbackSurfaces: rawStatus === 'supported' ? [] : ['trusted_channel', 'cli_mcp', 'mission_control'],
    },
    channelCapability: capability,
    proofState: proofFromChannelStatus(rawStatus),
    safeNextAction,
    limitations: [summary.summary, limitation],
    evidenceRefs: [`channel_control:${provider}:${feature}:${safeId(rawStatus)}`, ...(summary.evidence || []).map(ref => `channel_evidence:${safeId(ref)}`)],
  })
}

function journey(input: Omit<OperatorJourneySnapshot, 'schemaVersion' | 'releaseClaim'>): OperatorJourneySnapshot {
  return {
    schemaVersion: 1,
    releaseClaim: 'local_operator_journey_truth_only',
    ...input,
    safeNextAction: clean(input.safeNextAction),
    limitations: input.limitations.map(value => clean(value)).filter(Boolean),
    evidenceRefs: input.evidenceRefs.filter((value): value is string => Boolean(value)).map(value => clean(value, 180)),
  }
}

function capabilityFromChannelStatus(status: string): OperatorJourneyCapabilityState {
  if (status === 'supported') return 'supported'
  if (status === 'partial') return 'partial'
  if (status === 'deferred') return 'deferred'
  if (status === 'not_applicable') return 'fallback'
  return 'blocked'
}

function proofFromChannelStatus(status: string): OperatorJourneyProofState {
  if (status === 'supported') return 'passed'
  if (status === 'partial' || status === 'not_applicable') return 'partial'
  if (status === 'deferred') return 'deferred'
  return 'blocked'
}

function recoveryFromChannelStatus(status: string): OperatorJourneyRecoveryState {
  if (status === 'supported' || status === 'partial') return 'ready'
  if (status === 'not_applicable') return 'fallback'
  if (status === 'deferred') return 'deferred'
  return 'blocked'
}

function waitOwnerFromChannelStatus(status: string): OperatorJourneyWaitOwner {
  if (status === 'supported' || status === 'partial' || status === 'not_applicable') return 'none'
  if (status === 'deferred') return 'provider'
  return 'operator'
}

function channelControlNextAction(provider: string, field: 'typedCommand' | 'slash' | 'argumentAutocomplete' | 'nativeAction' | 'presence', status: string, fallback: string): string {
  if (status === 'supported') return `${displayProvider(provider)} ${featureLabel(field)} is supported; use it directly.`
  if (status === 'partial') return `${displayProvider(provider)} ${featureLabel(field)} is partial; keep ${fallback} visible.`
  if (status === 'not_applicable') return `${displayProvider(provider)} ${featureLabel(field)} is not provider-native; use ${fallback}.`
  if (status === 'deferred') return `${displayProvider(provider)} ${featureLabel(field)} is deferred until provider proof lands; use ${fallback}.`
  return `${displayProvider(provider)} ${featureLabel(field)} is blocked; repair setup or use ${fallback}.`
}

function featureLabel(field: 'typedCommand' | 'slash' | 'argumentAutocomplete' | 'nativeAction' | 'presence'): string {
  if (field === 'typedCommand') return 'typed commands'
  if (field === 'argumentAutocomplete') return 'argument autocomplete'
  if (field === 'nativeAction') return 'rich actions/menus'
  if (field === 'presence') return 'typing/presence'
  return 'slash commands'
}

function displayProvider(provider: string): string {
  if (provider === 'whatsapp') return 'WhatsApp'
  return provider ? provider[0]!.toUpperCase() + provider.slice(1) : 'Channel'
}

function safeId(value: unknown): string {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 120)
}

function clean(value: unknown, maxLength = 400): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text
}
