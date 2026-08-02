import type { ControlPlanePermission } from './admin.js'
import type { CloudFeatureConfig, CloudFeatureKey } from './config-types.js'

export const WORKSPACE_PRINCIPAL_CLASSES = [
  'user',
  'local',
  'header',
  'desktop-service',
  'gateway-service',
  'admin-service',
  'operator-service',
  'worker-service',
  'worker-internal-service',
  'workflow-webhook-service',
  'knowledge-agent-service',
  'billing-webhook-service',
  'mixed-service',
  'unknown',
] as const

export type WorkspacePrincipalClass = (typeof WORKSPACE_PRINCIPAL_CLASSES)[number]

export type WorkspaceServiceScope =
  | 'desktop'
  | 'gateway'
  | 'admin'
  | 'operator'
  | 'worker-internal'

export type WorkspacePolicyPrincipal = {
  authSource?: unknown
  role?: unknown
  tokenScopes?: unknown
  permissions?: unknown
  customRoleKey?: unknown
}

export type WorkspaceResource =
  | 'workspace'
  | 'projectSources'
  | 'sessions'
  | 'artifacts'
  | 'workflows'
  | 'channels'
  | 'settings'
  | 'threads'
  | 'coordination'
  | 'knowledge'
  | 'launchpad'
  | 'billing'
  | 'usage'
  | 'byok'
  | 'capabilities'
  | 'policy'
  | 'apiTokens'
  | 'admin'
  | 'operator'
  | 'worker'
  | 'unknown'

type WorkspaceActionDefinition = {
  resource: Exclude<WorkspaceResource, 'unknown'>
  feature?: CloudFeatureKey
  additionalFeatures?: readonly CloudFeatureKey[]
  anyFeatures?: readonly CloudFeatureKey[]
  serviceScopes: readonly WorkspaceServiceScope[]
  human: boolean
  humanPermissions?: readonly ControlPlanePermission[]
  humanRoles?: readonly ('owner' | 'admin' | 'member')[]
  local?: boolean
  workerCredential?: boolean
  workerInternal?: boolean
  workflowWebhookCredential?: boolean
  knowledgeAgentCredential?: boolean
  billingWebhookCredential?: boolean
  gatewayBindingScoped?: boolean
  orgAdminService?: boolean
}

const desktopAction = (
  resource: WorkspaceActionDefinition['resource'],
  feature?: CloudFeatureKey,
): WorkspaceActionDefinition => ({
  resource,
  ...(feature ? { feature } : {}),
  serviceScopes: ['desktop'],
  human: true,
})

const channelServiceAction = (): WorkspaceActionDefinition => ({
  resource: 'channels',
  feature: 'channels',
  serviceScopes: ['gateway'],
  human: false,
  humanPermissions: ['org:manage'],
  local: true,
  gatewayBindingScoped: true,
  orgAdminService: true,
})

const channelArtifactServiceAction = (): WorkspaceActionDefinition => ({
  ...channelServiceAction(),
  resource: 'artifacts',
  additionalFeatures: ['artifacts'],
})

const channelIdentityAction = (): WorkspaceActionDefinition => ({
  ...channelServiceAction(),
  // Admin service tokens may bootstrap identities before a gateway binding
  // exists. Other channel service actions remain gateway-only and bound.
  serviceScopes: ['gateway', 'admin'],
  human: true,
  humanRoles: ['owner', 'admin'],
})

const channelDeliveryAdminAction = (): WorkspaceActionDefinition => ({
  ...channelServiceAction(),
  // Delivery inspection and operator remediation are also exposed by the
  // browser Admin surface. Gateway-only callers remain binding-scoped, while
  // an explicit admin scope (or an authorized human) takes the admin path.
  serviceScopes: ['gateway', 'admin'],
  human: true,
  humanRoles: ['owner', 'admin'],
})

const channelAdminAction = (): WorkspaceActionDefinition => ({
  resource: 'channels',
  feature: 'channels',
  serviceScopes: ['desktop', 'admin'],
  human: true,
  humanRoles: ['owner', 'admin'],
  humanPermissions: ['org:manage'],
  orgAdminService: true,
})

const channelWatchAction = (): WorkspaceActionDefinition => ({
  resource: 'coordination',
  feature: 'channels',
  serviceScopes: ['desktop'],
  human: true,
})

const adminFeatureAction = (
  resource: WorkspaceActionDefinition['resource'],
  feature: CloudFeatureKey,
): WorkspaceActionDefinition => ({
  resource,
  feature,
  serviceScopes: ['admin'],
  human: true,
  humanPermissions: ['policy:manage'],
  orgAdminService: true,
})

const adminAction = (
  resource: WorkspaceActionDefinition['resource'],
  permission: ControlPlanePermission,
): WorkspaceActionDefinition => ({
  resource,
  serviceScopes: ['admin'],
  human: true,
  humanRoles: ['owner', 'admin'],
  humanPermissions: [permission],
  orgAdminService: true,
})

const operatorAction = (
  resource: WorkspaceActionDefinition['resource'],
  permissions: readonly ControlPlanePermission[],
  workerInternal = false,
): WorkspaceActionDefinition => ({
  resource,
  serviceScopes: workerInternal ? ['operator', 'worker-internal'] : ['operator'],
  human: false,
  humanPermissions: permissions,
  local: true,
  ...(workerInternal ? { workerInternal: true } : {}),
  orgAdminService: true,
})

const permissionAction = (
  resource: WorkspaceActionDefinition['resource'],
  permissions: readonly ControlPlanePermission[],
  serviceScopes: readonly WorkspaceServiceScope[] = ['admin'],
): WorkspaceActionDefinition => ({
  resource,
  serviceScopes,
  human: true,
  humanPermissions: permissions,
  orgAdminService: true,
})

const roleAdminAction = (
  resource: WorkspaceActionDefinition['resource'],
  permissions: readonly ControlPlanePermission[],
  serviceScopes: readonly WorkspaceServiceScope[] = ['admin'],
  feature?: CloudFeatureKey,
): WorkspaceActionDefinition => ({
  resource,
  ...(feature ? { feature } : {}),
  serviceScopes,
  human: true,
  humanRoles: ['owner', 'admin'],
  humanPermissions: permissions,
  orgAdminService: true,
})

export const WORKSPACE_ACTION_DEFINITIONS = {
  'workspace.read': desktopAction('workspace'),
  'workspace.events': desktopAction('workspace', 'chat'),
  'projectSources.validate': desktopAction('projectSources', 'chat'),
  'projectSources.upload': desktopAction('projectSources', 'chat'),

  'sessions.import': desktopAction('sessions', 'chat'),
  'sessions.list': desktopAction('sessions', 'chat'),
  'sessions.create': desktopAction('sessions', 'chat'),
  'sessions.get': desktopAction('sessions', 'chat'),
  'sessions.activate': desktopAction('sessions', 'chat'),
  'sessions.view': desktopAction('sessions', 'chat'),
  'sessions.projectionRead': operatorAction('sessions', ['operations:view'], true),
  'sessions.projectionRepair': operatorAction('sessions', ['operations:view'], true),
  'sessions.events': desktopAction('sessions', 'chat'),
  'sessions.prompt': desktopAction('sessions', 'chat'),
  'sessions.abort': desktopAction('sessions', 'chat'),
  'sessions.questionReply': desktopAction('sessions', 'chat'),
  'sessions.questionReject': desktopAction('sessions', 'chat'),
  'sessions.permissionRespond': desktopAction('sessions', 'chat'),

  'artifacts.index': desktopAction('artifacts', 'artifacts'),
  'artifacts.list': desktopAction('artifacts', 'artifacts'),
  'artifacts.upload': desktopAction('artifacts', 'artifacts'),
  'artifacts.finalize': desktopAction('artifacts', 'artifacts'),
  'artifacts.update': desktopAction('artifacts', 'artifacts'),
  'artifacts.read': desktopAction('artifacts', 'artifacts'),

  'workflows.list': desktopAction('workflows', 'workflows'),
  'workflows.create': desktopAction('workflows', 'workflows'),
  'workflows.createWebhook': {
    ...desktopAction('workflows', 'workflows'),
    additionalFeatures: ['webhooks'],
  },
  'workflows.get': desktopAction('workflows', 'workflows'),
  'workflows.run': desktopAction('workflows', 'workflows'),
  'workflows.rotateWebhookSecret': {
    ...desktopAction('workflows', 'workflows'),
    additionalFeatures: ['webhooks'],
  },
  'workflows.pause': desktopAction('workflows', 'workflows'),
  'workflows.resume': desktopAction('workflows', 'workflows'),
  'workflows.archive': desktopAction('workflows', 'workflows'),
  'workflows.schedulerTick': {
    resource: 'workflows',
    feature: 'workflows',
    serviceScopes: ['worker-internal'],
    human: false,
    workerInternal: true,
  },
  'workflows.webhookInvoke': {
    resource: 'workflows',
    feature: 'workflows',
    additionalFeatures: ['webhooks'],
    serviceScopes: [],
    human: false,
    workflowWebhookCredential: true,
  },

  'channels.directory.read': channelAdminAction(),
  'channels.manage.read': channelAdminAction(),
  'channels.manage.write': channelAdminAction(),
  'channels.service.identity': channelIdentityAction(),
  'channels.deliveries.read': channelDeliveryAdminAction(),
  'channels.deliveries.write': channelDeliveryAdminAction(),
  'channels.service.session': channelServiceAction(),
  'channels.service.cursor': channelServiceAction(),
  'channels.service.interaction': channelServiceAction(),
  'channels.service.providerEvent': channelServiceAction(),
  'channels.service.delivery': channelServiceAction(),
  'channels.service.artifact': channelArtifactServiceAction(),

  'settings.read': desktopAction('settings', 'settings'),
  'settings.write': desktopAction('settings', 'settings'),
  'threads.read': desktopAction('threads', 'threadIndex'),
  'threads.write': desktopAction('threads', 'threadIndex'),
  'coordination.read': desktopAction('coordination'),
  'coordination.write': desktopAction('coordination'),
  'coordination.watches.read': channelWatchAction(),
  'coordination.watches.write': channelWatchAction(),
  'knowledge.read': desktopAction('knowledge', 'knowledge'),
  'knowledge.propose': desktopAction('knowledge', 'knowledge'),
  'knowledge.adminWrite': roleAdminAction('knowledge', ['org:manage'], ['admin'], 'knowledge'),
  'knowledge.agentPropose': {
    resource: 'knowledge',
    feature: 'knowledge',
    serviceScopes: [],
    human: false,
    knowledgeAgentCredential: true,
  },
  'launchpad.read': desktopAction('launchpad', 'chat'),
  'billing.read': desktopAction('billing'),
  'billing.write': adminAction('billing', 'billing:manage'),
  'billing.webhookApply': {
    resource: 'billing',
    serviceScopes: [],
    human: false,
    billingWebhookCredential: true,
  },
  'usage.read': permissionAction('usage', ['operations:view', 'billing:manage'], ['admin', 'operator']),
  'byok.read': adminFeatureAction('byok', 'byok'),
  'byok.write': adminFeatureAction('byok', 'byok'),
  'capabilities.read': {
    resource: 'capabilities',
    anyFeatures: ['agents', 'customSkills', 'customMcps'],
    serviceScopes: ['desktop'],
    human: true,
  },

  'policy.effectiveRead': {
    resource: 'policy',
    serviceScopes: ['desktop', 'admin'],
    human: true,
  },
  'policy.read': {
    ...permissionAction('policy', ['policy:manage']),
  },
  'policy.write': {
    ...permissionAction('policy', ['policy:manage']),
  },
  'apiTokens.read': roleAdminAction('apiTokens', ['api_tokens:read']),
  'apiTokens.write': roleAdminAction('apiTokens', ['api_tokens:manage']),
  'admin.read': {
    resource: 'admin',
    serviceScopes: ['desktop', 'admin'],
    human: true,
  },
  'admin.audit.read': permissionAction('admin', ['audit:read']),
  'admin.roles.read': permissionAction('admin', ['roles:manage']),
  'admin.roles.write': permissionAction('admin', ['roles:manage']),
  'admin.members.read': permissionAction('admin', ['members:read', 'org:manage', 'members:manage']),
  'admin.members.write': permissionAction('admin', ['org:manage', 'members:manage']),
  'admin.sso.read': permissionAction('admin', ['sso:manage']),
  'admin.sso.write': permissionAction('admin', ['sso:manage']),
  'admin.workers.read': roleAdminAction('admin', ['org:manage'], ['admin', 'operator']),
  'admin.workers.write': roleAdminAction('admin', ['org:manage'], ['admin', 'operator']),
  'operator.metricsRead': operatorAction('operator', ['operations:view']),
  'operator.diagnosticsRead': operatorAction('operator', ['diagnostics:view']),
  'operator.runtimeRead': operatorAction('operator', ['operations:view'], true),
  'worker.heartbeat': {
    resource: 'worker',
    serviceScopes: [],
    human: false,
    workerCredential: true,
  },
} as const satisfies Record<string, WorkspaceActionDefinition>

export type WorkspaceAction = keyof typeof WORKSPACE_ACTION_DEFINITIONS

export const WORKSPACE_PROVIDER_KEY_ACTIONS = {
  read: 'byok.read',
  write: 'byok.write',
} as const satisfies Record<'read' | 'write', WorkspaceAction>

export const WORKSPACE_PROVIDER_KEY_FEATURE = 'byok' as const satisfies CloudFeatureKey

export type WorkspacePolicyDecision =
  | {
    outcome: 'allow'
    action: WorkspaceAction
    principalClass: WorkspacePrincipalClass
    resource: Exclude<WorkspaceResource, 'unknown'>
  }
  | {
    outcome: 'deny'
    action: WorkspaceAction | 'unknown'
    principalClass: WorkspacePrincipalClass
    resource: WorkspaceResource
    code: WorkspacePolicyDenialCode
    message: string
  }

export type WorkspacePolicyDenialCode =
  | 'authorization.action_unknown'
  | 'authorization.principal_denied'
  | 'authorization.scope_required'
  | 'channels.binding_scope_required'
  | 'capabilities.disabled'
  | 'thread_index.disabled'
  | `${CloudFeatureKey}.disabled`

/**
 * Closed denial-code catalog used by bounded telemetry. Derive feature codes
 * from the same action definitions that can emit them so adding a gated
 * action cannot silently collapse its reason into an `other` metric bucket.
 */
export const WORKSPACE_POLICY_DENIAL_CODES: readonly WorkspacePolicyDenialCode[] = Object.freeze([
  'authorization.action_unknown',
  'authorization.principal_denied',
  'authorization.scope_required',
  'channels.binding_scope_required',
  ...new Set(
    Object.values(WORKSPACE_ACTION_DEFINITIONS).flatMap((definition) => [
      ...('feature' in definition && definition.feature ? [featureDenialCode(definition.feature)] : []),
      ...('additionalFeatures' in definition && definition.additionalFeatures
        ? definition.additionalFeatures.map(featureDenialCode)
        : []),
      ...('anyFeatures' in definition && definition.anyFeatures ? ['capabilities.disabled' as const] : []),
    ]),
  ),
])

export type WorkspaceCapabilityPolicyInput = {
  action: unknown
  principal: WorkspacePolicyPrincipal
  features: Partial<CloudFeatureConfig> | null | undefined
  bindingScoped?: boolean
}

const SERVICE_SCOPES = new Set<WorkspaceServiceScope>([
  'desktop',
  'gateway',
  'admin',
  'operator',
  'worker-internal',
])

export function evaluateWorkspaceCapabilityPolicy(
  input: WorkspaceCapabilityPolicyInput,
): WorkspacePolicyDecision {
  const principalClass = classifyWorkspacePrincipal(input.principal)
  if (!isWorkspaceAction(input.action)) {
    return deny('unknown', principalClass, 'unknown', 'authorization.action_unknown')
  }

  const action = input.action
  const definition: WorkspaceActionDefinition = WORKSPACE_ACTION_DEFINITIONS[action]
  const featureDenial = workspaceActionFeatureDenialCode(action, input.features)
  if (featureDenial) return deny(action, principalClass, definition.resource, featureDenial)

  const scopes = readServiceScopes(input.principal.tokenScopes)
  if (!principalCanUseAction(input.principal, principalClass, scopes, definition)) {
    const code = principalClass.endsWith('-service') || principalClass === 'mixed-service'
      ? 'authorization.scope_required'
      : 'authorization.principal_denied'
    return deny(action, principalClass, definition.resource, code)
  }

  // Feature availability is profile-level public configuration. Resolve it
  // before a resource-scoped grant so a disabled feature cannot become an
  // oracle for whether any active binding grant exists.
  if (
    actionNeedsGatewayBindingVerification(definition, scopes)
    && !input.bindingScoped
  ) {
    return deny(action, principalClass, definition.resource, 'channels.binding_scope_required')
  }

  return {
    outcome: 'allow',
    action,
    principalClass,
    resource: definition.resource,
  }
}

/**
 * Public profile features are safe to resolve before membership/grant lookups.
 * HTTP/Desktop adapters use this same helper for lookup ordering; the final
 * decision still comes from evaluateWorkspaceCapabilityPolicy exactly once.
 */
export function workspaceActionFeatureDenialCode(
  action: unknown,
  features: Partial<CloudFeatureConfig> | null | undefined,
): WorkspacePolicyDenialCode | null {
  if (!isWorkspaceAction(action)) return null
  const definition: WorkspaceActionDefinition = WORKSPACE_ACTION_DEFINITIONS[action]
  for (const feature of [definition.feature, ...(definition.additionalFeatures || [])]) {
    if (feature && features?.[feature] !== true) return featureDenialCode(feature)
  }
  if (definition.anyFeatures && !definition.anyFeatures.some((feature) => features?.[feature] === true)) {
    return 'capabilities.disabled'
  }
  return null
}

/** Whether an otherwise-authorized gateway action still needs target binding proof. */
export function workspaceActionNeedsGatewayBindingVerification(
  action: unknown,
  principal: WorkspacePolicyPrincipal,
) {
  if (!isWorkspaceAction(action)) return false
  const definition: WorkspaceActionDefinition = WORKSPACE_ACTION_DEFINITIONS[action]
  const principalClass = classifyWorkspacePrincipal(principal)
  const scopes = readServiceScopes(principal.tokenScopes)
  return actionNeedsGatewayBindingVerification(definition, scopes)
    && principalCanUseAction(principal, principalClass, scopes, definition)
}

export function classifyWorkspacePrincipal(
  principal: WorkspacePolicyPrincipal,
): WorkspacePrincipalClass {
  if (principal.authSource === 'local') return 'local'
  if (principal.authSource === 'header') return 'header'
  if (principal.authSource === 'worker') return 'worker-service'
  if (principal.authSource === 'signed_workflow_webhook') return 'workflow-webhook-service'
  if (principal.authSource === 'signed_knowledge_agent') return 'knowledge-agent-service'
  if (principal.authSource === 'verified_billing_webhook') return 'billing-webhook-service'
  if (principal.authSource === 'user') return 'user'
  if (principal.authSource !== 'api_token') return 'unknown'

  const scopes = readServiceScopes(principal.tokenScopes)
  if (!scopes || scopes.length === 0) return 'unknown'
  if (scopes.length > 1) return 'mixed-service'
  if (scopes[0] === 'desktop') return 'desktop-service'
  if (scopes[0] === 'gateway') return 'gateway-service'
  if (scopes[0] === 'admin') return 'admin-service'
  if (scopes[0] === 'operator') return 'operator-service'
  if (scopes[0] === 'worker-internal') return 'worker-internal-service'
  return 'unknown'
}

export function isWorkspaceAction(value: unknown): value is WorkspaceAction {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(WORKSPACE_ACTION_DEFINITIONS, value)
}

function principalCanUseAction(
  principal: WorkspacePolicyPrincipal,
  principalClass: WorkspacePrincipalClass,
  scopes: WorkspaceServiceScope[] | null,
  definition: WorkspaceActionDefinition,
) {
  if (principalClass === 'unknown') return false
  if (principalClass === 'worker-service') return definition.workerCredential === true
  if (principalClass === 'worker-internal-service') return definition.workerInternal === true
  if (principalClass === 'workflow-webhook-service') return definition.workflowWebhookCredential === true
  if (principalClass === 'knowledge-agent-service') return definition.knowledgeAgentCredential === true
  if (principalClass === 'billing-webhook-service') return definition.billingWebhookCredential === true
  if (principalClass === 'local') return definition.local === true || definition.human
  if (principalClass === 'user' || principalClass === 'header') {
    if (!definition.human) return false
    const customRoleAssigned = principal.customRoleKey !== undefined && principal.customRoleKey !== null
    if (customRoleAssigned && (typeof principal.customRoleKey !== 'string' || !principal.customRoleKey.trim())) return false
    if (
      definition.humanRoles
      && !customRoleAssigned
      && !definition.humanRoles.includes(principal.role as 'owner' | 'admin' | 'member')
    ) return false
    if (definition.humanPermissions) {
      // A custom role replaces its base role. Its resolved permission map is
      // therefore authoritative for actions that otherwise accept built-in
      // owner/admin roles. Built-in roles retain their established role gate.
      if (definition.humanRoles && !customRoleAssigned) return true
      const permissions = readHumanPermissions(principal.permissions)
      return permissions !== null && definition.humanPermissions.some((permission) => permissions.includes(permission))
    }
    if (definition.humanRoles && customRoleAssigned) return false
    return true
  }
  if (!scopes) return false
  // Service scopes compose per action. Carrying gateway does not erase an
  // explicit desktop/admin/operator grant, while gateway actions themselves
  // remain binding-scoped below.
  const hasRequiredScope = definition.serviceScopes.some((scope) => scopes.includes(scope))
  if (!hasRequiredScope) return false
  const workerInternalGrant = scopes.includes('worker-internal') && definition.workerInternal === true
  if (definition.orgAdminService && !workerInternalGrant) {
    const customRoleAssigned = principal.customRoleKey !== undefined && principal.customRoleKey !== null
    if (customRoleAssigned) {
      if (typeof principal.customRoleKey !== 'string' || !principal.customRoleKey.trim()) return false
      const permissions = readHumanPermissions(principal.permissions)
      if (
        permissions === null
        || !definition.humanPermissions?.some((permission) => permissions.includes(permission))
      ) return false
    } else if (!isOrgAdminRole(principal.role)) {
      return false
    }
  }
  return true
}

function actionNeedsGatewayBindingVerification(
  definition: WorkspaceActionDefinition,
  scopes: readonly WorkspaceServiceScope[] | null,
) {
  if (definition.gatewayBindingScoped !== true || !scopes?.includes('gateway')) return false
  // A binding proof is required only when gateway is the scope authorizing the
  // action. Identity bootstrap also accepts admin explicitly, so gateway+admin
  // takes that narrow pre-binding path; session/delivery actions accept only
  // gateway and therefore remain bound even on mixed-scope tokens.
  return !definition.serviceScopes.some((scope) => scope !== 'gateway' && scopes.includes(scope))
}

function readHumanPermissions(value: unknown): ControlPlanePermission[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((entry): entry is ControlPlanePermission => typeof entry === 'string')) return null
  return [...new Set(value)]
}

function readServiceScopes(value: unknown): WorkspaceServiceScope[] | null {
  if (!Array.isArray(value)) return value === undefined ? [] : null
  const scopes = new Set<WorkspaceServiceScope>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !SERVICE_SCOPES.has(entry as WorkspaceServiceScope)) return null
    scopes.add(entry as WorkspaceServiceScope)
  }
  return [...scopes]
}

function isOrgAdminRole(role: unknown) {
  return role === 'owner' || role === 'admin'
}

function deny(
  action: WorkspaceAction | 'unknown',
  principalClass: WorkspacePrincipalClass,
  resource: WorkspaceResource,
  code: WorkspacePolicyDenialCode,
): Extract<WorkspacePolicyDecision, { outcome: 'deny' }> {
  return {
    outcome: 'deny',
    action,
    principalClass,
    resource,
    code,
    message: denialMessage(code),
  }
}

function denialMessage(code: WorkspacePolicyDenialCode) {
  if (code === 'chat.disabled') return 'Chat is disabled for this cloud profile.'
  if (code === 'artifacts.disabled') return 'Artifacts are disabled for this cloud profile.'
  if (code === 'workflows.disabled') return 'Workflows are disabled for this cloud profile.'
  if (code === 'webhooks.disabled') return 'Webhooks are disabled for this cloud profile.'
  if (code === 'channels.disabled') return 'Channels are disabled for this cloud profile.'
  if (code === 'settings.disabled') return 'Settings are disabled for this cloud profile.'
  if (code === 'thread_index.disabled') return 'Thread index is disabled for this cloud profile.'
  if (code === 'knowledge.disabled') return 'Knowledge is disabled for this cloud profile.'
  if (code === 'byok.disabled') return 'Bring-your-own-key is disabled for this cloud profile.'
  if (code === 'capabilities.disabled') return 'Capabilities are disabled for this cloud profile.'
  if (code === 'channels.binding_scope_required') return 'Channel binding scope is required for this action.'
  if (code === 'authorization.scope_required') return 'The authenticated service token is not authorized for this workspace action.'
  if (code === 'authorization.principal_denied') return 'The authenticated principal cannot perform this workspace action.'
  return 'Workspace action is not authorized.'
}

function featureDenialCode(feature: CloudFeatureKey): WorkspacePolicyDenialCode {
  return feature === 'threadIndex' ? 'thread_index.disabled' : `${feature}.disabled`
}
