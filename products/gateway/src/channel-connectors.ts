import { getConfig, type GatewayConfig } from './config.js'
import { listChannelSessions, type ChannelSessionLink } from './channel-sessions.js'
import { listActiveChannelClaimCodeRefs } from './channel-claims.js'
import {
  CHANNEL_CONNECTOR_STATE_DEFINITIONS,
  getChannelCapabilities,
  listChannelCapabilities,
  type ChannelCapabilities,
  type ChannelConnectorState,
  type ChannelCredentialRequirement,
  type ChannelOnboardingAction,
  type ChannelSetupDiagnosticCode,
  type ChannelSetupDiagnosticDefinition,
  type ChannelSetupDiagnosticSeverity,
  type ChannelSetupMode,
  type ChannelSetupPathDefinition,
  type ChannelSetupPathStatus,
  type ChannelWebhookRouteRequirement,
} from './channels/capabilities.js'
import { allowsAllChannelTargets, hasChannelAllowlist } from './security.js'
import { verifyChannelWebhookExposure, type WebhookRouteVerification, type WebhookVerificationResult } from './webhook-verifier.js'

export type ChannelConnectorPrerequisiteKind =
  | 'credential'
  | 'enablement'
  | 'webhook'
  | 'verification'
  | 'trust'
  | 'binding'
  | 'provider'

export type ChannelConnectorReadinessStatus = 'ready' | 'missing' | 'unsupported' | 'not_applicable'
export type ChannelConnectorRouteExposure = 'public_webhook_mode' | 'authenticated_reverse_proxy' | 'local_only' | 'unsafe_public' | 'not_applicable'

export interface ChannelCredentialStatus {
  key: string
  label: string
  configured: boolean
  secret: boolean
  env?: string
  configKey?: string
  sources: Array<'environment' | 'config'>
}

export interface ChannelConnectorMissingPrerequisite {
  kind: ChannelConnectorPrerequisiteKind
  code: ChannelSetupDiagnosticCode
  key: string
  label: string
  env?: string
  configKey?: string
  secret?: boolean
  remediation: string
}

export interface ChannelConnectorDiagnostic {
  code: ChannelSetupDiagnosticCode
  state: ChannelConnectorState
  severity: ChannelSetupDiagnosticSeverity
  summary: string
  remediation: string
}

export interface ChannelConnectorCallbackStatus {
  required: boolean
  publicWebhookMode: boolean
  routeExposure: ChannelConnectorRouteExposure
  routes: ChannelWebhookRouteRequirement[]
  routeChecks: WebhookRouteVerification[]
  challenge: ChannelConnectorReadinessStatus
  signature: ChannelConnectorReadinessStatus
  verifier: WebhookVerificationResult
}

export interface ChannelConnectorSetupPath {
  key: string
  label: string
  modes: ChannelSetupMode[]
  implementationStatus: ChannelSetupPathStatus
  active: boolean
  configured: boolean
  available: boolean
  state: ChannelConnectorState
  summary: string
  nextActions: string[]
  prerequisites: string[]
  env: string[]
  configKeys: string[]
  docs: Array<{ label: string; url: string }>
  diagnostics: ChannelConnectorDiagnostic[]
}

export interface ChannelConnectorStatus {
  provider: string
  displayName: string
  stage: ChannelCapabilities['stage']
  modes: ChannelSetupMode[]
  activeSetupPath?: string
  setupPaths: ChannelConnectorSetupPath[]
  state: ChannelConnectorState
  stateSummary: string
  enabled: boolean
  configured: boolean
  trusted: boolean
  unsafeAllowAll: boolean
  bindingCount: number
  credentials: ChannelCredentialStatus[]
  missingPrerequisites: ChannelConnectorMissingPrerequisite[]
  diagnostics: ChannelConnectorDiagnostic[]
  nextActions: ChannelOnboardingAction[]
  callback: ChannelConnectorCallbackStatus
  onboardingFlow: ChannelOnboardingFlow
  evidenceRefs: string[]
  redacted: true
}

export type ChannelOnboardingStepId = ChannelOnboardingAction | 'monitor'
export type ChannelOnboardingStepStatus = 'done' | 'current' | 'blocked' | 'pending'

export interface ChannelOnboardingFlowAction {
  label: string
  summary: string
  command?: string
  refs: string[]
}

export interface ChannelOnboardingFlowStep {
  id: ChannelOnboardingStepId
  label: string
  status: ChannelOnboardingStepStatus
  summary: string
  primaryAction: ChannelOnboardingFlowAction
  fallbackAction?: ChannelOnboardingFlowAction
  refs: string[]
  blockers: string[]
}

export interface ChannelOnboardingFlow {
  path: ChannelOnboardingStepId[]
  currentStep: ChannelOnboardingStepId
  primaryAction: ChannelOnboardingFlowAction
  fallbackAction?: ChannelOnboardingFlowAction
  steps: ChannelOnboardingFlowStep[]
  redacted: true
}

export interface ChannelConnectorRegistry {
  generatedAt: string
  connectors: ChannelConnectorStatus[]
  counts: Record<ChannelConnectorState, number>
}

export interface ChannelConnectorRegistryOptions {
  config?: GatewayConfig
  capabilities?: ChannelCapabilities[]
  bindings?: ChannelSessionLink[]
  activeClaimRefs?: Record<string, string[]>
  generatedAt?: string
}

export const UNIVERSAL_CHANNEL_ONBOARDING_PATH: ChannelOnboardingStepId[] = ['connect', 'verify', 'trust', 'bind', 'monitor']

export function buildChannelConnectorRegistry(options: ChannelConnectorRegistryOptions = {}): ChannelConnectorRegistry {
  const config = options.config || getConfig()
  const capabilities = options.capabilities || listChannelCapabilities()
  const bindings = options.bindings || listChannelSessions()
  const connectors = capabilities
    .map(capability => buildChannelConnectorStatus(capability, { ...options, config, bindings }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
  const counts = Object.keys(CHANNEL_CONNECTOR_STATE_DEFINITIONS).reduce((acc, state) => {
    acc[state as ChannelConnectorState] = 0
    return acc
  }, {} as Record<ChannelConnectorState, number>)
  for (const connector of connectors) counts[connector.state] += 1
  return { generatedAt: options.generatedAt || new Date().toISOString(), connectors, counts }
}

function buildChannelConnectorStatus(capability: ChannelCapabilities, options: ChannelConnectorRegistryOptions & { config: GatewayConfig; bindings: ChannelSessionLink[] }): ChannelConnectorStatus {
  const provider = capability.provider
  const credentials = capability.onboarding.credentials.map(credential => credentialStatus(credential, options.config))
  const bindingCount = options.bindings.filter(binding => binding.provider === provider).length
  const unsafeAllowAll = providerRequiresExplicitTrust(provider, capability) && allowsAllChannelTargets(provider, options.config)
  const trusted = !providerRequiresExplicitTrust(provider, capability) || hasChannelAllowlist(provider, options.config) || unsafeAllowAll
  const enabled = providerEnabled(provider, options.config)
  const pendingClaimRefs = safeEvidenceRefs(options.activeClaimRefs ? (options.activeClaimRefs[provider] || []) : listActiveChannelClaimCodeRefs(provider))
  const callback = callbackStatus(capability, options.config, credentials)
  const activeSetupPathKey = activeSetupPathKeyFor(provider, options.config)
  const setupPaths = setupPathStatuses(capability, options.config, credentials, {
    provider,
    enabled,
    callback,
    trusted,
    unsafeAllowAll,
    bindingCount,
    activeKey: activeSetupPathKey,
  })
  const activeSetupPath = setupPaths.find(path => path.active)
  const activeSetupPathUnavailable = Boolean(activeSetupPath && activeSetupPath.implementationStatus !== 'implemented')
  const missing: ChannelConnectorMissingPrerequisite[] = []
  const diagnostics: ChannelConnectorDiagnostic[] = []

  const addDiagnostic = (code: ChannelSetupDiagnosticCode, kind: ChannelConnectorPrerequisiteKind, key: string, label: string, extra: Partial<ChannelConnectorMissingPrerequisite> = {}) => {
    const diagnostic = diagnosticFor(capability, code)
    diagnostics.push(toDiagnostic(diagnostic))
    missing.push({
      kind,
      code,
      key,
      label,
      remediation: diagnostic.remediation,
      ...extra,
    })
  }

  if (activeSetupPathUnavailable && activeSetupPath) {
    addDiagnostic('provider_unavailable', 'provider', `${provider}_${activeSetupPath.key}`, activeSetupPath.label)
  } else if (provider === 'discord' && !enabled) {
    addDiagnostic('provider_disabled', 'enablement', 'discord_alpha_enabled', 'Discord alpha enablement', credentialRef(credentials.find(row => row.key === 'discord_alpha_enabled')))
  } else {
    const missingCredentials = missingCredentialRequirements(provider, credentials)
    for (const credential of missingCredentials) {
      const kind: ChannelConnectorPrerequisiteKind = credential.key.endsWith('_enabled') ? 'enablement' : 'credential'
      addDiagnostic('missing_credentials', kind, credential.key, credential.label, credentialRef(credential))
    }
  }

  if (callback.required && callback.routeExposure === 'local_only') {
    addDiagnostic('callback_url_missing', 'webhook', `${provider}_callback_url`, `${capability.displayName} callback URL`)
  }

  if (callback.challenge === 'missing') {
    addDiagnostic('verify_token_mismatch', 'verification', `${provider}_challenge`, `${capability.displayName} webhook challenge`)
  }

  if (callback.signature === 'missing') {
    addDiagnostic('signature_verification_missing', 'verification', `${provider}_signature`, `${capability.displayName} signature verification`)
  }

  if (callback.verifier.issues.some(issue => issue.code === 'unsafe_broad_exposure')) {
    const diagnostic = diagnosticFor(capability, 'unsafe_route_exposure')
    diagnostics.push(toDiagnostic(diagnostic))
    missing.push({
      kind: 'webhook',
      code: 'unsafe_route_exposure',
      key: `${provider}_route_exposure`,
      label: `${capability.displayName} route exposure`,
      remediation: diagnostic.remediation,
    })
  }

  if (providerRequiresExplicitTrust(provider, capability)) {
    if (!trusted) addDiagnostic('missing_allowlist', 'trust', `${provider}_allowlist`, `${capability.displayName} trusted target allowlist`, { configKey: capability.onboarding.trust.allowlistConfigKey })
    if (unsafeAllowAll) {
      const diagnostic = diagnosticFor(capability, 'unsafe_route_exposure')
      diagnostics.push({
        ...toDiagnostic(diagnostic),
        summary: 'Unsafe allow-all channel target override is enabled.',
        remediation: `Replace security.unsafeAllowAllChannelTargets.${provider}=true with an explicit ${capability.onboarding.trust.allowlistConfigKey || 'channel allowlist'} before production use.`,
      })
    }
  }

  if (enabled && trusted && bindingCount === 0) {
    addDiagnostic('binding_missing', 'binding', `${provider}_binding`, `${capability.displayName} channel binding`)
  }

  const resolvedState = resolveConnectorState({
    provider,
    enabled,
    credentials,
    callback,
    trusted,
    unsafeAllowAll,
    bindingCount,
  })
  const state = activeSetupPathUnavailable ? 'blocked' : resolvedState

  const nextActions = [...new Set([
    ...CHANNEL_CONNECTOR_STATE_DEFINITIONS[state].nextActions,
    ...actionsForMissingPrerequisites(missing),
    ...diagnostics.flatMap(diagnostic => CHANNEL_CONNECTOR_STATE_DEFINITIONS[diagnostic.state]?.nextActions || []),
  ])].filter(action => capability.onboarding.actions.includes(action as ChannelOnboardingAction)) as ChannelOnboardingAction[]

  const evidenceRefs = [
    ...credentials.flatMap(credential => credential.sources.map(source => `${source === 'environment' ? 'env' : 'config'}:${source === 'environment' ? credential.env : credential.configKey}`)).filter(Boolean),
    providerRequiresExplicitTrust(provider, capability) && hasChannelAllowlist(provider, options.config) ? `config:${capability.onboarding.trust.allowlistConfigKey}` : '',
    ...pendingClaimRefs,
    unsafeAllowAll ? `config:security.unsafeAllowAllChannelTargets.${provider}` : '',
    `binding-count:${bindingCount}`,
    callback.required ? `webhook:${callback.routeExposure}` : 'webhook:not_applicable',
  ].filter(Boolean)

  const connector: Omit<ChannelConnectorStatus, 'onboardingFlow'> = {
    provider,
    displayName: capability.displayName,
    stage: capability.stage,
    modes: capability.onboarding.modes,
    ...(activeSetupPathKey ? { activeSetupPath: activeSetupPathKey } : {}),
    setupPaths,
    state,
    stateSummary: CHANNEL_CONNECTOR_STATE_DEFINITIONS[state].summary,
    enabled,
    configured: activeSetupPath?.configured || credentials.filter(credential => !ignoredCredentialForConfigured(provider, credential)).every(credential => credential.configured),
    trusted,
    unsafeAllowAll,
    bindingCount,
    credentials,
    missingPrerequisites: dedupeMissing(missing),
    diagnostics: dedupeDiagnostics(diagnostics),
    nextActions,
    callback,
    evidenceRefs,
    redacted: true as const,
  }
  return { ...connector, onboardingFlow: buildChannelOnboardingFlow(connector) }
}

export function buildChannelOnboardingFlow(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): ChannelOnboardingFlow {
  const path = UNIVERSAL_CHANNEL_ONBOARDING_PATH
  const completed = completedFlowSteps(connector)
  const currentStep = path.find(step => !completed.has(step)) || 'monitor'
  const steps = path.map(step => buildFlowStep(connector, step, completed, currentStep))
  const primary = steps.find(step => step.id === currentStep) || steps[steps.length - 1]!
  const fallbackAction = connector.diagnostics.length || connector.missingPrerequisites.length
    ? flowAction('Repair', diagnosticSummary(connector), `opencode-gateway channel repair ${connector.provider}`, diagnosticRefs(connector))
    : primary.fallbackAction
  return {
    path,
    currentStep,
    primaryAction: primary.primaryAction,
    ...(fallbackAction ? { fallbackAction } : {}),
    steps,
    redacted: true,
  }
}

function buildFlowStep(
  connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>,
  step: ChannelOnboardingStepId,
  completed: Set<ChannelOnboardingStepId>,
  currentStep: ChannelOnboardingStepId,
): ChannelOnboardingFlowStep {
  const blockers = stepBlockers(connector, step)
  const status: ChannelOnboardingStepStatus = completed.has(step)
    ? 'done'
    : step === currentStep
      ? connector.state === 'blocked' || blockers.some(code => blockedCode(connector, code)) ? 'blocked' : 'current'
      : 'pending'
  return {
    id: step,
    label: flowLabel(step),
    status,
    summary: flowSummary(connector, step),
    primaryAction: primaryFlowAction(connector, step),
    ...(fallbackFlowAction(connector, step) ? { fallbackAction: fallbackFlowAction(connector, step) } : {}),
    refs: stepRefs(connector, step),
    blockers,
  }
}

function completedFlowSteps(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): Set<ChannelOnboardingStepId> {
  const done = new Set<ChannelOnboardingStepId>()
  const connected = connector.enabled && (
    connector.configured
    || !connector.missingPrerequisites.some(row => connectBlockingPrerequisite(connector, row))
  )
  if (connected) done.add('connect')
  const verified = connected && (!connector.callback.required || (
    connector.callback.routeExposure !== 'local_only'
    && connector.callback.challenge !== 'missing'
    && connector.callback.signature !== 'missing'
    && connector.callback.verifier.state !== 'blocked'
  ))
  if (verified) done.add('verify')
  if (connector.trusted) done.add('trust')
  if (connector.bindingCount > 0 || connector.state === 'bound' || connector.state === 'ready') done.add('bind')
  if (connector.state === 'ready') done.add('monitor')
  return done
}

function primaryFlowAction(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): ChannelOnboardingFlowAction {
  const missing = firstMissingForStep(connector, step)
  if (missing) return flowAction(flowLabel(step), missing.remediation, commandForStep(connector, step), missingRefs(missing))
  if (step === 'connect') return flowAction('Connect', connectSummary(connector), `opencode-gateway channel setup ${connector.provider}`, setupRefs(connector))
  if (step === 'verify') return flowAction('Verify', verifySummary(connector), `opencode-gateway channel verify ${connector.provider}`, callbackRefs(connector))
  if (step === 'trust') return flowAction('Trust', trustSummaryText(connector), providerRequiresExplicitTrust(connector.provider, getChannelCapabilitiesOrFallback(connector)) ? `opencode-gateway channel claim ${connector.provider}` : `opencode-gateway channel trust ${connector.provider}`, trustRefs(connector))
  if (step === 'bind') return flowAction('Bind', bindSummary(connector), '/project bind <alias> <roadmapId> [--rebind] or /bind session <sessionId>', ['binding'])
  return flowAction('Monitor', 'Monitor delivery health, channel sync, and pending human requests.', `opencode-gateway channel status ${connector.provider}`, connector.evidenceRefs)
}

function fallbackFlowAction(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): ChannelOnboardingFlowAction | undefined {
  if (step === 'trust' && providerRequiresExplicitTrust(connector.provider, getChannelCapabilitiesOrFallback(connector))) {
    const key = getChannelCapabilitiesOrFallback(connector).onboarding.trust.allowlistConfigKey
    return flowAction('Manual trust fallback', key ? `Add an explicit trusted target to ${key}; keep raw target IDs out of evidence and screenshots.` : 'Use an explicit trusted target allowlist when claim-code trust is unavailable.', undefined, key ? [`config:${key}`] : [])
  }
  if (step === 'verify' && connector.callback.required) return flowAction('Safe exposure fallback', 'Keep non-webhook Gateway routes local or capability-protected while exposing only documented webhook routes.', undefined, callbackRefs(connector))
  return undefined
}

function flowAction(label: string, summary: string, command: string | undefined, refs: string[]): ChannelOnboardingFlowAction {
  return { label, summary, ...(command ? { command } : {}), refs: safeEvidenceRefs(refs) }
}

function firstMissingForStep(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): ChannelConnectorMissingPrerequisite | undefined {
  const kinds: Partial<Record<ChannelOnboardingStepId, ChannelConnectorPrerequisiteKind[]>> = {
    connect: ['credential', 'enablement', 'provider'],
    verify: ['webhook', 'verification'],
    trust: ['trust'],
    bind: ['binding'],
  }
  const allowed = kinds[step] || []
  return connector.missingPrerequisites.find(row => allowed.includes(row.kind) && (step !== 'connect' || connectBlockingPrerequisite(connector, row)))
}

function stepBlockers(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): string[] {
  const missing = connector.missingPrerequisites.filter(row => firstMissingForStep({ ...connector, missingPrerequisites: [row] }, step))
  const diagnostics = connector.diagnostics.filter(row => {
    if (step === 'connect') {
      if (row.code === 'missing_credentials') return missing.some(missingRow => missingRow.code === row.code)
      return ['provider_disabled', 'provider_unavailable'].includes(row.code)
    }
    if (step === 'verify') return ['callback_url_missing', 'verify_token_mismatch', 'signature_verification_missing', 'unsafe_route_exposure'].includes(row.code)
    if (step === 'trust') return row.code === 'missing_allowlist'
    if (step === 'bind') return row.code === 'binding_missing'
    return false
  })
  return [...new Set([...missing.map(row => row.code), ...diagnostics.map(row => row.code)])]
}

function connectBlockingPrerequisite(
  connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>,
  prerequisite: ChannelConnectorMissingPrerequisite,
): boolean {
  if (!['credential', 'enablement', 'provider'].includes(prerequisite.kind)) return false
  if (connector.provider === 'whatsapp' && prerequisite.key === 'whatsapp_app_secret') return false
  return true
}

function blockedCode(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, code: string): boolean {
  return connector.diagnostics.some(row => row.code === code && row.severity === 'blocked')
    || connector.missingPrerequisites.some(row => row.code === code && ['credential', 'enablement', 'provider', 'webhook', 'verification', 'trust'].includes(row.kind))
}

function flowLabel(step: ChannelOnboardingStepId): string {
  if (step === 'connect') return 'Connect'
  if (step === 'verify') return 'Verify'
  if (step === 'trust') return 'Trust'
  if (step === 'bind') return 'Bind'
  return 'Monitor'
}

function flowSummary(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): string {
  if (step === 'connect') return connectSummary(connector)
  if (step === 'verify') return verifySummary(connector)
  if (step === 'trust') return trustSummaryText(connector)
  if (step === 'bind') return bindSummary(connector)
  return 'Watch delivery health, pending inbound work, request notifications, and channel-sync events.'
}

function connectSummary(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string {
  const path = connector.setupPaths.find(row => row.active) || connector.setupPaths[0]
  return path ? `${path.label}: ${path.summary}` : `Configure ${connector.displayName} provider prerequisites without exposing secrets.`
}

function verifySummary(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string {
  if (!connector.callback.required) return `${connector.displayName} does not require a public webhook; verify local/polling readiness.`
  const routes = connector.callback.routes.map(route => `${route.method} ${route.path}`).join(', ')
  return `Expose only ${routes || 'documented webhook routes'}, confirm challenge/signature readiness, and keep other Gateway routes protected.`
}

function trustSummaryText(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string {
  if (!providerRequiresExplicitTrust(connector.provider, getChannelCapabilitiesOrFallback(connector))) return `${connector.displayName} trusts the local operator/Session boundary.`
  return `Trust a single redacted ${connector.displayName} target with a claim code or explicit allowlist before accepting state-changing commands.`
}

function bindSummary(_connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string {
  return 'Bind the trusted target to a Session, Issue, or Project.'
}

function commandForStep(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): string | undefined {
  if (step === 'connect') return `opencode-gateway channel setup ${connector.provider}`
  if (step === 'verify') return `opencode-gateway channel verify ${connector.provider}`
  if (step === 'trust') return `opencode-gateway channel claim ${connector.provider}`
  if (step === 'bind') return '/project bind <alias> <roadmapId> [--rebind]'
  return `opencode-gateway channel status ${connector.provider}`
}

function setupRefs(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string[] {
  return connector.setupPaths.flatMap(path => [...path.env.map(env => `env:${env}`), ...path.configKeys.map(key => `config:${key}`)])
}

function callbackRefs(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string[] {
  return connector.callback.routes.map(route => `webhook:${route.method}:${route.path}`)
}

function trustRefs(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string[] {
  const key = getChannelCapabilitiesOrFallback(connector).onboarding.trust.allowlistConfigKey
  return key ? [`config:${key}`] : ['local-session-boundary']
}

function missingRefs(row: ChannelConnectorMissingPrerequisite): string[] {
  return [row.env ? `env:${row.env}` : '', row.configKey ? `config:${row.configKey}` : '', row.key].filter(Boolean)
}

function stepRefs(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>, step: ChannelOnboardingStepId): string[] {
  if (step === 'connect') return setupRefs(connector)
  if (step === 'verify') return callbackRefs(connector)
  if (step === 'trust') return trustRefs(connector)
  if (step === 'bind') return [`binding-count:${connector.bindingCount}`]
  return connector.evidenceRefs
}

function diagnosticSummary(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string {
  const missing = connector.missingPrerequisites[0]
  if (missing) return missing.remediation
  const diagnostic = connector.diagnostics[0]
  if (diagnostic) return diagnostic.remediation
  return `Repair ${connector.displayName} using connector diagnostics.`
}

function diagnosticRefs(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): string[] {
  return connector.missingPrerequisites.flatMap(missingRefs)
}

function getChannelCapabilitiesOrFallback(connector: Omit<ChannelConnectorStatus, 'onboardingFlow'>): ChannelCapabilities {
  const capability = getChannelCapabilities(connector.provider) || listChannelCapabilities().find(row => row.provider === connector.provider)
  if (!capability) throw new Error(`Channel capability metadata missing for ${connector.provider}`)
  return capability
}

function setupPathStatuses(
  capability: ChannelCapabilities,
  config: GatewayConfig,
  credentials: ChannelCredentialStatus[],
  input: {
    provider: string
    enabled: boolean
    callback: ChannelConnectorCallbackStatus
    trusted: boolean
    unsafeAllowAll: boolean
    bindingCount: number
    activeKey?: string
  },
): ChannelConnectorSetupPath[] {
  return (capability.onboarding.setupPaths || []).map(path => setupPathStatus(path, capability, config, credentials, input))
}

function setupPathStatus(
  path: ChannelSetupPathDefinition,
  capability: ChannelCapabilities,
  config: GatewayConfig,
  credentials: ChannelCredentialStatus[],
  input: {
    provider: string
    enabled: boolean
    callback: ChannelConnectorCallbackStatus
    trusted: boolean
    unsafeAllowAll: boolean
    bindingCount: number
    activeKey?: string
  },
): ChannelConnectorSetupPath {
  const active = input.activeKey === path.key
  const available = path.status === 'implemented'
  const configured = pathConfigured(path, input.provider, config, credentials)
  const state = setupPathState(path, input.provider, config, credentials, input)
  const diagnostics = pathDiagnostics(path, capability, active, configured)
  return {
    key: path.key,
    label: path.label,
    modes: path.modes,
    implementationStatus: path.status,
    active,
    configured,
    available,
    state,
    summary: path.summary,
    nextActions: path.nextActions,
    prerequisites: path.prerequisites || [],
    env: path.env || [],
    configKeys: path.configKeys || [],
    docs: path.docs || [],
    diagnostics,
  }
}

function setupPathState(
  path: ChannelSetupPathDefinition,
  provider: string,
  config: GatewayConfig,
  credentials: ChannelCredentialStatus[],
  input: {
    enabled: boolean
    callback: ChannelConnectorCallbackStatus
    trusted: boolean
    unsafeAllowAll: boolean
    bindingCount: number
  },
): ChannelConnectorState {
  if (path.status !== 'implemented') return pathConfigured(path, provider, config, credentials) ? 'blocked' : 'not_configured'
  return resolveConnectorState({
    provider,
    enabled: input.enabled,
    credentials,
    callback: input.callback,
    trusted: input.trusted,
    unsafeAllowAll: input.unsafeAllowAll,
    bindingCount: input.bindingCount,
  })
}

function pathConfigured(path: ChannelSetupPathDefinition, provider: string, config: GatewayConfig, credentials: ChannelCredentialStatus[]): boolean {
  if (provider === 'whatsapp' && path.key === 'cloud_api_direct') return credentials.every(credential => credential.configured)
  return Boolean(path.configKeys?.some(key => configuredValue(config, key)) || path.env?.some(key => String(process.env[key] || '').trim()))
}

function pathDiagnostics(path: ChannelSetupPathDefinition, capability: ChannelCapabilities, active: boolean, configured: boolean): ChannelConnectorDiagnostic[] {
  if (path.status === 'implemented') return []
  if (!active && !configured) return []
  return [{
    ...toDiagnostic(diagnosticFor(capability, 'provider_unavailable')),
    summary: `${path.label} is ${path.status.replace('_', ' ')} for ${capability.displayName}.`,
  }]
}

function activeSetupPathKeyFor(provider: string, _config: GatewayConfig): string | undefined {
  if (provider !== 'whatsapp') return undefined
  return 'cloud_api_direct'
}

function resolveConnectorState(input: {
  provider: string
  enabled: boolean
  credentials: ChannelCredentialStatus[]
  callback: ChannelConnectorCallbackStatus
  trusted: boolean
  unsafeAllowAll: boolean
  bindingCount: number
}): ChannelConnectorState {
  if (!input.enabled) return 'not_configured'
  if (hasCoreCredentialGap(input.provider, input.credentials)) return 'credentials_needed'
  if (input.callback.required && input.callback.routeExposure === 'local_only') return 'webhook_needed'
  if (input.callback.required && input.callback.verifier.issues.some(issue => issue.code === 'unsafe_broad_exposure')) return 'blocked'
  if (input.callback.challenge === 'missing' || input.callback.signature === 'missing') return 'verification_pending'
  if (input.callback.required && input.callback.verifier.state === 'blocked') return 'blocked'
  if (input.unsafeAllowAll) return 'degraded'
  if (!input.trusted) return 'trusted_target_pending'
  if (input.bindingCount === 0) return 'trusted_target_pending'
  if (input.callback.required && input.callback.verifier.state === 'warning') return 'degraded'
  return 'ready'
}

function providerEnabled(provider: string, config: GatewayConfig): boolean {
  if (provider === 'discord') return process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true' || config.channels.discord?.enabled === true
  return true
}

function missingCredentialRequirements(provider: string, credentials: ChannelCredentialStatus[]): ChannelCredentialStatus[] {
  if (provider === 'discord') return credentials.filter(credential => credential.key !== 'discord_alpha_enabled' && !credential.configured)
  return credentials.filter(credential => !credential.configured)
}

function hasCoreCredentialGap(provider: string, credentials: ChannelCredentialStatus[]): boolean {
  if (provider === 'discord') return credentials.some(credential => credential.key === 'discord_bot_token' && !credential.configured)
  if (provider === 'whatsapp') return credentials.some(credential => credential.key !== 'whatsapp_app_secret' && !credential.configured)
  return missingCredentialRequirements(provider, credentials).length > 0
}

function ignoredCredentialForConfigured(provider: string, credential: ChannelCredentialStatus): boolean {
  return provider === 'discord' && credential.key === 'discord_alpha_enabled'
}

function callbackStatus(capability: ChannelCapabilities, config: GatewayConfig, credentials: ChannelCredentialStatus[]): ChannelConnectorCallbackStatus {
  const verifier = verifyChannelWebhookExposure(capability, config, credentials)
  return {
    required: verifier.required,
    publicWebhookMode: verifier.publicWebhookMode,
    routeExposure: verifier.exposureMode,
    routes: capability.onboarding.webhook?.routes || [],
    routeChecks: verifier.routes,
    challenge: verifier.challenge,
    signature: verifier.signature,
    verifier,
  }
}

function credentialStatus(credential: ChannelCredentialRequirement, config: GatewayConfig): ChannelCredentialStatus {
  const envConfigured = Boolean(credential.env && String(process.env[credential.env] || '').trim())
  const configConfigured = Boolean(credential.configKey && configuredValue(config, credential.configKey))
  return {
    key: credential.key,
    label: credential.label,
    configured: envConfigured || configConfigured,
    secret: credential.secret,
    ...(credential.env ? { env: credential.env } : {}),
    ...(credential.configKey ? { configKey: credential.configKey } : {}),
    sources: [
      ...(envConfigured ? ['environment' as const] : []),
      ...(configConfigured ? ['config' as const] : []),
    ],
  }
}

function configuredValue(config: GatewayConfig, key: string): boolean {
  const value = key.split('.').reduce<unknown>((current, part) => current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, config)
  if (typeof value === 'string') return value.trim().length > 0
  return Boolean(value)
}

function providerRequiresExplicitTrust(_provider: string, capability: ChannelCapabilities): boolean {
  return capability.onboarding.trust.targetIdRedaction === 'required'
}

function diagnosticFor(capability: ChannelCapabilities, code: ChannelSetupDiagnosticCode): ChannelSetupDiagnosticDefinition {
  return capability.onboarding.diagnostics.find(diagnostic => diagnostic.code === code)
    || { code, state: 'blocked', severity: 'blocked', summary: `${capability.displayName} setup prerequisite is missing.`, remediation: 'Inspect connector setup metadata and repair the missing prerequisite.' }
}

function toDiagnostic(definition: ChannelSetupDiagnosticDefinition): ChannelConnectorDiagnostic {
  return {
    code: definition.code,
    state: definition.state,
    severity: definition.severity,
    summary: definition.summary,
    remediation: definition.remediation,
  }
}

function credentialRef(credential?: ChannelCredentialStatus): Partial<ChannelConnectorMissingPrerequisite> {
  if (!credential) return {}
  return {
    ...(credential.env ? { env: credential.env } : {}),
    ...(credential.configKey ? { configKey: credential.configKey } : {}),
    secret: credential.secret,
  }
}

function actionsForMissingPrerequisites(rows: ChannelConnectorMissingPrerequisite[]): ChannelOnboardingAction[] {
  return rows.flatMap(row => {
    if (row.kind === 'credential' || row.kind === 'enablement') return ['connect', 'repair'] as ChannelOnboardingAction[]
    if (row.kind === 'webhook' || row.kind === 'verification') return ['verify', 'repair'] as ChannelOnboardingAction[]
    if (row.kind === 'trust') return ['trust'] as ChannelOnboardingAction[]
    if (row.kind === 'binding') return ['bind'] as ChannelOnboardingAction[]
    return ['repair'] as ChannelOnboardingAction[]
  })
}

function dedupeMissing(rows: ChannelConnectorMissingPrerequisite[]): ChannelConnectorMissingPrerequisite[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.kind}:${row.code}:${row.key}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeDiagnostics(rows: ChannelConnectorDiagnostic[]): ChannelConnectorDiagnostic[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.code}:${row.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function safeEvidenceRefs(refs: string[]): string[] {
  return refs.map(ref => String(ref || '').trim()).filter(ref => ref && !/[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}/.test(ref))
}
