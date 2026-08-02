import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WORKSPACE_ACTION_DEFINITIONS,
  type WorkspaceAction,
} from '@open-cowork/shared'
import {
  resolveCloudApiRoutePolicy,
  resolveCloudPreAuthRoutePolicy,
} from '../packages/cloud-server/src/http-routes/workspace-policy.ts'

type RouteExpectation = readonly [
  method: string,
  path: string,
  action: WorkspaceAction,
  requiresBindingScope?: true,
  requestBody?: Readonly<Record<string, unknown>>,
]

// Closed inventory of every authenticated /api route shape handled by the
// cloud server. Dynamic identifiers use one representative value; literal
// suffixes and method aliases are each listed independently so a handler change
// cannot silently inherit a broader capability.
const routes = [
  // Workspace, operator, worker, and usage surfaces.
  ['GET', '/api/config', 'workspace.read'],
  ['GET', '/api/workspace', 'workspace.read'],
  ['GET', '/api/events', 'workspace.events'],
  ['GET', '/api/metrics', 'operator.metricsRead'],
  ['GET', '/api/diagnostics', 'operator.diagnosticsRead'],
  ['GET', '/api/workers/heartbeats', 'operator.runtimeRead'],
  ['GET', '/api/runtime/status', 'operator.runtimeRead'],
  ['POST', '/api/workers/worker-1/heartbeat', 'worker.heartbeat'],
  ['GET', '/api/usage/events', 'usage.read'],
  ['GET', '/api/usage/summary', 'usage.read'],

  // Project sources, session import, and sessions.
  ['POST', '/api/project-sources/validate', 'projectSources.validate'],
  ['POST', '/api/project-sources/snapshots', 'projectSources.upload'],
  ['POST', '/api/import/sessions', 'sessions.import'],
  ['GET', '/api/sessions', 'sessions.list'],
  ['POST', '/api/sessions', 'sessions.create'],
  ['GET', '/api/sessions/session-1', 'sessions.get'],
  ['POST', '/api/sessions/session-1/activate', 'sessions.activate'],
  ['GET', '/api/sessions/session-1/view', 'sessions.view'],
  ['GET', '/api/sessions/session-1/projection-status', 'sessions.projectionRead'],
  ['POST', '/api/sessions/session-1/projection-repair', 'sessions.projectionRepair'],
  ['GET', '/api/sessions/session-1/events', 'sessions.events'],
  ['POST', '/api/sessions/session-1/prompt', 'sessions.prompt'],
  ['POST', '/api/sessions/session-1/abort', 'sessions.abort'],
  ['POST', '/api/sessions/session-1/question-reply', 'sessions.questionReply'],
  ['POST', '/api/sessions/session-1/question-reject', 'sessions.questionReject'],
  ['POST', '/api/sessions/session-1/permission-respond', 'sessions.permissionRespond'],

  // Artifact index and session-scoped artifact lifecycle.
  ['GET', '/api/artifacts', 'artifacts.index'],
  ['GET', '/api/sessions/session-1/artifacts', 'artifacts.list'],
  ['POST', '/api/sessions/session-1/artifacts', 'artifacts.upload'],
  ['GET', '/api/sessions/session-1/artifacts/artifact-1', 'artifacts.read'],
  ['POST', '/api/sessions/session-1/artifacts/artifact-1/finalize', 'artifacts.finalize'],
  ['POST', '/api/sessions/session-1/artifacts/artifact-1/status', 'artifacts.update'],

  // Workflow lifecycle and the internal scheduler callback.
  ['GET', '/api/workflows', 'workflows.list'],
  ['POST', '/api/workflows', 'workflows.create'],
  ['POST', '/api/workflows', 'workflows.createWebhook', undefined, {
    triggers: [{ id: 'webhook-1', type: 'webhook', enabled: true }],
  }],
  ['GET', '/api/workflows/workflow-1', 'workflows.get'],
  ['POST', '/api/workflows/workflow-1/run', 'workflows.run'],
  ['POST', '/api/workflows/workflow-1/rotate-webhook-secret', 'workflows.rotateWebhookSecret'],
  ['POST', '/api/workflows/workflow-1/pause', 'workflows.pause'],
  ['POST', '/api/workflows/workflow-1/resume', 'workflows.resume'],
  ['POST', '/api/workflows/workflow-1/archive', 'workflows.archive'],
  ['POST', '/api/workflows/scheduler/tick', 'workflows.schedulerTick'],

  // Human channel directory and administration.
  ['GET', '/api/channels/providers', 'channels.directory.read'],
  ['GET', '/api/channels/identities', 'channels.directory.read'],
  ['GET', '/api/channels/agents', 'channels.manage.read'],
  ['POST', '/api/channels/agents', 'channels.manage.write'],
  ['PATCH', '/api/channels/agents/agent-1', 'channels.manage.write'],
  ['GET', '/api/channels/bindings', 'channels.manage.read'],
  ['POST', '/api/channels/bindings', 'channels.manage.write'],
  ['PATCH', '/api/channels/bindings/binding-1', 'channels.manage.write'],

  // Gateway channel service routes. Every shape must retain the verified
  // channel-binding-scope precondition in addition to its action.
  ['POST', '/api/channels/identities/resolve', 'channels.service.identity', true],
  ['POST', '/api/channels/sessions/bind', 'channels.service.session', true],
  ['POST', '/api/channels/sessions/prompt', 'channels.service.session', true],
  ['GET', '/api/channels/sessions/by-thread', 'channels.service.session', true],
  ['GET', '/api/channels/sessions/binding-1/snapshot', 'channels.service.session', true],
  ['GET', '/api/channels/sessions/binding-1/events', 'channels.service.session', true],
  ['GET', '/api/channels/sessions/binding-1/artifacts/artifact-1', 'channels.service.artifact', true],
  ['POST', '/api/channels/cursor', 'channels.service.cursor', true],
  ['POST', '/api/channels/interactions', 'channels.service.interaction', true],
  ['POST', '/api/channels/interactions/resolve', 'channels.service.interaction', true],
  ['POST', '/api/channels/provider-events/claim', 'channels.service.providerEvent', true],
  ['POST', '/api/channels/provider-events/event-1/complete', 'channels.service.providerEvent', true],
  ['GET', '/api/channels/deliveries/stream', 'channels.service.delivery', true],
  ['GET', '/api/channels/deliveries', 'channels.deliveries.read', true],
  ['POST', '/api/channels/deliveries', 'channels.service.delivery', true],
  ['POST', '/api/channels/deliveries/delivery-1/ack', 'channels.service.delivery', true],
  ['POST', '/api/channels/deliveries/delivery-1/retry', 'channels.deliveries.write', true],
  ['POST', '/api/channels/deliveries/delivery-1/dead-letter', 'channels.deliveries.write', true],

  // Settings collection/key aliases and every accepted mutation verb.
  ['GET', '/api/settings', 'settings.read'],
  ['GET', '/api/settings/theme', 'settings.read'],
  ['POST', '/api/settings', 'settings.write'],
  ['PUT', '/api/settings', 'settings.write'],
  ['PATCH', '/api/settings', 'settings.write'],
  ['POST', '/api/settings/theme', 'settings.write'],
  ['PUT', '/api/settings/theme', 'settings.write'],
  ['PATCH', '/api/settings/theme', 'settings.write'],

  // Thread tags and smart filters.
  ['GET', '/api/threads', 'threads.read'],
  ['GET', '/api/threads/tags', 'threads.read'],
  ['POST', '/api/threads/tags', 'threads.write'],
  ['PATCH', '/api/threads/tags/tag-1', 'threads.write'],
  ['DELETE', '/api/threads/tags/tag-1', 'threads.write'],
  ['POST', '/api/threads/tags/tag-1/apply', 'threads.write'],
  ['POST', '/api/threads/tags/tag-1/remove', 'threads.write'],
  ['GET', '/api/threads/smart-filters', 'threads.read'],
  ['POST', '/api/threads/smart-filters', 'threads.write'],
  ['PATCH', '/api/threads/smart-filters/filter-1', 'threads.write'],
  ['DELETE', '/api/threads/smart-filters/filter-1', 'threads.write'],

  // Coordination projects, tasks, and desktop watch lifecycle.
  ['GET', '/api/coordination/board', 'coordination.read'],
  ['GET', '/api/coordination/projects', 'coordination.read'],
  ['POST', '/api/coordination/projects', 'coordination.write'],
  ['POST', '/api/coordination/projects/project-1', 'coordination.write'],
  ['POST', '/api/coordination/projects/project-1/plan-with-cleo', 'coordination.write'],
  ['GET', '/api/coordination/tasks', 'coordination.read'],
  ['POST', '/api/coordination/tasks', 'coordination.write'],
  ['POST', '/api/coordination/tasks/task-1', 'coordination.write'],
  ['GET', '/api/coordination/tasks/task-1/work-target', 'coordination.read'],
  ['POST', '/api/coordination/tasks/task-1/move', 'coordination.write'],
  ['POST', '/api/coordination/tasks/task-1/assign', 'coordination.write'],
  ['POST', '/api/coordination/tasks/task-1/link-work', 'coordination.write'],
  ['GET', '/api/coordination/watches', 'coordination.watches.read'],
  ['POST', '/api/coordination/watches', 'coordination.watches.write'],
  ['POST', '/api/coordination/watches/watch-1', 'coordination.watches.write'],
  ['DELETE', '/api/coordination/watches/watch-1', 'coordination.watches.write'],
  ['POST', '/api/coordination/watches/watch-1/pause', 'coordination.watches.write'],
  ['POST', '/api/coordination/watches/watch-1/resume', 'coordination.watches.write'],

  // Knowledge, launchpad, and capability discovery.
  ['GET', '/api/knowledge', 'knowledge.read'],
  ['POST', '/api/knowledge/spaces', 'knowledge.adminWrite'],
  ['POST', '/api/knowledge/proposals', 'knowledge.propose'],
  ['POST', '/api/knowledge/proposals/proposal-1/accept', 'knowledge.adminWrite'],
  ['POST', '/api/knowledge/proposals/proposal-1/decline', 'knowledge.adminWrite'],
  ['GET', '/api/knowledge/pages/page-1/history', 'knowledge.read'],
  ['POST', '/api/knowledge/pages/page-1/restore', 'knowledge.adminWrite'],
  ['GET', '/api/launchpad/feed', 'launchpad.read'],
  ['GET', '/api/capabilities', 'capabilities.read'],
  ['GET', '/api/capabilities/tools', 'capabilities.read'],
  ['GET', '/api/capabilities/tools/tool-1', 'capabilities.read'],
  ['GET', '/api/capabilities/skills', 'capabilities.read'],
  ['GET', '/api/capabilities/skills/skill-1', 'capabilities.read'],
  ['GET', '/api/capabilities/skills/skill-1/bundle', 'capabilities.read'],

  // Billing, BYOK, workspace policy, and API token lifecycle.
  ['GET', '/api/billing/subscription', 'billing.read'],
  ['GET', '/api/billing/entitlements', 'billing.read'],
  ['POST', '/api/billing/checkout', 'billing.write'],
  ['POST', '/api/billing/portal', 'billing.write'],
  ['GET', '/api/byok', 'byok.read'],
  ['GET', '/api/byok/openai', 'byok.read'],
  ['POST', '/api/byok/openai', 'byok.write'],
  ['DELETE', '/api/byok/openai', 'byok.write'],
  ['POST', '/api/byok/openai/validate', 'byok.write'],
  ['POST', '/api/byok/openai/override', 'byok.write'],
  ['GET', '/api/policy', 'policy.read'],
  ['POST', '/api/policy', 'policy.write'],
  ['PUT', '/api/policy', 'policy.write'],
  ['GET', '/api/policy/effective', 'policy.effectiveRead'],
  ['GET', '/api/api-tokens', 'apiTokens.read'],
  ['POST', '/api/api-tokens', 'apiTokens.write'],
  ['DELETE', '/api/api-tokens/token-1', 'apiTokens.write'],
  ['POST', '/api/api-tokens/token-1/channel-bindings', 'apiTokens.write'],

  // Organization administration and audit.
  ['GET', '/api/admin', 'admin.read'],
  ['GET', '/api/admin/policy', 'admin.read'],
  ['GET', '/api/admin/access', 'admin.read'],
  ['GET', '/api/admin/permission-catalog', 'admin.read'],
  ['GET', '/api/admin/audit', 'admin.audit.read'],
  ['GET', '/api/admin/audit/export', 'admin.audit.read'],
  ['GET', '/api/admin/roles', 'admin.roles.read'],
  ['POST', '/api/admin/roles', 'admin.roles.write'],
  ['POST', '/api/admin/roles/role-1/update', 'admin.roles.write'],
  ['DELETE', '/api/admin/roles/role-1', 'admin.roles.write'],
  ['GET', '/api/admin/members', 'admin.members.read'],
  ['POST', '/api/admin/members', 'admin.members.write'],
  ['POST', '/api/admin/members/member-1/update', 'admin.members.write'],
  ['POST', '/api/admin/members/member-1/role', 'admin.members.write'],
  ['GET', '/api/admin/sso', 'admin.sso.read'],
  ['POST', '/api/admin/sso', 'admin.sso.write'],
  ['DELETE', '/api/admin/sso', 'admin.sso.write'],
  ['POST', '/api/admin/sso/scim-token', 'admin.sso.write'],
  ['GET', '/api/admin/worker-pools', 'admin.workers.read'],
  ['POST', '/api/admin/worker-pools', 'admin.workers.write'],
  ['POST', '/api/admin/worker-pools/pool-1/update', 'admin.workers.write'],
  ['GET', '/api/admin/workers', 'admin.workers.read'],
  ['POST', '/api/admin/workers', 'admin.workers.write'],
  ['GET', '/api/admin/workers/worker-1', 'admin.workers.read'],
  ['POST', '/api/admin/workers/worker-1/activate', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/pause', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/resume', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/drain', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/retire', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/revoke', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/unhealthy', 'admin.workers.write'],
  ['GET', '/api/admin/workers/worker-1/credentials', 'admin.workers.read'],
  ['POST', '/api/admin/workers/worker-1/credentials', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/credentials/credential-1/rotate', 'admin.workers.write'],
  ['POST', '/api/admin/workers/worker-1/credentials/credential-1/revoke', 'admin.workers.write'],
  ['GET', '/api/admin/workers/worker-1/heartbeats', 'admin.workers.read'],
] as const satisfies readonly RouteExpectation[]

const preAuthWorkspaceRoutes = [
  ['POST', '/webhooks/workflows/workflow-1', 'workflows.webhookInvoke'],
  ['POST', '/webhooks/billing', 'billing.webhookApply'],
  ['POST', '/api/knowledge/agent/propose', 'knowledge.agentPropose'],
] as const satisfies readonly (readonly [string, string, WorkspaceAction])[]

test('every live cloud HTTP route shape has an exact workspace policy classification', () => {
  const classified = new Set<WorkspaceAction>()
  const routeKeys = new Set<string>()

  for (const [method, path, expectedAction, requiresBindingScope, requestBody] of routes) {
    const key = `${method} ${path}${requestBody ? ` [${expectedAction}]` : ''}`
    assert.equal(routeKeys.has(key), false, `duplicate route inventory entry: ${key}`)
    routeKeys.add(key)

    assert.deepEqual(
      resolveCloudApiRoutePolicy(method, segments(path), requestBody),
      requiresBindingScope
        ? { action: expectedAction, requiresBindingScope: true }
        : { action: expectedAction },
      key,
    )
    classified.add(expectedAction)
  }
  for (const [method, path, expectedAction] of preAuthWorkspaceRoutes) {
    assert.deepEqual(resolveCloudPreAuthRoutePolicy(method, segments(path)), {
      kind: 'workspace',
      route: { action: expectedAction },
    })
    classified.add(expectedAction)
  }

  assert.deepEqual(
    [...classified].sort(),
    Object.keys(WORKSPACE_ACTION_DEFINITIONS).sort(),
    'every action in the pure capability matrix must be reachable through a deliberately classified route',
  )
})

test('pre-auth inventory explicitly classifies identity bootstrap and signed provider ingress', () => {
  assert.deepEqual(resolveCloudPreAuthRoutePolicy('POST', segments('/api/invites/accept')), {
    kind: 'identity-bootstrap',
    surface: 'invite-accept',
  })
  assert.deepEqual(resolveCloudPreAuthRoutePolicy('POST', segments('/scim/v2/Users')), {
    kind: 'identity-bootstrap',
    surface: 'scim',
  })
  assert.deepEqual(resolveCloudPreAuthRoutePolicy('POST', segments('/webhooks/billing')), {
    kind: 'workspace',
    route: { action: 'billing.webhookApply' },
  })
  for (const [method, path] of [
    ['GET', '/webhooks/workflows/workflow-1'],
    ['POST', '/webhooks/workflows/workflow-1/extra'],
    ['GET', '/api/knowledge/agent/propose'],
    ['POST', '/api/knowledge/agent/propose/extra'],
    ['GET', '/api/invites/accept'],
    ['GET', '/webhooks/billing'],
    ['POST', '/webhooks/billing/extra'],
    ['POST', '/api/future-bootstrap'],
  ] as const) {
    assert.equal(resolveCloudPreAuthRoutePolicy(method, segments(path)), null, `${method} ${path}`)
  }
})

test('live paths reject every unregistered HTTP method', () => {
  const registered = new Set(routes.map(([method, path]) => `${method} ${path}`))
  for (const [, path] of routes) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const key = `${method} ${path}`
      if (registered.has(key)) continue
      assert.equal(resolveCloudApiRoutePolicy(method, segments(path)), null, key)
    }
  }
})

test('near-miss suffixes and unknown aliases stay closed', () => {
  for (const [method, path] of [
    ['GET', '/workspace'],
    ['GET', '/api'],
    ['GET', '/api/config/alias'],
    ['GET', '/api/workspace/alias'],
    ['GET', '/api/events/stream'],
    ['GET', '/api/metrics/prometheus'],
    ['GET', '/api/diagnostics/report'],
    ['GET', '/api/workers/heartbeats/extra'],
    ['POST', '/api/workers/worker-1/heartbeat/extra'],
    ['GET', '/api/usage/future'],
    ['POST', '/api/project-sources/snapshots/extra'],
    ['POST', '/api/import/sessions/extra'],
    ['GET', '/api/sessions/session-1/events/extra'],
    ['POST', '/api/sessions/session-1/prompt/extra'],
    ['GET', '/api/sessions/session-1/artifacts/artifact-1/unknown'],
    ['POST', '/api/sessions/session-1/artifacts/artifact-1/finalize/extra'],
    ['POST', '/api/workflows/scheduler/tick/extra'],
    ['POST', '/api/workflows/workflow-1/future-action'],
    ['GET', '/api/artifacts/artifact-1'],
    ['GET', '/api/channels/providers/extra'],
    ['POST', '/api/channels/identities/resolve/extra'],
    ['GET', '/api/channels/sessions/binding-1/snapshot/extra'],
    ['GET', '/api/channels/sessions/binding-1/artifacts'],
    ['GET', '/api/channels/sessions/binding-1/artifacts/artifact-1/extra'],
    ['POST', '/api/channels/deliveries/delivery-1/future-action'],
    ['GET', '/api/settings/theme/extra'],
    ['GET', '/api/threads/future-collection'],
    ['POST', '/api/threads/tags/tag-1/apply/extra'],
    ['GET', '/api/coordination/board/extra'],
    ['POST', '/api/coordination/tasks/task-1/move/extra'],
    ['POST', '/api/coordination/watches/watch-1/future-action'],
    ['POST', '/api/knowledge/spaces/extra'],
    ['GET', '/api/knowledge/pages/page-1/history/extra'],
    ['GET', '/api/launchpad/feed/extra'],
    ['GET', '/api/capabilities/future-collection'],
    ['GET', '/api/capabilities/tools/tool-1/extra'],
    ['GET', '/api/capabilities/skills/skill-1/bundle/extra'],
    ['GET', '/api/billing/subscription/extra'],
    ['POST', '/api/byok/openai/validate/extra'],
    ['GET', '/api/policy/effective/extra'],
    ['POST', '/api/api-tokens/token-1/channel-bindings/extra'],
    ['GET', '/api/admin/audit/export/extra'],
    ['POST', '/api/admin/roles/role-1/update/extra'],
    ['POST', '/api/admin/workers/worker-1/credentials/credential-1/rotate/extra'],
    ['GET', '/api/future-resource'],
  ] as const) {
    assert.equal(resolveCloudApiRoutePolicy(method, segments(path)), null, `${method} ${path}`)
  }
})

function segments(path: string) {
  return new URL(path, 'https://cloud.example.test').pathname.split('/').filter(Boolean)
}
