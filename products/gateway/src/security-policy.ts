import { createHash } from 'node:crypto'
// Capability and resource vocabularies (formerly re-exported from the deleted authz-model.ts).
export type AuthzCapability =
  | 'read_state'
  | 'session_control'
  | 'task_mutate'
  | 'channel_send'
  | 'evidence_export'
  | 'config_change'
  | 'runtime_admin'
  | 'storage_restore'
  | 'remote_execute'
  | 'asset_write'
  | 'human_gate_decide'
  | 'scheduler_dispatch'
  | 'audit_read'
  | 'secret_reference'

export type ResourceKind =
  | 'organization'
  | 'workspace'
  | 'project'
  | 'session'
  | 'roadmap'
  | 'task'
  | 'run'
  | 'channel_binding'
  | 'channel_message'
  | 'evidence_export'
  | 'config'
  | 'storage'
  | 'opencode_asset'
  | 'worker_pool'
  | 'remote_environment'
import type { HttpCapability } from './security.js'

export type SecurityPolicySurface =
  | 'http'
  | 'mcp'
  | 'channel_command'
  | 'worker_action'
  | 'extension_package'
  | 'secret_reference'
  | 'evidence_export'

export type SecurityPolicyActorType =
  | 'local'
  | 'http_token'
  | 'webhook'
  | 'unsafe_public'
  | 'channel_actor'
  | 'extension_manifest'
  | 'worker'
  | 'mcp_client'
  | 'agent'
  | 'unknown'

export type SecurityPolicyTrustTier =
  | 'local_trusted'
  | 'trusted_channel'
  | 'gateway_shipped'
  | 'operator_approved'
  | 'preview_only'
  | 'untrusted'
  | 'blocked'
  | 'unknown'

export type SecurityPolicyCapability = AuthzCapability | HttpCapability | 'trusted_channel' | 'local_cli' | 'unknown'

export type SecurityPolicyDecisionKind = 'allow' | 'deny' | 'preview_only' | 'requires_human' | 'degraded'

export type SecurityPolicyProductMode =
  | 'local_public_beta'
  | 'public_local_release_candidate'
  | 'self_hosted_single_operator_preview'
  | 'self_hosted_team'
  | 'hosted_control_plane'
  | 'hosted_workers'
  | 'marketplace'
  | 'managed_support'
  | 'universal_channel'
  | 'unknown'

export type SecurityPolicyReasonCode =
  | 'policy_allowed'
  | 'missing_principal'
  | 'product_mode_mismatch'
  | 'http_local_trusted'
  | 'http_local_trusted_read'
  | 'http_public_webhook'
  | 'http_token_capability_allowed'
  | 'http_token_capability_denied'
  | 'http_unsafe_public_allowed'
  | 'http_non_local_denied'
  | 'mcp_tool_capability_denied'
  | 'untrusted_channel_action'
  | 'stale_or_replayed_action'
  | 'actor_mismatch'
  | 'worker_action_denied'
  | 'unsafe_package_grant'
  | 'secret_access_denied'
  | 'evidence_export_denied'
  | 'cross_scope_resource'
  | 'missing_capability'
  | 'requires_human_approval'
  | 'preview_only_policy'
  | 'degraded_policy_source'

export interface SecurityPolicyPrincipal {
  actorType: SecurityPolicyActorType
  trustTier?: SecurityPolicyTrustTier
  ref?: string
}

export interface SecurityPolicyScope {
  organizationId?: string
  workspaceId?: string
  projectId?: string
}

export interface SecurityPolicyResource extends SecurityPolicyScope {
  kind: ResourceKind | SecurityPolicySurface | 'http_route'
  id?: string
}

export interface SecurityPolicyInput {
  principal: SecurityPolicyPrincipal
  surface: SecurityPolicySurface
  resource: SecurityPolicyResource
  action: string
  capability?: SecurityPolicyCapability
  trustTier?: SecurityPolicyTrustTier
  channelBinding?: {
    trusted: boolean
    bindingId?: string
    projectId?: string
    sessionId?: string
  }
  scope?: SecurityPolicyScope
  requestedGrants?: string[]
  evidenceRequirement?: string
  previewOnly?: boolean
  requiresHuman?: boolean
  staleOrReplay?: boolean
  actorMismatch?: boolean
  degraded?: boolean
  message?: string
  productMode?: SecurityPolicyProductMode
  allowedProductModes?: SecurityPolicyProductMode[]
}

export interface SecurityPolicyEvidence {
  event: 'security.policy.decision'
  surface: SecurityPolicySurface
  action: string
  resourceKind: string
  resourceRef?: string
  actorType: SecurityPolicyActorType
  actorRef?: string
  decision: SecurityPolicyDecisionKind
  reasonCode: SecurityPolicyReasonCode
  capability?: SecurityPolicyCapability
  trustTier?: SecurityPolicyTrustTier
  productMode?: SecurityPolicyProductMode
  allowedProductModes?: SecurityPolicyProductMode[]
  evidenceRequirement?: string
  redacted: true
}

export interface SecurityPolicyDecision {
  allowed: boolean
  decision: SecurityPolicyDecisionKind
  reasonCode: SecurityPolicyReasonCode
  redactedMessage: string
  evidence: SecurityPolicyEvidence
}

export interface McpRequestSecurityPolicyInput {
  method: string
  path: string
  body?: unknown
  toolName?: string
  trustTier?: SecurityPolicyTrustTier
  principalRef?: string
  approvedGateId?: string
}

export interface ChannelCommandSecurityPolicyInput {
  command: string
  provider: string
  actorRef?: string
  targetRef?: string
  trusted: boolean
  bindingId?: string
  projectId?: string
  sessionId?: string
  staleOrReplay?: boolean
  actorMismatch?: boolean
}


export type HttpSecurityPolicyActor = 'local' | 'webhook' | 'http-token' | 'unsafe-public' | 'rejected'

export interface HttpSecurityPolicyInput {
  requiredCapability: HttpCapability
  isLocalRequest: boolean
  publicWebhookAllowed: boolean
  allowNonLocalHttp?: boolean
  unsafeAllowNoAuth?: boolean
  /**
   * Capability-scoped loopback: when true, a loopback (isLocalRequest) caller
   * is NOT auto-trusted to operator/admin actions and must present a scoped
   * bearer token, exactly like exposed mode. Local read and provider-verified
   * webhook routes remain reachable for CLI/status/dashboard ergonomics.
   */
  capabilityScopedLoopback?: boolean
  grantCapabilities?: HttpCapability[]
}

export interface HttpSecurityPolicyDecision extends SecurityPolicyDecision {
  actor: HttpSecurityPolicyActor
  requiredCapability: HttpCapability
  grantedCapabilities?: HttpCapability[]
}

export function decideHttpSecurityPolicy(input: HttpSecurityPolicyInput): HttpSecurityPolicyDecision {
  const base = {
    principal: { actorType: 'unknown' as const, trustTier: 'unknown' as const },
    surface: 'http' as const,
    resource: { kind: 'http_route' as const },
    action: 'http.request',
    capability: input.requiredCapability,
  }

  // Capability-scoped loopback suppresses the local mutation/admin auto-trust:
  // loopback write/admin callers must satisfy the bearer-token tier below.
  if (input.isLocalRequest && !input.capabilityScopedLoopback) {
    return httpDecision(base, input, true, 'allow', 'http_local_trusted', 'local request', 'local')
  }
  if (input.isLocalRequest && input.capabilityScopedLoopback && localReadOrWebhookCapability(input.requiredCapability)) {
    return httpDecision(base, input, true, 'allow', 'http_local_trusted_read', 'local read/webhook request', 'local')
  }
  if (input.publicWebhookAllowed) {
    return httpDecision(base, input, true, 'allow', 'http_public_webhook', 'public webhook mode', 'webhook')
  }
  const tokenTierEnabled = input.allowNonLocalHttp || input.capabilityScopedLoopback
  if (tokenTierEnabled && input.grantCapabilities?.length) {
    if (httpCapabilitiesSatisfy(input.grantCapabilities, input.requiredCapability)) {
      return httpDecision(base, input, true, 'allow', 'http_token_capability_allowed', `valid bearer token with ${input.requiredCapability} capability`, 'http-token')
    }
    return httpDecision(base, input, false, 'deny', 'http_token_capability_denied', `bearer token lacks required capability: ${input.requiredCapability}`, 'rejected')
  }
  if (input.allowNonLocalHttp && input.unsafeAllowNoAuth) {
    return httpDecision(base, input, true, 'allow', 'http_unsafe_public_allowed', 'unsafe unauthenticated exposed HTTP allowed by config', 'unsafe-public')
  }
  if (input.capabilityScopedLoopback && input.isLocalRequest) {
    return httpDecision(base, input, false, 'deny', 'http_token_capability_denied', `loopback request requires a capability-scoped bearer token (security.capabilityScopedLoopback); required capability: ${input.requiredCapability}`, 'rejected')
  }
  return httpDecision(base, input, false, 'deny', 'http_non_local_denied', `non-local request denied by Gateway security policy; required capability: ${input.requiredCapability}`, 'rejected')
}

function localReadOrWebhookCapability(capability: HttpCapability): boolean {
  return capability === 'read' || capability === 'webhook'
}

export function decideSecurityPolicy(input: SecurityPolicyInput): SecurityPolicyDecision {
  if (input.principal.actorType === 'unknown') {
    return decision(input, false, 'deny', 'missing_principal', 'Security policy denied the request because the principal is unknown.')
  }
  if (!input.capability) {
    return decision(input, false, 'deny', 'missing_capability', 'Security policy denied the request because no capability was declared.')
  }
  if (scopeMismatch(input.scope, input.resource)) {
    return decision(input, false, 'deny', 'cross_scope_resource', 'Security policy denied cross-scope resource access.')
  }
  if (productModeMismatch(input)) {
    return decision(input, false, 'deny', 'product_mode_mismatch', 'Security policy denied the request because the product mode is outside the allowed policy boundary.')
  }
  if (input.degraded) {
    return decision(input, false, 'degraded', 'degraded_policy_source', 'Security policy source is degraded; action is blocked until policy state is fresh.')
  }
  if (input.staleOrReplay) {
    return decision(input, false, 'deny', 'stale_or_replayed_action', 'Security policy denied a stale or replayed action.')
  }
  if (input.actorMismatch) {
    return decision(input, false, 'deny', 'actor_mismatch', 'Security policy denied an action from the wrong actor for this resource.')
  }
  if (input.surface === 'evidence_export' && unsafeEvidenceExportRequest(input)) {
    return decision(input, false, 'deny', 'evidence_export_denied', 'Security policy denied evidence export because the request referenced raw secret-shaped evidence.')
  }
  if (input.requiresHuman) {
    return decision(input, false, 'requires_human', 'requires_human_approval', 'Security policy requires explicit human approval before this action.')
  }
  if (input.previewOnly) {
    return decision(input, false, 'preview_only', 'preview_only_policy', 'Security policy allows preview only; mutation is blocked until approval.')
  }

  const trustTier = input.trustTier || input.principal.trustTier || 'unknown'
  if (input.surface === 'mcp' && sensitiveCapability(input.capability) && !trustedForSensitiveAction(trustTier)) {
    return decision(input, false, 'deny', 'mcp_tool_capability_denied', 'Security policy denied a privileged MCP action.')
  }
  if (input.surface === 'channel_command' && (input.channelBinding?.trusted === false || trustTier === 'untrusted' || trustTier === 'blocked')) {
    return decision(input, false, 'deny', 'untrusted_channel_action', 'Security policy denied an untrusted channel action.')
  }
  if (input.surface === 'worker_action' && !trustedForSensitiveAction(trustTier)) {
    return decision(input, false, 'deny', 'worker_action_denied', 'Security policy denied an untrusted worker action.')
  }
  if (input.surface === 'extension_package' && unsafePackageGrant(input, trustTier)) {
    return decision(input, false, 'deny', 'unsafe_package_grant', 'Security policy denied an unsafe package or tool grant.')
  }
  if (input.surface === 'secret_reference' && !secretAccessAllowed(input, trustTier)) {
    return decision(input, false, 'deny', 'secret_access_denied', 'Security policy denied secret-reference access.')
  }
  if (input.surface === 'evidence_export' && !evidenceExportAllowed(trustTier)) {
    return decision(input, false, 'deny', 'evidence_export_denied', 'Security policy denied evidence export for this actor.')
  }
  return decision(input, true, 'allow', 'policy_allowed', input.message || 'Security policy allowed the action.')
}

export function decideMcpRequestSecurityPolicy(input: McpRequestSecurityPolicyInput): SecurityPolicyDecision {
  const classification = classifyMcpRequest(input.method, input.path, input.body)
  const trustTier = input.trustTier || 'local_trusted'
  return decideSecurityPolicy({
    principal: { actorType: 'mcp_client', trustTier, ref: input.principalRef || 'gateway-mcp' },
    surface: classification.surface,
    action: input.toolName ? `mcp.${input.toolName}` : 'mcp.request',
    capability: classification.capability,
    resource: {
      kind: classification.resourceKind,
      id: classification.resourceId,
    },
    requestedGrants: classification.requestedGrants,
    evidenceRequirement: classification.evidenceRequirement,
    requiresHuman: classification.requiresHuman && !input.approvedGateId,
    message: 'Security policy allowed the MCP request.',
  })
}

export function decideChannelCommandSecurityPolicy(input: ChannelCommandSecurityPolicyInput): SecurityPolicyDecision {
  return decideSecurityPolicy({
    principal: {
      actorType: 'channel_actor',
      trustTier: input.trusted ? 'trusted_channel' : 'untrusted',
      ref: input.actorRef || `${input.provider}:sender`,
    },
    surface: 'channel_command',
    action: `channel.${input.command}`,
    capability: 'trusted_channel',
    resource: {
      kind: 'channel_binding',
      id: input.targetRef,
      projectId: input.projectId,
    },
    channelBinding: {
      trusted: input.trusted,
      bindingId: input.bindingId,
      projectId: input.projectId,
      sessionId: input.sessionId,
    },
    staleOrReplay: input.staleOrReplay,
    actorMismatch: input.actorMismatch,
    evidenceRequirement: 'trusted-channel-binding-and-privileged-actor',
    message: 'Security policy allowed the trusted channel command.',
  })
}

export function summarizeSecurityPolicyDecision(decision: SecurityPolicyDecision): Record<string, unknown> {
  return {
    event: decision.evidence.event,
    surface: decision.evidence.surface,
    action: decision.evidence.action,
    resourceKind: decision.evidence.resourceKind,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    capability: decision.evidence.capability,
    trustTier: decision.evidence.trustTier,
    productMode: decision.evidence.productMode,
    allowedProductModes: decision.evidence.allowedProductModes,
    actorRef: decision.evidence.actorRef,
    resourceRef: decision.evidence.resourceRef,
    redacted: true,
  }
}

function httpDecision(
  base: SecurityPolicyInput,
  input: HttpSecurityPolicyInput,
  allowed: boolean,
  kind: SecurityPolicyDecisionKind,
  reasonCode: SecurityPolicyReasonCode,
  message: string,
  actor: HttpSecurityPolicyActor,
): HttpSecurityPolicyDecision {
  const principal: SecurityPolicyPrincipal = actor === 'local'
    ? { actorType: 'local', trustTier: 'local_trusted' }
    : actor === 'webhook'
      ? { actorType: 'webhook', trustTier: 'trusted_channel' }
      : actor === 'http-token'
        ? { actorType: 'http_token', trustTier: 'operator_approved' }
        : actor === 'unsafe-public'
          ? { actorType: 'unsafe_public', trustTier: 'preview_only' }
          : input.grantCapabilities?.length
            ? { actorType: 'http_token', trustTier: 'operator_approved' }
          : { actorType: 'unknown', trustTier: 'unknown' }
  const policy = decision({ ...base, principal }, allowed, kind, reasonCode, message)
  return {
    ...policy,
    actor,
    requiredCapability: input.requiredCapability,
    grantedCapabilities: input.grantCapabilities,
  }
}

function decision(
  input: SecurityPolicyInput,
  allowed: boolean,
  kind: SecurityPolicyDecisionKind,
  reasonCode: SecurityPolicyReasonCode,
  redactedMessage: string,
): SecurityPolicyDecision {
  return {
    allowed,
    decision: kind,
    reasonCode,
    redactedMessage,
    evidence: {
      event: 'security.policy.decision',
      surface: input.surface,
      action: input.action,
      resourceKind: input.resource.kind,
      resourceRef: input.resource.id ? fingerprint('resource', input.resource.kind, input.resource.id) : undefined,
      actorType: input.principal.actorType,
      actorRef: input.principal.ref ? fingerprint('actor', input.principal.actorType, input.principal.ref) : undefined,
      decision: kind,
      reasonCode,
      capability: input.capability,
      trustTier: input.trustTier || input.principal.trustTier,
      productMode: input.productMode,
      allowedProductModes: input.allowedProductModes ? [...input.allowedProductModes] : undefined,
      evidenceRequirement: input.evidenceRequirement,
      redacted: true,
    },
  }
}

function scopeMismatch(scope: SecurityPolicyScope | undefined, resource: SecurityPolicyResource): boolean {
  if (!scope) return false
  return (
    Boolean(scope.organizationId && resource.organizationId && scope.organizationId !== resource.organizationId) ||
    Boolean(scope.workspaceId && resource.workspaceId && scope.workspaceId !== resource.workspaceId) ||
    Boolean(scope.projectId && resource.projectId && scope.projectId !== resource.projectId)
  )
}

function productModeMismatch(input: SecurityPolicyInput): boolean {
  if (!input.productMode || !input.allowedProductModes?.length) return false
  return !input.allowedProductModes.includes(input.productMode)
}

function unsafePackageGrant(input: SecurityPolicyInput, trustTier: SecurityPolicyTrustTier): boolean {
  const highRisk = ['asset_write', 'secret_reference', 'runtime_admin', 'storage_restore', 'remote_execute', 'config_change', 'admin']
  const requested = input.requestedGrants || []
  return (
    trustTier === 'blocked' ||
    (trustTier === 'untrusted' && highRisk.includes(String(input.capability))) ||
    requested.some(grant => grant === '*' || grant.endsWith(':*') || grant.includes('/*') || rawSecretLike(grant))
  )
}

function unsafeEvidenceExportRequest(input: SecurityPolicyInput): boolean {
  return Boolean(input.requestedGrants?.some(grant => rawSecretLike(grant) || wildcardGrantLike(grant)))
}

function secretAccessAllowed(input: SecurityPolicyInput, trustTier: SecurityPolicyTrustTier): boolean {
  return input.capability === 'secret_reference' && (trustTier === 'local_trusted' || trustTier === 'operator_approved')
}

function evidenceExportAllowed(trustTier: SecurityPolicyTrustTier): boolean {
  return trustTier === 'local_trusted' || trustTier === 'operator_approved'
}

function sensitiveCapability(capability: SecurityPolicyCapability | undefined): boolean {
  return Boolean(capability && !['read', 'read_state', 'trusted_channel', 'local_cli', 'webhook', 'unknown'].includes(String(capability)))
}

function trustedForSensitiveAction(trustTier: SecurityPolicyTrustTier): boolean {
  return ['local_trusted', 'trusted_channel', 'gateway_shipped', 'operator_approved'].includes(trustTier)
}

function classifyMcpRequest(method: string, rawPath: string, body: unknown): {
  surface: SecurityPolicySurface
  capability: SecurityPolicyCapability
  resourceKind: SecurityPolicyResource['kind']
  resourceId?: string
  requestedGrants?: string[]
  evidenceRequirement?: string
  requiresHuman?: boolean
} {
  const normalizedMethod = method.toUpperCase()
  const parsed = parseGatewayPath(rawPath)
  const path = parsed.pathname
  const segments = path.split('/').filter(Boolean)
  const resourceId = segments[1] || segments[0]
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)

  if (path.includes('/environments') && (mutating || path.endsWith('/action'))) {
    return { surface: 'worker_action', capability: 'remote_execute', resourceKind: 'remote_environment', resourceId }
  }
  if (path === '/storage/export' || path === '/evidence/export' || path === '/incident-bundle') {
    const unredacted = parsed.searchParams.get('redaction') === 'none' || parsed.searchParams.get('unredacted') === 'true' || objectFlag(body, 'unredacted') || objectString(body, 'redaction') === 'none'
    return {
      surface: 'evidence_export',
      capability: 'evidence_export',
      resourceKind: 'evidence_export',
      resourceId: path,
      evidenceRequirement: unredacted ? 'unredacted-requires-human-approval' : 'redacted-export-default',
      requiresHuman: unredacted,
    }
  }
  if (path === '/storage/restore' || path.startsWith('/storage/recovery-drills')) {
    return { surface: 'mcp', capability: 'storage_restore', resourceKind: 'storage', resourceId: path }
  }
  if (path === '/restart' || path === '/shutdown') {
    return { surface: 'mcp', capability: 'runtime_admin', resourceKind: 'config', resourceId: path }
  }
  if (path === '/config' && mutating) {
    return { surface: 'mcp', capability: 'config_change', resourceKind: 'config', resourceId: path }
  }
  if (path.startsWith('/channels/send')) {
    return { surface: 'mcp', capability: 'channel_send', resourceKind: 'channel_message', resourceId: path }
  }
  if (assetWritePath(path, normalizedMethod)) {
    return {
      surface: 'extension_package',
      capability: 'asset_write',
      resourceKind: path.startsWith('/profiles') || path.startsWith('/agent-teams') || path.startsWith('/agent-factory') ? 'extension_package' : 'opencode_asset',
      resourceId,
      requestedGrants: collectRequestedGrants(body),
    }
  }
  if (path.startsWith('/scheduler') && mutating) {
    return { surface: 'mcp', capability: 'scheduler_dispatch', resourceKind: 'run', resourceId: path }
  }
  if (path.includes('/human-gates') && mutating) {
    return { surface: 'mcp', capability: 'human_gate_decide', resourceKind: 'run', resourceId }
  }
  if (mutating) {
    return { surface: 'mcp', capability: 'task_mutate', resourceKind: resourceKindForPath(path), resourceId }
  }
  return { surface: 'mcp', capability: 'read_state', resourceKind: resourceKindForPath(path), resourceId }
}

function parseGatewayPath(rawPath: string): URL {
  try {
    return new URL(rawPath, 'http://gateway.local')
  } catch {
    return new URL('/', 'http://gateway.local')
  }
}

function assetWritePath(path: string, method: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false
  return (
    path.startsWith('/profiles') ||
    path === '/agent-factory/teams/assemble' ||
    (path.startsWith('/agent-teams/') && (path.endsWith('/apply') || path.endsWith('/bind') || method === 'DELETE')) ||
    path.startsWith('/blueprints/apply') ||
    path.startsWith('/opencode/mcp') ||
    path.startsWith('/opencode/tools') ||
    path.startsWith('/opencode/agents') ||
    path.startsWith('/opencode/skills')
  )
}

function resourceKindForPath(path: string): SecurityPolicyResource['kind'] {
  if (path.startsWith('/roadmaps') || path.startsWith('/projects')) return 'roadmap'
  if (path.startsWith('/tasks') || path.startsWith('/delegations')) return 'task'
  if (path.startsWith('/channels')) return 'channel_binding'
  if (path.startsWith('/opencode/sessions')) return 'session'
  if (path.startsWith('/runs')) return 'run'
  if (path.startsWith('/storage')) return 'storage'
  if (path.startsWith('/config')) return 'config'
  if (path.startsWith('/promotion') || path.startsWith('/agent-teams') || path.startsWith('/profiles')) return 'extension_package'
  return 'project'
}

function collectRequestedGrants(value: unknown): string[] {
  const grants = new Set<string>()
  collectGrantStrings(value, '', grants)
  return [...grants]
}

function collectGrantStrings(value: unknown, key: string, grants: Set<string>): void {
  const grantKey = /^(grant|grants|capability|capabilities|permission|permissions|allowedTools)$/i.test(key)
  const toolNameKey = /^(tool|tools|mcpServers|skills)$/i.test(key)
  if (typeof value === 'string') {
    if (grantKey || (toolNameKey && wildcardGrantLike(value))) grants.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && (grantKey || (toolNameKey && wildcardGrantLike(item)))) grants.add(item)
      else collectGrantStrings(item, key, grants)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) collectGrantStrings(childValue, childKey, grants)
  }
}

function objectFlag(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>)[key] === true)
}

function objectString(value: unknown, key: string): string | undefined {
  const entry = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof entry === 'string' ? entry : undefined
}

function rawSecretLike(value: string): boolean {
  if (/^secret(ref)?[:_][A-Za-z0-9._:@/-]{2,}$/i.test(value)) return false
  return /(token|secret|password|credential|private|api[_-]?key|bearer|webhook)/i.test(value)
}

function wildcardGrantLike(value: string): boolean {
  return value === '*' || value.endsWith(':*') || value.includes('/*')
}

function httpCapabilitiesSatisfy(granted: HttpCapability[], required: HttpCapability): boolean {
  if (granted.includes('admin')) return true
  if (required === 'read') return granted.some(capability => capability === 'read' || capability === 'operator' || capability === 'asset_write')
  if (required === 'operator') return granted.includes('operator')
  if (required === 'asset_write') return granted.includes('asset_write')
  if (required === 'webhook') return granted.includes('webhook')
  return false
}

function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32)
}
