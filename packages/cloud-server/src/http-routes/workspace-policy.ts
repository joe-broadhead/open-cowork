import {
  evaluateWorkspaceCapabilityPolicy,
  type WorkspaceAction,
  type WorkspacePolicyDecision,
} from '@open-cowork/shared'
import type { CloudRuntimePolicy } from '../cloud-config.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudApiRoutePolicy = {
  action: WorkspaceAction
  requiresBindingScope?: boolean
}

export type CloudPreAuthRoutePolicy =
  | { kind: 'workspace', route: CloudApiRoutePolicy }
  | { kind: 'identity-bootstrap', surface: 'invite-accept' | 'scim' }

/** Closed inventory for credentialed routes mounted before normal user auth. */
export function resolveCloudPreAuthRoutePolicy(
  methodInput: string | undefined,
  segments: readonly string[],
): CloudPreAuthRoutePolicy | null {
  const method = methodInput?.toUpperCase()
  if (method === 'POST' && segments.length === 3 && segments[0] === 'webhooks' && segments[1] === 'workflows') {
    return { kind: 'workspace', route: route('workflows.webhookInvoke') }
  }
  if (method === 'POST' && segments.join('/') === 'api/knowledge/agent/propose') {
    return { kind: 'workspace', route: route('knowledge.agentPropose') }
  }
  if (method === 'POST' && segments.join('/') === 'api/invites/accept') {
    return { kind: 'identity-bootstrap', surface: 'invite-accept' }
  }
  if (method === 'POST' && segments.join('/') === 'webhooks/billing') {
    return { kind: 'workspace', route: route('billing.webhookApply') }
  }
  if (segments[0] === 'scim' && segments[1] === 'v2') {
    return { kind: 'identity-bootstrap', surface: 'scim' }
  }
  return null
}

export function evaluateCloudApiWorkspacePolicy(input: {
  method: string | undefined
  segments: readonly string[]
  principal: CloudPrincipal
  policy: Pick<CloudRuntimePolicy, 'features'>
  route?: CloudApiRoutePolicy | null
  bindingScopeVerified?: boolean
}): WorkspacePolicyDecision {
  const resolvedRoute = input.route === undefined
    ? resolveCloudApiRoutePolicy(input.method, input.segments)
    : input.route
  return evaluateWorkspaceCapabilityPolicy({
    action: resolvedRoute?.action,
    principal: input.principal,
    features: input.policy.features,
    bindingScoped: resolvedRoute?.requiresBindingScope ? input.bindingScopeVerified === true : undefined,
  })
}

export function resolveCloudApiRoutePolicy(
  methodInput: string | undefined,
  segments: readonly string[],
  requestBody?: Readonly<Record<string, unknown>>,
): CloudApiRoutePolicy | null {
  const method = methodInput?.toUpperCase()
  if (!method || segments[0] !== 'api') return null
  const [, resource, itemId, action, artifactId, nestedAction] = segments
  const length = segments.length

  if ((resource === 'config' || resource === 'workspace') && method === 'GET' && length === 2) {
    return route('workspace.read')
  }
  if (resource === 'events' && method === 'GET' && length === 2) return route('workspace.events')
  if (resource === 'metrics' && method === 'GET' && length === 2) return route('operator.metricsRead')
  if (resource === 'diagnostics' && method === 'GET' && length === 2) return route('operator.diagnosticsRead')
  if (resource === 'workers' && itemId === 'heartbeats' && method === 'GET' && length === 3) {
    return route('operator.runtimeRead')
  }
  if (resource === 'runtime' && itemId === 'status' && method === 'GET' && length === 3) {
    return route('operator.runtimeRead')
  }
  if (resource === 'workers' && itemId && action === 'heartbeat' && method === 'POST' && length === 4) {
    return route('worker.heartbeat')
  }
  if (resource === 'usage' && (itemId === 'events' || itemId === 'summary') && method === 'GET' && length === 3) {
    return route('usage.read')
  }

  if (resource === 'project-sources' && itemId === 'validate' && method === 'POST' && length === 3) {
    return route('projectSources.validate')
  }
  if (resource === 'project-sources' && itemId === 'snapshots' && method === 'POST' && length === 3) {
    return route('projectSources.upload')
  }

  if (resource === 'import' && itemId === 'sessions' && method === 'POST' && length === 3) {
    return route('sessions.import')
  }
  if (resource === 'sessions') return resolveSessionRoute(method, segments)
  if (resource === 'workflows') return resolveWorkflowRoute(method, segments, requestBody)

  if (resource === 'artifacts' && method === 'GET' && length === 2) return route('artifacts.index')
  if (resource === 'channels') return resolveChannelRoute(method, segments)

  if (resource === 'settings') {
    if (method === 'GET' && (length === 2 || length === 3)) return route('settings.read')
    if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && (length === 2 || length === 3)) return route('settings.write')
    return null
  }

  if (resource === 'threads') return resolveThreadRoute(method, segments)
  if (resource === 'coordination') return resolveCoordinationRoute(method, segments)
  if (resource === 'knowledge') return resolveKnowledgeRoute(method, segments)
  if (resource === 'launchpad' && itemId === 'feed' && method === 'GET' && length === 3) {
    return route('launchpad.read')
  }
  if (resource === 'capabilities') return resolveCapabilitiesRoute(method, segments)
  if (resource === 'billing') return resolveBillingRoute(method, segments)
  if (resource === 'byok') return resolveByokRoute(method, segments)
  if (resource === 'policy') return resolvePolicyRoute(method, segments)
  if (resource === 'api-tokens') return resolveApiTokenRoute(method, segments)
  if (resource === 'admin') return resolveAdminRoute(method, segments)

  // Keep aliases and future routes closed until their action is deliberately added.
  void artifactId
  void nestedAction
  return null
}

function resolveSessionRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , sessionId, action, artifactId, artifactAction] = segments
  const length = segments.length
  if (!sessionId && method === 'GET' && length === 2) return route('sessions.list')
  if (!sessionId && method === 'POST' && length === 2) return route('sessions.create')
  if (!sessionId) return null
  if (!action && method === 'GET' && length === 3) return route('sessions.get')
  if (action === 'activate' && method === 'POST' && length === 4) return route('sessions.activate')
  if (action === 'view' && method === 'GET' && length === 4) return route('sessions.view')
  if (action === 'projection-status' && method === 'GET' && length === 4) return route('sessions.projectionRead')
  if (action === 'projection-repair' && method === 'POST' && length === 4) return route('sessions.projectionRepair')
  if (action === 'events' && method === 'GET' && length === 4) return route('sessions.events')
  if (action === 'prompt' && method === 'POST' && length === 4) return route('sessions.prompt')
  if (action === 'abort' && method === 'POST' && length === 4) return route('sessions.abort')
  if (action === 'question-reply' && method === 'POST' && length === 4) return route('sessions.questionReply')
  if (action === 'question-reject' && method === 'POST' && length === 4) return route('sessions.questionReject')
  if (action === 'permission-respond' && method === 'POST' && length === 4) return route('sessions.permissionRespond')
  if (action !== 'artifacts') return null
  if (!artifactId && method === 'GET' && length === 4) return route('artifacts.list')
  if (!artifactId && method === 'POST' && length === 4) return route('artifacts.upload')
  if (artifactId && artifactAction === 'finalize' && method === 'POST' && length === 6) return route('artifacts.finalize')
  if (artifactId && artifactAction === 'status' && method === 'POST' && length === 6) return route('artifacts.update')
  if (artifactId && !artifactAction && method === 'GET' && length === 5) return route('artifacts.read')
  return null
}

function resolveWorkflowRoute(
  method: string,
  segments: readonly string[],
  requestBody?: Readonly<Record<string, unknown>>,
): CloudApiRoutePolicy | null {
  const [, , workflowId, action] = segments
  const length = segments.length
  if (!workflowId && method === 'GET' && length === 2) return route('workflows.list')
  if (!workflowId && method === 'POST' && length === 2) {
    return route(workflowRequestHasWebhookTrigger(requestBody)
      ? 'workflows.createWebhook'
      : 'workflows.create')
  }
  if (workflowId === 'scheduler' && action === 'tick' && method === 'POST' && length === 4) {
    return route('workflows.schedulerTick')
  }
  if (!workflowId) return null
  if (!action && method === 'GET' && length === 3) return route('workflows.get')
  if (action === 'run' && method === 'POST' && length === 4) return route('workflows.run')
  if (action === 'rotate-webhook-secret' && method === 'POST' && length === 4) return route('workflows.rotateWebhookSecret')
  if (action === 'pause' && method === 'POST' && length === 4) return route('workflows.pause')
  if (action === 'resume' && method === 'POST' && length === 4) return route('workflows.resume')
  if (action === 'archive' && method === 'POST' && length === 4) return route('workflows.archive')
  return null
}

function workflowRequestHasWebhookTrigger(requestBody: Readonly<Record<string, unknown>> | undefined) {
  if (!Array.isArray(requestBody?.triggers)) return false
  return requestBody.triggers.some((trigger) => (
    trigger !== null
    && typeof trigger === 'object'
    && !Array.isArray(trigger)
    && (trigger as Record<string, unknown>).type === 'webhook'
  ))
}

function resolveChannelRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction, nestedItemId] = segments
  const length = segments.length
  if (collection === 'providers' && !itemId && method === 'GET' && length === 3) return route('channels.directory.read')
  if (collection === 'identities' && !itemId && method === 'GET' && length === 3) return route('channels.directory.read')
  if (collection === 'agents') {
    if (!itemId && method === 'GET' && length === 3) return route('channels.manage.read')
    if (!itemId && method === 'POST' && length === 3) return route('channels.manage.write')
    if (itemId && !itemAction && method === 'PATCH' && length === 4) return route('channels.manage.write')
  }
  if (collection === 'bindings') {
    if (!itemId && method === 'GET' && length === 3) return route('channels.manage.read')
    if (!itemId && method === 'POST' && length === 3) return route('channels.manage.write')
    if (itemId && !itemAction && method === 'PATCH' && length === 4) return route('channels.manage.write')
  }
  if (collection === 'identities' && itemId === 'resolve' && !itemAction && method === 'POST' && length === 4) {
    return bindingRoute('channels.service.identity')
  }
  if (collection === 'sessions' && (itemId === 'bind' || itemId === 'prompt') && !itemAction && method === 'POST' && length === 4) {
    return bindingRoute('channels.service.session')
  }
  if (collection === 'sessions' && itemId === 'by-thread' && !itemAction && method === 'GET' && length === 4) {
    return bindingRoute('channels.service.session')
  }
  if (collection === 'sessions' && itemId && itemAction === 'snapshot' && method === 'GET' && length === 5) {
    return bindingRoute('channels.service.session')
  }
  if (collection === 'sessions' && itemId && itemAction === 'events' && method === 'GET' && length === 5) {
    return bindingRoute('channels.service.session')
  }
  if (collection === 'sessions' && itemId && itemAction === 'artifacts' && nestedItemId && method === 'GET' && length === 6) {
    return bindingRoute('channels.service.artifact')
  }
  if (collection === 'cursor' && !itemId && method === 'POST' && length === 3) return bindingRoute('channels.service.cursor')
  if (collection === 'interactions' && !itemId && method === 'POST' && length === 3) return bindingRoute('channels.service.interaction')
  if (collection === 'interactions' && itemId === 'resolve' && !itemAction && method === 'POST' && length === 4) {
    return bindingRoute('channels.service.interaction')
  }
  if (collection === 'provider-events' && itemId === 'claim' && !itemAction && method === 'POST' && length === 4) {
    return bindingRoute('channels.service.providerEvent')
  }
  if (collection === 'provider-events' && itemId && itemAction === 'complete' && method === 'POST' && length === 5) {
    return bindingRoute('channels.service.providerEvent')
  }
  if (collection === 'deliveries') {
    if (itemId === 'stream' && !itemAction && method === 'GET' && length === 4) return bindingRoute('channels.service.delivery')
    if (!itemId && method === 'GET' && length === 3) return bindingRoute('channels.deliveries.read')
    if (!itemId && method === 'POST' && length === 3) return bindingRoute('channels.service.delivery')
    if (itemId && itemAction === 'ack' && method === 'POST' && length === 5) return bindingRoute('channels.service.delivery')
    if (itemId && ['retry', 'dead-letter'].includes(String(itemAction)) && method === 'POST' && length === 5) {
      return bindingRoute('channels.deliveries.write')
    }
  }
  return null
}

function resolveThreadRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction] = segments
  const length = segments.length
  if (!collection && method === 'GET' && length === 2) return route('threads.read')
  if (collection === 'tags') {
    if (!itemId && method === 'GET' && length === 3) return route('threads.read')
    if (!itemId && method === 'POST' && length === 3) return route('threads.write')
    if (itemId && !itemAction && (method === 'PATCH' || method === 'DELETE') && length === 4) return route('threads.write')
    if (itemId && (itemAction === 'apply' || itemAction === 'remove') && method === 'POST' && length === 5) return route('threads.write')
  }
  if (collection === 'smart-filters') {
    if (!itemId && method === 'GET' && length === 3) return route('threads.read')
    if (!itemId && method === 'POST' && length === 3) return route('threads.write')
    if (itemId && !itemAction && (method === 'PATCH' || method === 'DELETE') && length === 4) return route('threads.write')
  }
  return null
}

function resolveCoordinationRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction] = segments
  const length = segments.length
  if (collection === 'board' && !itemId && method === 'GET' && length === 3) return route('coordination.read')
  if (collection === 'projects') {
    if (!itemId && method === 'GET' && length === 3) return route('coordination.read')
    if (!itemId && method === 'POST' && length === 3) return route('coordination.write')
    if (itemId && !itemAction && method === 'POST' && length === 4) return route('coordination.write')
    if (itemId && itemAction === 'plan-with-cleo' && method === 'POST' && length === 5) return route('coordination.write')
  }
  if (collection === 'tasks') {
    if (!itemId && method === 'GET' && length === 3) return route('coordination.read')
    if (!itemId && method === 'POST' && length === 3) return route('coordination.write')
    if (itemId && !itemAction && method === 'POST' && length === 4) return route('coordination.write')
    if (itemId && itemAction === 'work-target' && method === 'GET' && length === 5) return route('coordination.read')
    if (itemId && ['move', 'assign', 'link-work'].includes(String(itemAction)) && method === 'POST' && length === 5) return route('coordination.write')
  }
  if (collection === 'watches') {
    if (!itemId && method === 'GET' && length === 3) return route('coordination.watches.read')
    if (!itemId && method === 'POST' && length === 3) return route('coordination.watches.write')
    if (itemId && !itemAction && (method === 'POST' || method === 'DELETE') && length === 4) return route('coordination.watches.write')
    if (itemId && (itemAction === 'pause' || itemAction === 'resume') && method === 'POST' && length === 5) return route('coordination.watches.write')
  }
  return null
}

function resolveKnowledgeRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction] = segments
  const length = segments.length
  if (!collection && method === 'GET' && length === 2) return route('knowledge.read')
  if (collection === 'spaces' && !itemId && method === 'POST' && length === 3) return route('knowledge.adminWrite')
  if (collection === 'proposals') {
    if (!itemId && method === 'POST' && length === 3) return route('knowledge.propose')
    if (itemId && (itemAction === 'accept' || itemAction === 'decline') && method === 'POST' && length === 5) return route('knowledge.adminWrite')
  }
  if (collection === 'pages' && itemId && itemAction === 'history' && method === 'GET' && length === 5) return route('knowledge.read')
  if (collection === 'pages' && itemId && itemAction === 'restore' && method === 'POST' && length === 5) return route('knowledge.adminWrite')
  return null
}

function resolveCapabilitiesRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction] = segments
  const length = segments.length
  if (!collection && method === 'GET' && length === 2) return route('capabilities.read')
  if (collection === 'tools' && method === 'GET' && (length === 3 || (itemId && !itemAction && length === 4))) {
    return route('capabilities.read')
  }
  if (collection === 'skills' && method === 'GET') {
    if (length === 3 || (itemId && !itemAction && length === 4)) return route('capabilities.read')
    if (itemId && itemAction === 'bundle' && length === 5) return route('capabilities.read')
  }
  return null
}

function resolveBillingRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , itemId] = segments
  if (segments.length !== 3) return null
  if ((itemId === 'subscription' || itemId === 'entitlements') && method === 'GET') return route('billing.read')
  if ((itemId === 'checkout' || itemId === 'portal') && method === 'POST') return route('billing.write')
  return null
}

function resolveByokRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , providerId, action] = segments
  const length = segments.length
  if (!providerId && method === 'GET' && length === 2) return route('byok.read')
  if (providerId && !action && method === 'GET' && length === 3) return route('byok.read')
  if (providerId && !action && (method === 'POST' || method === 'DELETE') && length === 3) return route('byok.write')
  if (providerId && (action === 'validate' || action === 'override') && method === 'POST' && length === 4) return route('byok.write')
  return null
}

function resolvePolicyRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , itemId] = segments
  if (!itemId && method === 'GET' && segments.length === 2) return route('policy.read')
  if (!itemId && (method === 'PUT' || method === 'POST') && segments.length === 2) return route('policy.write')
  if (itemId === 'effective' && method === 'GET' && segments.length === 3) return route('policy.effectiveRead')
  return null
}

function resolveApiTokenRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , itemId, action] = segments
  const length = segments.length
  if (!itemId && method === 'GET' && length === 2) return route('apiTokens.read')
  if (!itemId && method === 'POST' && length === 2) return route('apiTokens.write')
  if (itemId && !action && method === 'DELETE' && length === 3) return route('apiTokens.write')
  if (itemId && action === 'channel-bindings' && method === 'POST' && length === 4) return route('apiTokens.write')
  return null
}

function resolveAdminRoute(method: string, segments: readonly string[]): CloudApiRoutePolicy | null {
  const [, , collection, itemId, itemAction, nestedId, nestedAction] = segments
  const length = segments.length
  if (!collection && method === 'GET' && length === 2) return route('admin.read')
  if (['policy', 'access', 'permission-catalog'].includes(String(collection)) && method === 'GET' && length === 3) {
    return route('admin.read')
  }
  if (collection === 'audit' && !itemId && method === 'GET' && length === 3) return route('admin.audit.read')
  if (collection === 'audit' && itemId === 'export' && method === 'GET' && length === 4) return route('admin.audit.read')
  if (collection === 'roles') {
    if (!itemId && method === 'GET' && length === 3) return route('admin.roles.read')
    if (!itemId && method === 'POST' && length === 3) return route('admin.roles.write')
    if (itemId && itemAction === 'update' && method === 'POST' && length === 5) return route('admin.roles.write')
    if (itemId && !itemAction && method === 'DELETE' && length === 4) return route('admin.roles.write')
  }
  if (collection === 'members') {
    if (!itemId && method === 'GET' && length === 3) return route('admin.members.read')
    if (!itemId && method === 'POST' && length === 3) return route('admin.members.write')
    if (itemId && (itemAction === 'update' || itemAction === 'role') && method === 'POST' && length === 5) return route('admin.members.write')
  }
  if (collection === 'sso') {
    if (!itemId && method === 'GET' && length === 3) return route('admin.sso.read')
    if (!itemId && (method === 'POST' || method === 'DELETE') && length === 3) return route('admin.sso.write')
    if (itemId === 'scim-token' && method === 'POST' && length === 4) return route('admin.sso.write')
  }
  if (collection === 'worker-pools') {
    if (!itemId && method === 'GET' && length === 3) return route('admin.workers.read')
    if (!itemId && method === 'POST' && length === 3) return route('admin.workers.write')
    if (itemId && itemAction === 'update' && method === 'POST' && length === 5) return route('admin.workers.write')
  }
  if (collection === 'workers') {
    if (!itemId && method === 'GET' && length === 3) return route('admin.workers.read')
    if (!itemId && method === 'POST' && length === 3) return route('admin.workers.write')
    if (itemId && !itemAction && method === 'GET' && length === 4) return route('admin.workers.read')
    if (itemId && ['activate', 'pause', 'resume', 'drain', 'retire', 'revoke', 'unhealthy'].includes(String(itemAction)) && method === 'POST' && length === 5) return route('admin.workers.write')
    if (itemId && itemAction === 'credentials' && !nestedId && method === 'GET' && length === 5) return route('admin.workers.read')
    if (itemId && itemAction === 'credentials' && !nestedId && method === 'POST' && length === 5) return route('admin.workers.write')
    if (itemId && itemAction === 'credentials' && nestedId && (nestedAction === 'rotate' || nestedAction === 'revoke') && method === 'POST' && length === 7) return route('admin.workers.write')
    if (itemId && itemAction === 'heartbeats' && method === 'GET' && length === 5) return route('admin.workers.read')
  }
  return null
}

function route(action: WorkspaceAction): CloudApiRoutePolicy {
  return { action }
}

function bindingRoute(action: WorkspaceAction): CloudApiRoutePolicy {
  return { action, requiresBindingScope: true }
}
