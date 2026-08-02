import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WORKSPACE_ACTION_DEFINITIONS,
  WORKSPACE_PRINCIPAL_CLASSES,
  evaluateWorkspaceCapabilityPolicy,
  workspaceActionNeedsGatewayBindingVerification,
  type WorkspaceAction,
  type WorkspaceResource,
  type WorkspaceServiceScope,
} from '@open-cowork/shared'

const enabledFeatures = {
  chat: true,
  agents: true,
  artifacts: true,
  threadIndex: true,
  workflows: true,
  webhooks: true,
  settings: true,
  customSkills: true,
  customAgents: true,
  customMcps: true,
  knowledge: true,
  channels: true,
  byok: true,
} as const

const expectedActions = [
  'admin.read',
  'admin.audit.read',
  'admin.members.read',
  'admin.members.write',
  'admin.roles.read',
  'admin.roles.write',
  'admin.sso.read',
  'admin.sso.write',
  'admin.workers.read',
  'admin.workers.write',
  'apiTokens.read',
  'apiTokens.write',
  'artifacts.finalize',
  'artifacts.index',
  'artifacts.list',
  'artifacts.read',
  'artifacts.update',
  'artifacts.upload',
  'billing.read',
  'billing.webhookApply',
  'billing.write',
  'byok.read',
  'byok.write',
  'capabilities.read',
  'channels.directory.read',
  'channels.manage.read',
  'channels.manage.write',
  'channels.deliveries.read',
  'channels.deliveries.write',
  'channels.service.cursor',
  'channels.service.delivery',
  'channels.service.artifact',
  'channels.service.identity',
  'channels.service.interaction',
  'channels.service.providerEvent',
  'channels.service.session',
  'coordination.read',
  'coordination.watches.read',
  'coordination.watches.write',
  'coordination.write',
  'knowledge.adminWrite',
  'knowledge.propose',
  'knowledge.read',
  'knowledge.agentPropose',
  'launchpad.read',
  'operator.metricsRead',
  'operator.diagnosticsRead',
  'operator.runtimeRead',
  'policy.effectiveRead',
  'policy.read',
  'policy.write',
  'projectSources.upload',
  'projectSources.validate',
  'sessions.abort',
  'sessions.activate',
  'sessions.create',
  'sessions.events',
  'sessions.get',
  'sessions.import',
  'sessions.list',
  'sessions.permissionRespond',
  'sessions.projectionRead',
  'sessions.projectionRepair',
  'sessions.prompt',
  'sessions.questionReject',
  'sessions.questionReply',
  'sessions.view',
  'settings.read',
  'settings.write',
  'threads.read',
  'threads.write',
  'usage.read',
  'worker.heartbeat',
  'workspace.events',
  'workspace.read',
  'workflows.archive',
  'workflows.create',
  'workflows.createWebhook',
  'workflows.get',
  'workflows.webhookInvoke',
  'workflows.list',
  'workflows.pause',
  'workflows.resume',
  'workflows.rotateWebhookSecret',
  'workflows.run',
  'workflows.schedulerTick',
] as const satisfies readonly WorkspaceAction[]

const expectedResourceByAction: Record<WorkspaceAction, WorkspaceResource> = {
  'workspace.read': 'workspace',
  'workspace.events': 'workspace',
  'projectSources.validate': 'projectSources',
  'projectSources.upload': 'projectSources',
  'sessions.import': 'sessions',
  'sessions.list': 'sessions',
  'sessions.create': 'sessions',
  'sessions.get': 'sessions',
  'sessions.activate': 'sessions',
  'sessions.view': 'sessions',
  'sessions.projectionRead': 'sessions',
  'sessions.projectionRepair': 'sessions',
  'sessions.events': 'sessions',
  'sessions.prompt': 'sessions',
  'sessions.abort': 'sessions',
  'sessions.questionReply': 'sessions',
  'sessions.questionReject': 'sessions',
  'sessions.permissionRespond': 'sessions',
  'artifacts.index': 'artifacts',
  'artifacts.list': 'artifacts',
  'artifacts.upload': 'artifacts',
  'artifacts.finalize': 'artifacts',
  'artifacts.update': 'artifacts',
  'artifacts.read': 'artifacts',
  'workflows.list': 'workflows',
  'workflows.create': 'workflows',
  'workflows.createWebhook': 'workflows',
  'workflows.get': 'workflows',
  'workflows.run': 'workflows',
  'workflows.rotateWebhookSecret': 'workflows',
  'workflows.pause': 'workflows',
  'workflows.resume': 'workflows',
  'workflows.archive': 'workflows',
  'workflows.schedulerTick': 'workflows',
  'workflows.webhookInvoke': 'workflows',
  'channels.directory.read': 'channels',
  'channels.manage.read': 'channels',
  'channels.manage.write': 'channels',
  'channels.deliveries.read': 'channels',
  'channels.deliveries.write': 'channels',
  'channels.service.identity': 'channels',
  'channels.service.session': 'channels',
  'channels.service.cursor': 'channels',
  'channels.service.interaction': 'channels',
  'channels.service.providerEvent': 'channels',
  'channels.service.delivery': 'channels',
  'channels.service.artifact': 'artifacts',
  'settings.read': 'settings',
  'settings.write': 'settings',
  'threads.read': 'threads',
  'threads.write': 'threads',
  'coordination.read': 'coordination',
  'coordination.write': 'coordination',
  'coordination.watches.read': 'coordination',
  'coordination.watches.write': 'coordination',
  'knowledge.adminWrite': 'knowledge',
  'knowledge.propose': 'knowledge',
  'knowledge.read': 'knowledge',
  'knowledge.agentPropose': 'knowledge',
  'launchpad.read': 'launchpad',
  'billing.read': 'billing',
  'billing.webhookApply': 'billing',
  'billing.write': 'billing',
  'usage.read': 'usage',
  'byok.read': 'byok',
  'byok.write': 'byok',
  'capabilities.read': 'capabilities',
  'policy.effectiveRead': 'policy',
  'policy.read': 'policy',
  'policy.write': 'policy',
  'apiTokens.read': 'apiTokens',
  'apiTokens.write': 'apiTokens',
  'admin.read': 'admin',
  'admin.audit.read': 'admin',
  'admin.roles.read': 'admin',
  'admin.roles.write': 'admin',
  'admin.members.read': 'admin',
  'admin.members.write': 'admin',
  'admin.sso.read': 'admin',
  'admin.sso.write': 'admin',
  'admin.workers.read': 'admin',
  'admin.workers.write': 'admin',
  'operator.metricsRead': 'operator',
  'operator.diagnosticsRead': 'operator',
  'operator.runtimeRead': 'operator',
  'worker.heartbeat': 'worker',
}

const desktopDataActions = [
  'workspace.read',
  'workspace.events',
  'projectSources.validate',
  'projectSources.upload',
  'sessions.import',
  'sessions.list',
  'sessions.create',
  'sessions.get',
  'sessions.activate',
  'sessions.view',
  'sessions.events',
  'sessions.prompt',
  'sessions.abort',
  'sessions.questionReply',
  'sessions.questionReject',
  'sessions.permissionRespond',
  'artifacts.index',
  'artifacts.list',
  'artifacts.upload',
  'artifacts.finalize',
  'artifacts.update',
  'artifacts.read',
  'workflows.list',
  'workflows.create',
  'workflows.createWebhook',
  'workflows.get',
  'workflows.run',
  'workflows.rotateWebhookSecret',
  'workflows.pause',
  'workflows.resume',
  'workflows.archive',
  'settings.read',
  'settings.write',
  'threads.read',
  'threads.write',
  'coordination.read',
  'coordination.write',
  'knowledge.read',
  'knowledge.propose',
  'launchpad.read',
  'billing.read',
  'capabilities.read',
] as const satisfies readonly WorkspaceAction[]

const watchActions = [
  'coordination.watches.read',
  'coordination.watches.write',
] as const satisfies readonly WorkspaceAction[]

const channelAdminActions = [
  'channels.directory.read',
  'channels.manage.read',
  'channels.manage.write',
] as const satisfies readonly WorkspaceAction[]

const channelServiceActions = [
  'channels.service.identity',
  'channels.deliveries.read',
  'channels.deliveries.write',
  'channels.service.session',
  'channels.service.cursor',
  'channels.service.interaction',
  'channels.service.providerEvent',
  'channels.service.delivery',
  'channels.service.artifact',
] as const satisfies readonly WorkspaceAction[]

const channelAdminGatewayActions = [
  'channels.service.identity',
  'channels.deliveries.read',
  'channels.deliveries.write',
] as const satisfies readonly WorkspaceAction[]

const adminControlPlaneActions = [
  'admin.read',
  'admin.audit.read',
  'admin.roles.read',
  'admin.roles.write',
  'admin.members.read',
  'admin.members.write',
  'admin.sso.read',
  'admin.sso.write',
  'admin.workers.read',
  'admin.workers.write',
] as const satisfies readonly WorkspaceAction[]

const openHumanActions = [
  ...desktopDataActions,
  ...watchActions,
  'policy.effectiveRead',
  'admin.read',
] as const satisfies readonly WorkspaceAction[]

const desktopServiceActions = [
  ...desktopDataActions,
  ...watchActions,
  'policy.effectiveRead',
  'admin.read',
] as const satisfies readonly WorkspaceAction[]

const adminServiceActions = [
  ...channelAdminActions,
  ...channelAdminGatewayActions,
  'billing.write',
  'usage.read',
  'byok.read',
  'byok.write',
  'knowledge.adminWrite',
  'policy.effectiveRead',
  'policy.read',
  'policy.write',
  'apiTokens.read',
  'apiTokens.write',
  ...adminControlPlaneActions,
] as const satisfies readonly WorkspaceAction[]

const operatorServiceActions = [
  'sessions.projectionRead',
  'sessions.projectionRepair',
  'usage.read',
  'admin.workers.read',
  'admin.workers.write',
  'operator.metricsRead',
  'operator.diagnosticsRead',
  'operator.runtimeRead',
] as const satisfies readonly WorkspaceAction[]

const workerInternalServiceActions = [
  'sessions.projectionRead',
  'sessions.projectionRepair',
  'workflows.schedulerTick',
  'operator.runtimeRead',
] as const satisfies readonly WorkspaceAction[]

const expectedActionsByServiceScope: Record<WorkspaceServiceScope, readonly WorkspaceAction[]> = {
  desktop: [...desktopServiceActions, ...channelAdminActions],
  gateway: channelServiceActions,
  admin: adminServiceActions,
  operator: operatorServiceActions,
  'worker-internal': workerInternalServiceActions,
}

const expectedMemberActionsByServiceScope: Record<WorkspaceServiceScope, readonly WorkspaceAction[]> = {
  desktop: desktopServiceActions,
  gateway: [],
  admin: ['policy.effectiveRead', 'admin.read'],
  operator: [],
  'worker-internal': workerInternalServiceActions,
}

// Independent semantic oracle for the exhaustive matrix. This deliberately
// does not inspect WORKSPACE_ACTION_DEFINITIONS: broadening or narrowing any
// implementation rule must change an explicit expected capability here.
const expectedAllowedActionsByPrincipalClass: Record<
  (typeof WORKSPACE_PRINCIPAL_CLASSES)[number],
  readonly WorkspaceAction[]
> = {
  user: openHumanActions,
  local: expectedActions.filter((action) => (
    action !== 'workflows.schedulerTick'
    && action !== 'worker.heartbeat'
    && action !== 'workflows.webhookInvoke'
    && action !== 'knowledge.agentPropose'
    && action !== 'billing.webhookApply'
  )),
  header: [
    ...openHumanActions,
    ...channelAdminActions,
    ...channelAdminGatewayActions,
    'billing.write',
    'apiTokens.read',
    'apiTokens.write',
    'admin.workers.read',
    'admin.workers.write',
    'knowledge.adminWrite',
  ],
  'desktop-service': desktopServiceActions,
  'gateway-service': channelServiceActions,
  'admin-service': adminServiceActions,
  'operator-service': operatorServiceActions,
  'worker-service': ['worker.heartbeat'],
  'worker-internal-service': workerInternalServiceActions,
  'workflow-webhook-service': ['workflows.webhookInvoke'],
  'knowledge-agent-service': ['knowledge.agentPropose'],
  'billing-webhook-service': ['billing.webhookApply'],
  'mixed-service': [...desktopServiceActions, ...channelAdminActions, ...channelServiceActions],
  unknown: [],
}

test('workspace policy catalog is a closed exhaustive action inventory', () => {
  assert.deepEqual(Object.keys(WORKSPACE_ACTION_DEFINITIONS).sort(), [...expectedActions].sort())

  for (const principalClass of WORKSPACE_PRINCIPAL_CLASSES) {
    const expectedAllowed = new Set(expectedAllowedActionsByPrincipalClass[principalClass])
    for (const action of expectedActions) {
      const decision = evaluateWorkspaceCapabilityPolicy({
        action,
        principal: principalForClass(principalClass),
        features: enabledFeatures,
        bindingScoped: true,
      })
      assert.equal(
        decision.outcome,
        expectedAllowed.has(action) ? 'allow' : 'deny',
        `${principalClass} × ${action}`,
      )
      assert.equal(decision.action, action)
      assert.equal(decision.principalClass, principalClass)
      assert.equal(decision.resource, expectedResourceByAction[action])
    }
  }
})

test('workspace policy denies unknown and malformed inputs without broad fallback', () => {
  const unknownAction = evaluateWorkspaceCapabilityPolicy({
    action: 'sessions.future-action',
    principal: { authSource: 'user', role: 'owner', tokenScopes: [] },
    features: enabledFeatures,
  })
  assert.deepEqual(unknownAction, {
    outcome: 'deny',
    action: 'unknown',
    principalClass: 'user',
    resource: 'unknown',
    code: 'authorization.action_unknown',
    message: 'Workspace action is not authorized.',
  })

  const malformedPrincipal = evaluateWorkspaceCapabilityPolicy({
    action: 'sessions.list',
    principal: { authSource: 'unexpected', role: 'owner', tokenScopes: ['desktop'] },
    features: enabledFeatures,
  })
  assert.equal(malformedPrincipal.outcome, 'deny')
  assert.equal(malformedPrincipal.principalClass, 'unknown')
  assert.equal(malformedPrincipal.code, 'authorization.principal_denied')

  const missingAuthSource = evaluateWorkspaceCapabilityPolicy({
    action: 'workspace.read',
    principal: { role: 'owner', tokenScopes: [] },
    features: enabledFeatures,
  })
  assert.equal(missingAuthSource.outcome, 'deny')
  assert.equal(missingAuthSource.principalClass, 'unknown')
})

test('chat=false denies every session action consistently for user, local, and desktop-service principals', () => {
  const sessionActions = expectedActions.filter((action) => (
    action.startsWith('sessions.')
    && action !== 'sessions.projectionRead'
    && action !== 'sessions.projectionRepair'
  ))
  const principals = [
    { authSource: 'user', role: 'member', tokenScopes: [] },
    { authSource: 'local', role: 'owner', tokenScopes: [] },
    { authSource: 'api_token', role: 'member', tokenScopes: ['desktop'] },
  ]

  for (const principal of principals) {
    for (const action of sessionActions) {
      const decision = evaluateWorkspaceCapabilityPolicy({
        action,
        principal,
        features: { ...enabledFeatures, chat: false },
      })
      assert.equal(decision.outcome, 'deny')
      assert.equal(decision.code, 'chat.disabled')
      assert.equal(decision.message, 'Chat is disabled for this cloud profile.')
    }
  }
})

test('projection operations require operator or internal-worker authority and are independent of chat', () => {
  for (const action of ['sessions.projectionRead', 'sessions.projectionRepair'] as const) {
    const memberDecision = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: { authSource: 'user', role: 'member' },
      features: { ...enabledFeatures, chat: false },
    })
    assert.equal(memberDecision.outcome, 'deny')

    const operatorDecision = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: { authSource: 'api_token', role: 'admin', tokenScopes: ['operator'] },
      features: { ...enabledFeatures, chat: false },
    })
    assert.equal(operatorDecision.outcome, 'allow')

    const internalDecision = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: { authSource: 'api_token', role: 'member', tokenScopes: ['worker-internal'] },
      features: { ...enabledFeatures, chat: false },
    })
    assert.equal(internalDecision.outcome, 'allow')
  }
})

test('API token scopes compose explicitly and admin is not a wildcard', () => {
  const adminOnlySession = evaluateWorkspaceCapabilityPolicy({
    action: 'sessions.get',
    principal: { authSource: 'api_token', role: 'owner', tokenScopes: ['admin'] },
    features: enabledFeatures,
  })
  assert.equal(adminOnlySession.outcome, 'deny')
  assert.equal(adminOnlySession.code, 'authorization.scope_required')

  const desktopAdmin = evaluateWorkspaceCapabilityPolicy({
    action: 'sessions.get',
    principal: { authSource: 'api_token', role: 'owner', tokenScopes: ['desktop', 'admin'] },
    features: enabledFeatures,
  })
  assert.equal(desktopAdmin.outcome, 'allow')

  const desktopCanLoadAdminAccess = evaluateWorkspaceCapabilityPolicy({
    action: 'admin.read',
    principal: { authSource: 'api_token', role: 'owner', tokenScopes: ['desktop'] },
    features: enabledFeatures,
  })
  assert.equal(desktopCanLoadAdminAccess.outcome, 'allow')

  const desktopCannotManageBilling = evaluateWorkspaceCapabilityPolicy({
    action: 'billing.write',
    principal: { authSource: 'api_token', role: 'owner', tokenScopes: ['desktop'] },
    features: enabledFeatures,
  })
  assert.equal(desktopCannotManageBilling.outcome, 'deny')

  const adminCanManageBilling = evaluateWorkspaceCapabilityPolicy({
    action: 'billing.write',
    principal: { authSource: 'api_token', role: 'owner', tokenScopes: ['admin'] },
    features: enabledFeatures,
  })
  assert.equal(adminCanManageBilling.outcome, 'allow')
})

test('human RBAC is fail-closed and honors resolved roles and custom permissions', () => {
  const unresolvedPolicyManager = evaluateWorkspaceCapabilityPolicy({
    action: 'policy.write',
    principal: { authSource: 'user', role: 'member' },
    features: enabledFeatures,
  })
  assert.equal(unresolvedPolicyManager.outcome, 'deny')
  assert.equal(unresolvedPolicyManager.code, 'authorization.principal_denied')

  const delegatedPolicyManager = evaluateWorkspaceCapabilityPolicy({
    action: 'policy.write',
    principal: { authSource: 'user', role: 'member', permissions: ['policy:manage'] },
    features: enabledFeatures,
  })
  assert.equal(delegatedPolicyManager.outcome, 'allow')

  const unrelatedPermission = evaluateWorkspaceCapabilityPolicy({
    action: 'admin.audit.read',
    principal: { authSource: 'header', role: 'admin', permissions: ['policy:manage'] },
    features: enabledFeatures,
  })
  assert.equal(unrelatedPermission.outcome, 'deny')

  const delegatedAuditor = evaluateWorkspaceCapabilityPolicy({
    action: 'admin.audit.read',
    principal: { authSource: 'header', role: 'member', permissions: ['audit:read'] },
    features: enabledFeatures,
  })
  assert.equal(delegatedAuditor.outcome, 'allow')

  for (const action of ['channels.manage.write', 'channels.service.identity', 'channels.deliveries.read', 'channels.deliveries.write', 'billing.write', 'apiTokens.write'] as const) {
    const member = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: { authSource: 'user', role: 'member', permissions: [] },
      features: enabledFeatures,
    })
    assert.equal(member.outcome, 'deny', action)

    const owner = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: { authSource: 'user', role: 'owner', permissions: [] },
      features: enabledFeatures,
    })
    assert.equal(owner.outcome, 'allow', action)
  }

  const delegatedActions = [
    ['channels.manage.write', 'org:manage'],
    ['channels.service.identity', 'org:manage'],
    ['channels.deliveries.read', 'org:manage'],
    ['channels.deliveries.write', 'org:manage'],
    ['billing.write', 'billing:manage'],
    ['apiTokens.read', 'api_tokens:read'],
    ['apiTokens.write', 'api_tokens:manage'],
    ['admin.workers.read', 'org:manage'],
    ['admin.workers.write', 'org:manage'],
    ['knowledge.adminWrite', 'org:manage'],
    ['admin.members.read', 'members:read'],
  ] as const
  for (const [action, permission] of delegatedActions) {
    const upgradedMember = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: {
        authSource: 'user',
        role: 'member',
        customRoleKey: 'delegated-operator',
        permissions: [permission],
      },
      features: enabledFeatures,
    })
    assert.equal(upgradedMember.outcome, 'allow', `${action}: custom-role upgrade`)

    const downgradedAdmin = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: {
        authSource: 'user',
        role: 'admin',
        customRoleKey: 'restricted-admin',
        permissions: [],
      },
      features: enabledFeatures,
    })
    assert.equal(downgradedAdmin.outcome, 'deny', `${action}: custom-role downgrade`)
    assert.equal(downgradedAdmin.code, 'authorization.principal_denied')
  }

  const readOnlyTokenManager = evaluateWorkspaceCapabilityPolicy({
    action: 'apiTokens.write',
    principal: {
      authSource: 'user',
      role: 'member',
      customRoleKey: 'token-reader',
      permissions: ['api_tokens:read'],
    },
    features: enabledFeatures,
  })
  assert.equal(readOnlyTokenManager.outcome, 'deny')
})

test('public feature availability is decided before human grants', () => {
  const decision = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.manage.write',
    principal: {
      authSource: 'user',
      role: 'member',
      customRoleKey: 'restricted-member',
      permissions: [],
    },
    features: { ...enabledFeatures, channels: false },
  })
  assert.equal(decision.outcome, 'deny')
  assert.equal(decision.code, 'channels.disabled')
})

test('webhook-secret rotation requires both workflows and webhooks', () => {
  const decision = evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.rotateWebhookSecret',
    principal: { authSource: 'api_token', role: 'member', tokenScopes: ['desktop'] },
    features: { ...enabledFeatures, webhooks: false },
  })
  assert.equal(decision.outcome, 'deny')
  assert.equal(decision.code, 'webhooks.disabled')
})

test('signed ingress principals are single-action and honor current feature gates', () => {
  const workflowPrincipal = { authSource: 'signed_workflow_webhook' }
  const knowledgePrincipal = { authSource: 'signed_knowledge_agent' }

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.webhookInvoke',
    principal: workflowPrincipal,
    features: enabledFeatures,
  }).outcome, 'allow')
  const disabledWebhook = evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.webhookInvoke',
    principal: workflowPrincipal,
    features: { ...enabledFeatures, webhooks: false },
  })
  assert.equal(disabledWebhook.outcome, 'deny')
  assert.equal(disabledWebhook.code, 'webhooks.disabled')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.run',
    principal: workflowPrincipal,
    features: enabledFeatures,
  }).outcome, 'deny')

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'knowledge.agentPropose',
    principal: knowledgePrincipal,
    features: enabledFeatures,
  }).outcome, 'allow')
  const disabledKnowledge = evaluateWorkspaceCapabilityPolicy({
    action: 'knowledge.agentPropose',
    principal: knowledgePrincipal,
    features: { ...enabledFeatures, knowledge: false },
  })
  assert.equal(disabledKnowledge.outcome, 'deny')
  assert.equal(disabledKnowledge.code, 'knowledge.disabled')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'knowledge.propose',
    principal: knowledgePrincipal,
    features: enabledFeatures,
  }).outcome, 'deny')

  const billingPrincipal = { authSource: 'verified_billing_webhook' }
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'billing.webhookApply',
    principal: billingPrincipal,
    features: enabledFeatures,
  }).outcome, 'allow')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'billing.write',
    principal: billingPrincipal,
    features: enabledFeatures,
  }).outcome, 'deny')
})

test('gateway identity bootstrap uses an explicit admin scope without unbinding other gateway actions', () => {
  const gatewayAdminPrincipal = {
    authSource: 'api_token',
    role: 'admin',
    tokenScopes: ['gateway', 'admin'],
  }
  const gatewayOnlyPrincipal = {
    authSource: 'api_token',
    role: 'admin',
    tokenScopes: ['gateway'],
  }

  const session = evaluateWorkspaceCapabilityPolicy({
    action: 'sessions.get',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
  })
  assert.equal(session.outcome, 'deny')

  const adminIdentityBootstrap = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.identity',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
    bindingScoped: false,
  })
  assert.equal(adminIdentityBootstrap.outcome, 'allow')
  assert.equal(
    workspaceActionNeedsGatewayBindingVerification('channels.service.identity', gatewayAdminPrincipal),
    false,
  )

  const gatewayOnlyIdentity = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.identity',
    principal: gatewayOnlyPrincipal,
    features: enabledFeatures,
    bindingScoped: false,
  })
  assert.equal(gatewayOnlyIdentity.outcome, 'deny')
  assert.equal(gatewayOnlyIdentity.code, 'channels.binding_scope_required')
  assert.equal(
    workspaceActionNeedsGatewayBindingVerification('channels.service.identity', gatewayOnlyPrincipal),
    true,
  )

  const unscopedChannel = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.session',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
    bindingScoped: false,
  })
  assert.equal(unscopedChannel.outcome, 'deny')
  assert.equal(unscopedChannel.code, 'channels.binding_scope_required')
  assert.equal(
    workspaceActionNeedsGatewayBindingVerification('channels.service.session', gatewayAdminPrincipal),
    true,
  )

  const unscopedDelivery = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.delivery',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
    bindingScoped: false,
  })
  assert.equal(unscopedDelivery.outcome, 'deny')
  assert.equal(unscopedDelivery.code, 'channels.binding_scope_required')
  assert.equal(
    workspaceActionNeedsGatewayBindingVerification('channels.service.delivery', gatewayAdminPrincipal),
    true,
  )

  for (const action of ['channels.deliveries.read', 'channels.deliveries.write'] as const) {
    assert.equal(evaluateWorkspaceCapabilityPolicy({
      action,
      principal: gatewayAdminPrincipal,
      features: enabledFeatures,
      bindingScoped: false,
    }).outcome, 'allow', `${action}: explicit admin scope is the unbound authority`)
    assert.equal(
      workspaceActionNeedsGatewayBindingVerification(action, gatewayAdminPrincipal),
      false,
    )
    const gatewayOnly = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: gatewayOnlyPrincipal,
      features: enabledFeatures,
      bindingScoped: false,
    })
    assert.equal(gatewayOnly.outcome, 'deny', `${action}: gateway-only token stays bound`)
    assert.equal(gatewayOnly.code, 'channels.binding_scope_required')
  }

  const scopedChannel = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.session',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
    bindingScoped: true,
  })
  assert.equal(scopedChannel.outcome, 'allow')

  const mixedAdminBootstrap = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.manage.write',
    principal: gatewayAdminPrincipal,
    features: enabledFeatures,
  })
  assert.equal(mixedAdminBootstrap.outcome, 'allow')

  const disabledChannels = evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.session',
    principal: gatewayAdminPrincipal,
    features: { ...enabledFeatures, channels: false },
    bindingScoped: false,
  })
  assert.equal(disabledChannels.outcome, 'deny')
  assert.equal(disabledChannels.code, 'channels.disabled')
})

test('API token scopes intersect authoritative custom-role permissions', () => {
  const restrictedAdminToken = {
    authSource: 'api_token',
    role: 'admin',
    tokenScopes: ['admin', 'gateway'],
    customRoleKey: 'restricted-admin',
    permissions: [],
  }
  for (const action of ['billing.write', 'apiTokens.write', 'channels.manage.write'] as const) {
    const decision = evaluateWorkspaceCapabilityPolicy({
      action,
      principal: restrictedAdminToken,
      features: enabledFeatures,
    })
    assert.equal(decision.outcome, 'deny', `restricted admin token × ${action}`)
    assert.equal(decision.code, 'authorization.scope_required')
  }

  const delegatedCases = [
    ['billing.write', 'billing:manage'],
    ['apiTokens.write', 'api_tokens:manage'],
    ['channels.manage.write', 'org:manage'],
  ] as const
  for (const [action, permission] of delegatedCases) {
    const principal = {
      authSource: 'api_token',
      role: 'member',
      tokenScopes: ['admin'],
      customRoleKey: `delegated-${permission}`,
      permissions: [permission],
    }
    assert.equal(evaluateWorkspaceCapabilityPolicy({
      action,
      principal,
      features: enabledFeatures,
    }).outcome, 'allow', `delegated member token × ${action}`)

    for (const unrelatedAction of delegatedCases.map(([candidate]) => candidate).filter((candidate) => candidate !== action)) {
      assert.equal(evaluateWorkspaceCapabilityPolicy({
        action: unrelatedAction,
        principal,
        features: enabledFeatures,
      }).outcome, 'deny', `${permission} must not grant ${unrelatedAction}`)
    }
  }

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'billing.write',
    principal: {
      authSource: 'api_token',
      role: 'member',
      tokenScopes: ['desktop'],
      customRoleKey: 'billing-manager',
      permissions: ['billing:manage'],
    },
    features: enabledFeatures,
  }).outcome, 'deny', 'permission without the required service scope remains denied')

  const delegatedGateway = {
    authSource: 'api_token',
    role: 'member',
    tokenScopes: ['gateway'],
    customRoleKey: 'delegated-gateway',
    permissions: ['org:manage'],
  }
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.session',
    principal: delegatedGateway,
    features: enabledFeatures,
    bindingScoped: true,
  }).outcome, 'allow')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'channels.service.session',
    principal: { ...delegatedGateway, permissions: [] },
    features: enabledFeatures,
    bindingScoped: true,
  }).outcome, 'deny')

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'operator.diagnosticsRead',
    principal: {
      authSource: 'api_token',
      role: 'member',
      tokenScopes: ['operator'],
      customRoleKey: 'diagnostics-reader',
      permissions: ['diagnostics:view'],
    },
    features: enabledFeatures,
  }).outcome, 'allow')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'operator.diagnosticsRead',
    principal: {
      authSource: 'api_token',
      role: 'admin',
      tokenScopes: ['operator'],
      customRoleKey: 'restricted-admin',
      permissions: [],
    },
    features: enabledFeatures,
  }).outcome, 'deny')

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'operator.metricsRead',
    principal: {
      authSource: 'api_token',
      role: 'member',
      tokenScopes: ['operator'],
      customRoleKey: 'diagnostics-reader',
      permissions: ['diagnostics:view'],
    },
    features: enabledFeatures,
  }).outcome, 'deny', 'diagnostics permission must not authorize metrics')
})

test('every supported service-scope subset composes per action while gateway actions stay binding-scoped', () => {
  const serviceScopes = [
    'desktop',
    'gateway',
    'admin',
    'operator',
    'worker-internal',
  ] as const satisfies readonly WorkspaceServiceScope[]

  for (const role of ['admin', 'member'] as const) {
    const expectedByScope = role === 'admin'
      ? expectedActionsByServiceScope
      : expectedMemberActionsByServiceScope
    for (let mask = 1; mask < 2 ** serviceScopes.length; mask += 1) {
      const tokenScopes = serviceScopes.filter((_, index) => (mask & (1 << index)) !== 0)
      const expectedAllowed = new Set<WorkspaceAction>(
        tokenScopes.flatMap((scope) => expectedByScope[scope]),
      )
      for (const action of expectedActions) {
        const decision = evaluateWorkspaceCapabilityPolicy({
          action,
          principal: { authSource: 'api_token', role, tokenScopes },
          features: enabledFeatures,
          bindingScoped: true,
        })
        assert.equal(
          decision.outcome,
          expectedAllowed.has(action) ? 'allow' : 'deny',
          `${role} ${tokenScopes.join('+')} × ${action}`,
        )
      }
    }
  }
})

test('managed worker credentials and internal worker tokens do not inherit each other capabilities', () => {
  const workerCredential = { authSource: 'worker', role: 'member', tokenScopes: [] }
  const workerInternal = { authSource: 'api_token', role: 'member', tokenScopes: ['worker-internal'] }

  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'worker.heartbeat',
    principal: workerCredential,
    features: enabledFeatures,
  }).outcome, 'allow')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.schedulerTick',
    principal: workerCredential,
    features: enabledFeatures,
  }).outcome, 'deny')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'workflows.schedulerTick',
    principal: workerInternal,
    features: enabledFeatures,
  }).outcome, 'allow')
  assert.equal(evaluateWorkspaceCapabilityPolicy({
    action: 'worker.heartbeat',
    principal: workerInternal,
    features: enabledFeatures,
  }).outcome, 'deny')
})

function principalForClass(principalClass: (typeof WORKSPACE_PRINCIPAL_CLASSES)[number]) {
  switch (principalClass) {
    case 'user': return { authSource: 'user', role: 'member', tokenScopes: [] }
    case 'local': return { authSource: 'local', role: 'owner', tokenScopes: [] }
    case 'header': return { authSource: 'header', role: 'owner', tokenScopes: [] }
    case 'desktop-service': return { authSource: 'api_token', role: 'member', tokenScopes: ['desktop'] }
    case 'gateway-service': return { authSource: 'api_token', role: 'admin', tokenScopes: ['gateway'] }
    case 'admin-service': return { authSource: 'api_token', role: 'admin', tokenScopes: ['admin'] }
    case 'operator-service': return { authSource: 'api_token', role: 'admin', tokenScopes: ['operator'] }
    case 'worker-service': return { authSource: 'worker', role: 'member', tokenScopes: [] }
    case 'worker-internal-service': return { authSource: 'api_token', role: 'member', tokenScopes: ['worker-internal'] }
    case 'workflow-webhook-service': return { authSource: 'signed_workflow_webhook', role: 'member', tokenScopes: [] }
    case 'knowledge-agent-service': return { authSource: 'signed_knowledge_agent', role: 'member', tokenScopes: [] }
    case 'billing-webhook-service': return { authSource: 'verified_billing_webhook', role: 'member', tokenScopes: [] }
    case 'mixed-service': return { authSource: 'api_token', role: 'admin', tokenScopes: ['desktop', 'gateway'] }
    case 'unknown': return { authSource: 'unexpected', role: 'member', tokenScopes: [] }
  }
}
