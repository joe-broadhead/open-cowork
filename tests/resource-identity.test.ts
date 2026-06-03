import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createResourceDeepLink,
  createResourceIdentity,
  createResourceLookupResult,
  createResourceOpenAction,
  evaluateResourceAuthorityTransition,
  parseResourceDeepLink,
  parseResourceIdentity,
  resourceIdentitiesEqual,
  resolveResourceDeepLinkOpenAction,
  serializeResourceIdentity,
} from '../packages/shared/src/resource-identity.ts'
import { evaluateRemoteApprovalPolicy } from '../packages/shared/src/remote-approval-policy.ts'
import {
  authorizeSemanticUiTool,
  createSemanticUiSnapshot,
  createSemanticUiStatus,
} from '../packages/shared/src/semantic-ui.ts'

test('canonical resource identities serialize and parse exact authority-scoped resources', () => {
  const identity = createResourceIdentity({
    authority: 'desktop-local',
    kind: 'workflow-run',
    workspaceId: 'workspace:local',
    workflowId: 'workflow-123',
    runId: 'run-456',
  })

  const serialized = serializeResourceIdentity(identity)
  const parsed = parseResourceIdentity(serialized)

  assert.equal(resourceIdentitiesEqual(identity, parsed), true)
  assert.equal(serialized, 'open-cowork-resource/v1/desktop-local/workflow-run?runId=run-456&workflowId=workflow-123&workspaceId=workspace%3Alocal')
})

test('canonical resource identities reject fuzzy ids and unsupported authorities', () => {
  assert.throws(() => createResourceIdentity({
    authority: 'desktop-local',
    kind: 'session',
    workspaceId: 'workspace-1',
    sessionId: 'session-*',
  }), /exact Open Cowork resource id/)

  assert.throws(() => parseResourceIdentity('open-cowork-resource/v1/unknown/session?workspaceId=w&sessionId=s'), /Unsupported resource authority/)
  assert.throws(() => createResourceIdentity({
    authority: 'cloud-web',
    kind: 'session',
    sessionId: 'session-1',
  }), /workspaceId/)

  assert.throws(() => createResourceIdentity({
    authority: 'desktop-local',
    kind: 'artifact',
    workspaceId: 'workspace-1',
    artifactId: 'artifact-1',
  }), /sessionId/)
})

test('resource deep links carry exact serialized identities only', () => {
  const identity = createResourceIdentity({
    authority: 'cloud-web',
    kind: 'session',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  })
  const deepLink = createResourceDeepLink(identity)

  assert.equal(deepLink, 'open-cowork://resource/open-cowork-resource%2Fv1%2Fcloud-web%2Fsession%3FsessionId%3Dsession-1%26workspaceId%3Dworkspace-1')
  assert.equal(resourceIdentitiesEqual(parseResourceDeepLink(deepLink), identity), true)
  assert.throws(() => parseResourceDeepLink('open-cowork://session/session-1'), /open-cowork:\/\/resource/)
  assert.throws(() => parseResourceDeepLink(`${deepLink}?workspaceId=other`), /must not include search or hash/)
  assert.throws(() => parseResourceDeepLink('open-cowork://resource/session-1'), /Resource identity/)
})

test('resource lookup results preserve exact not-found and unavailable state', () => {
  const identity = createResourceIdentity({
    authority: 'paired-desktop',
    kind: 'capability',
    workspaceId: 'workspace-1',
    capabilityKind: 'mcp',
    capabilityId: 'github',
  })

  assert.deepEqual(createResourceLookupResult(identity, null), {
    identity,
    found: false,
    value: null,
    errorCode: 'resource-not-found',
    message: 'Resource was not found by exact identity.',
  })
  assert.equal(createResourceLookupResult(identity, { id: 'github' }).found, true)
})

test('resource open actions resolve exact deep links without fallback', () => {
  const identity = createResourceIdentity({
    authority: 'desktop-cloud',
    kind: 'workflow-run',
    workspaceId: 'workspace-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
  })
  const action = createResourceOpenAction(createResourceLookupResult(identity, { status: 'complete' }))

  assert.deepEqual(action, {
    identity,
    status: 'open',
    routeKey: 'workflow-run',
    routeParams: {
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
    },
    value: { status: 'complete' },
    errorCode: undefined,
    message: undefined,
  })

  const missing = resolveResourceDeepLinkOpenAction(
    createResourceDeepLink(identity),
    (parsed) => createResourceLookupResult(parsed, null),
  )
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.value, null)

  const unavailable = createResourceOpenAction(createResourceLookupResult(identity, null, {
    available: false,
    message: 'Cloud workspace is offline.',
  }))
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.message, 'Cloud workspace is offline.')
})

test('resource authority transitions are same-authority or explicit only', () => {
  assert.deepEqual(evaluateResourceAuthorityTransition({
    from: 'desktop-local',
    to: 'desktop-local',
  }).allowed, true)

  assert.deepEqual(evaluateResourceAuthorityTransition({
    from: 'cloud-web',
    to: 'desktop-local',
  }), {
    from: 'cloud-web',
    to: 'desktop-local',
    status: 'unsupported',
    allowed: false,
    message: 'Resource authority transition is unsupported and must not fall back to Desktop Local.',
  })

  assert.equal(evaluateResourceAuthorityTransition({
    from: 'desktop-cloud',
    to: 'cloud-web',
    supported: [['desktop-cloud', 'cloud-web']],
  }).status, 'supported')
})

test('remote approval policy fails closed without explicit local, cloud, or gateway authority', () => {
  assert.deepEqual(evaluateRemoteApprovalPolicy({
    authority: 'desktop-local',
    interaction: 'permission-approval',
    actorAuthenticated: true,
    localUserPresent: false,
  }).allowed, false)

  assert.deepEqual(evaluateRemoteApprovalPolicy({
    authority: 'paired-desktop',
    interaction: 'question-reply',
    actorAuthenticated: true,
    localUserPresent: true,
    explicitRemoteApprovalEnabled: false,
  }).reasonCode, 'paired-desktop-remote-approval-disabled')

  assert.equal(evaluateRemoteApprovalPolicy({
    authority: 'cloud-web',
    interaction: 'permission-approval',
    actorAuthenticated: true,
    actorWorkspaceMember: true,
    explicitRemoteApprovalEnabled: true,
  }).mode, 'cloud-rbac')

  assert.equal(evaluateRemoteApprovalPolicy({
    authority: 'cloud-channel-gateway',
    interaction: 'question-reject',
    actorAuthenticated: true,
    actorWorkspaceMember: true,
    explicitRemoteApprovalEnabled: true,
  }).mode, 'gateway-actor-rbac')
})

test('semantic UI tool authorization is local, tokenized, and action-gated', () => {
  const config = {
    enabled: true,
    authority: 'desktop-local' as const,
    tokenHash: 'sha256:abc',
  }

  assert.deepEqual(authorizeSemanticUiTool({
    config: { ...config, enabled: false },
    tool: 'ui_status',
    presentedTokenHash: 'sha256:abc',
  }), { allowed: false, reasonCode: 'semantic-ui-disabled' })

  assert.equal(authorizeSemanticUiTool({
    config,
    tool: 'ui_status',
    presentedTokenHash: 'sha256:wrong',
  }).reasonCode, 'semantic-ui-token-mismatch')

  assert.equal(authorizeSemanticUiTool({
    config,
    tool: 'ui_snapshot',
    presentedTokenHash: 'sha256:abc',
  }).allowed, true)

  assert.equal(authorizeSemanticUiTool({
    config,
    tool: 'ui_execute_action',
    presentedTokenHash: 'sha256:abc',
  }).reasonCode, 'semantic-ui-actions-not-implemented')

  assert.deepEqual(authorizeSemanticUiTool({
    config: { ...config, allowActions: true },
    tool: 'ui_execute_action',
    presentedTokenHash: 'sha256:abc',
  }), { allowed: true, reasonCode: 'semantic-ui-action-allowed' })
})

test('semantic UI status and snapshot redact secret-looking text', () => {
  const tokenLike = 'token-' + 'secret-value'
  const apiKeyText = 'api' + 'Key=' + 'abcdefghijklmnopqrstuvwxyz1234567890'
  const workspace = createResourceIdentity({
    authority: 'desktop-local',
    kind: 'workspace',
    workspaceId: 'workspace-1',
  })
  const status = createSemanticUiStatus({
    capturedAt: '2026-06-02T00:00:00.000Z',
    authority: 'desktop-local',
    appReady: true,
    route: workspace,
    workspace,
    activeSession: null,
    runtime: {
      ready: false,
      error: `Authorization: Bearer ${tokenLike} and /Users/alice/private`,
    },
    pending: { approvals: 1.8, questions: -1 },
  })
  const snapshot = createSemanticUiSnapshot({
    capturedAt: status.capturedAt,
    status,
    visibleSurface: 'Settings /Users/alice/private',
    items: [{
      id: 'secret-item',
      kind: 'status',
      label: apiKeyText,
    }],
  })
  const serialized = JSON.stringify(snapshot)

  assert.equal(status.pending.approvals, 1)
  assert.equal(status.pending.questions, 0)
  assert.equal(serialized.includes(tokenLike), false)
  assert.equal(serialized.includes('/Users/alice'), false)
  assert.equal(serialized.includes(apiKeyText), false)
  assert.equal(snapshot.redacted, true)
})
