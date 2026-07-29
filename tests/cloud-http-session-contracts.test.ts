import test from 'node:test'
import assert from 'node:assert/strict'
import { browserRendererBuildExists } from '@open-cowork/cloud-server/browser-renderer-app'
import { type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createFixture, processOneSessionCommand } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  headerValue,
  policyWithRemoteApprovalResponses,
  testAbuseConfig,
} from './helpers/cloud-http-test-support.ts'

function sessionImportPayload(artifacts: unknown[]) {
  return {
    source: {
      kind: 'local-session',
      fingerprint: 'sha256:artifact-validation',
      title: 'Artifact validation',
    },
    title: 'Artifact validation',
    selection: {
      includeMessages: false,
      includeArtifacts: true,
      includeAttachments: false,
      includeProjectSource: false,
    },
    itemCounts: {
      messages: 0,
      artifacts: artifacts.length,
      attachments: 0,
      projectSource: 0,
      excluded: 0,
    },
    artifacts,
  }
}

test('cloud HTTP server exposes liveness, config, session create/list/get, prompt, and abort', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const liveness = await readJson(await fetch(`${baseUrl}/livez`))
    assert.equal(liveness.ok, true)
    assert.equal(liveness.role, 'all-in-one')

    // GET / serves the UNIFIED RENDERER SPA (the one-UI-codebase cutover; the
    // bespoke website is gone), not a server-rendered website shell. This needs
    // the browser renderer build present; CI builds it before the suite (the
    // cloud-surface gate). When it's absent locally, GET / returns 404 — assert
    // the markers only when the build exists, mirroring the /app test below.
    if (browserRendererBuildExists()) {
      const htmlResponse = await fetch(`${baseUrl}/`)
      assert.equal(htmlResponse.status, 200)
      assert.match(htmlResponse.headers.get('content-type') || '', /text\/html/)
      const html = await htmlResponse.text()
      // Renderer markers: hashed assets mounted under /app/assets and the
      // bootstrap blob injected into <script id="cowork-bootstrap">.
      assert.match(html, /\/app\/assets\//)
      assert.match(html, /id="cowork-bootstrap"/)
    }

    const config = await readJson(await fetch(`${baseUrl}/api/config`))
    assert.equal(config.profileName, 'full')
    assert.equal(config.features.chat, true)
    assert.equal(asRecord(config.publicBranding).productName, 'Open Cowork Cloud')
    // The org-managed policy (#898) rides the config path; with none set it is the
    // unrestricted default view carrying an empty disabledByPolicy map.
    const managedPolicy = asRecord(config.managedPolicy)
    assert.equal(asRecord(managedPolicy.permissionCeilings).bash, 'allow')
    assert.deepEqual(managedPolicy.disabledByPolicy, {})

    const runtimeStatus = await readJson(await fetch(`${baseUrl}/api/runtime/status`))
    assert.equal(runtimeStatus.role, 'all-in-one')
    assert.equal(runtimeStatus.canExecute, true)
    assert.equal(runtimeStatus.commandProcessing, 'inline')

    const workspace = await readJson(await fetch(`${baseUrl}/api/workspace`))
    assert.equal(workspace.tenantId, 'tenant-1')
    assert.equal(workspace.userId, 'user-1')
    assert.equal(workspace.orgId, 'tenant-1')
    assert.equal(asRecord(workspace.policy).localFiles, 'disabled')

    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createdResponse.status, 201)
    const created = await readJson(createdResponse)
    assert.equal(asRecord(created.session).sessionId, 'oc-session-1')
    assert.equal(asArray(asRecord(asRecord(created.projection).view).messages).length, 0)

    const listed = await readJson(await fetch(`${baseUrl}/api/sessions`))
    assert.equal(asArray(listed.sessions).length, 1)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello cloud', agent: 'data-analyst' }),
    })
    assert.equal(promptResponse.status, 202)
    const prompt = await readJson(promptResponse)
    assert.equal(asRecord(prompt.command).status, 'pending')
    assert.equal(prompt.processed, 1)
    assert.equal(asRecord(prompt.projectionFence).scope, 'session')
    assert.equal(asRecord(prompt.projectionFence).tenantId, 'tenant-1')
    assert.equal(asRecord(prompt.projectionFence).sessionId, 'oc-session-1')
    assert.equal(asRecord(prompt.projectionFence).commandId, asRecord(prompt.command).commandId)
    assert.equal(fixture.runtime.prompts[0]?.agent, 'data-analyst')
    const promptMessages = asArray(asRecord(asRecord(asRecord(prompt.view).projection).view).messages)
    assert.equal(promptMessages.length, 2)
    assert.equal(asRecord(promptMessages[1]).content, 'echo: hello cloud')

    const session = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1`))
    const sessionView = asRecord(asRecord(session.projection).view)
    assert.equal(sessionView.isGenerating, false)
    assert.equal(asRecord(asArray(sessionView.messages)[0]).content, 'hello cloud')

    const sharedViewResponse = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/view`))
    const sharedView = asRecord(sharedViewResponse.view)
    assert.equal(asArray(sharedView.messages).length, 2)
    assert.equal(asRecord(asArray(sharedView.messages)[0]).content, 'hello cloud')
    assert.equal(sharedView.isGenerating, false)

    const abortResponse = await fetch(`${baseUrl}/api/sessions/oc-session-1/abort`, { method: 'POST' })
    assert.equal(abortResponse.status, 202)
    const abort = await readJson(abortResponse)
    assert.equal(abort.processed, 1)
    assert.equal(asRecord(abort.projectionFence).commandId, asRecord(abort.command).commandId)
    assert.equal(asRecord(abort.projectionFence).sequence, asRecord(asRecord(abort.view).projection).sequence)
    assert.deepEqual(fixture.runtime.aborted, ['oc-session-1'])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP policy routes get/set the org managed policy and deliver it to the effective view', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    // Bootstrap the org via the config path, then read the (empty) admin policy.
    await readJson(await fetch(`${baseUrl}/api/config`))
    const initial = await readJson(await fetch(`${baseUrl}/api/policy`))
    assert.equal(initial.policy, null)
    assert.deepEqual(asRecord(initial.view).disabledByPolicy, {})

    // Set a tightening policy (PUT), then confirm the record + transparency view.
    const setResponse = await fetch(`${baseUrl}/api/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        permissionCeilings: { bash: 'deny', web: 'ask' },
        allowedProviders: ['openai'],
        extensions: { customMcps: false },
        keyManagement: 'byok_required',
      }),
    })
    assert.equal(setResponse.status, 200)
    const set = await readJson(setResponse)
    assert.equal(asRecord(asRecord(set.policy).permissionCeilings).bash, 'deny')
    assert.equal(asRecord(asRecord(set.view).disabledByPolicy).bash?.disabledByPolicy, true)

    // The effective view (config path + explicit effective route) reflects the policy.
    const effective = await readJson(await fetch(`${baseUrl}/api/policy/effective`))
    assert.equal(asRecord(asRecord(effective.policy).permissionCeilings).bash, 'deny')
    const config = await readJson(await fetch(`${baseUrl}/api/config`))
    assert.equal(asRecord(asRecord(config.managedPolicy).permissionCeilings).bash, 'deny')
    assert.deepEqual(asRecord(config.managedPolicy).allowedProviders, ['openai'])

    // A malformed update is rejected with 400.
    const badResponse = await fetch(`${baseUrl}/api/policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedProviders: 'not-an-array' }),
    })
    assert.equal(badResponse.status, 400)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP command projection fences require the submitted command event', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const originalProcessSessionCommands = fixture.worker.processSessionCommands.bind(fixture.worker)
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    fixture.worker.processSessionCommands = async () => 0
    const oldPromptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'older queued command' }),
    })
    assert.equal(oldPromptResponse.status, 202)
    const oldPrompt = await readJson(oldPromptResponse)
    assert.equal(oldPrompt.processed, 0)
    assert.equal(oldPrompt.projectionFence, null)

    fixture.worker.processSessionCommands = async (tenantId, targetSessionId) => {
      return processOneSessionCommand(fixture, tenantId, targetSessionId)
    }
    const newPromptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'new command still pending' }),
    })
    assert.equal(newPromptResponse.status, 202)
    const newPrompt = await readJson(newPromptResponse)
    assert.equal(newPrompt.processed, 1)
    assert.equal(newPrompt.projectionFence, null)
    assert.notEqual(asRecord(oldPrompt.command).commandId, asRecord(newPrompt.command).commandId)

    const projectedMessages = asArray(asRecord(asRecord(asRecord(newPrompt.view).projection).view).messages)
    assert.equal(projectedMessages.some((message) => asRecord(message).content === 'older queued command'), true)
    assert.equal(projectedMessages.some((message) => asRecord(message).content === 'new command still pending'), false)
    assert.deepEqual(fixture.runtime.prompts.map((prompt) => (prompt.parts[0] as { text?: string } | undefined)?.text), ['older queued command'])
  } finally {
    fixture.worker.processSessionCommands = originalProcessSessionCommands
    await fixture.server.close()
  }
})

test('cloud HTTP direct question and approval responses fail closed unless the profile opts in', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const denied = await fetch(`${baseUrl}/api/sessions/${sessionId}/permission-respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionId: 'permission-1', response: { allowed: true } }),
    })
    assert.equal(denied.status, 403)
    const body = await readJson(denied)
    assert.equal(asRecord(body.verdict).policyCode, 'cloud-remote-approval-disabled')

    assert.equal(await fixture.worker.processAllSessionCommands(), 0)
    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const deniedAudit = auditEvents.find((event) => event.eventType === 'cloud_interaction.remote_policy.denied')
    assert.ok(deniedAudit)
    assert.equal(asRecord(deniedAudit.metadata).policyReasonCode, 'cloud-remote-approval-disabled')
    assert.equal(asRecord(deniedAudit.metadata).interaction, 'permission-approval')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP direct question responses require explicit remote approval opt-in', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    policy: policyWithRemoteApprovalResponses(),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const allowed = await fetch(`${baseUrl}/api/sessions/${sessionId}/question-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'question-1', answers: [{ value: 'yes' }] }),
    })
    assert.equal(allowed.status, 202)
    const body = await readJson(allowed)
    assert.equal(asRecord(body.command).kind, 'question.reply')

    assert.equal(await fixture.worker.processAllSessionCommands(), 1)
    assert.deepEqual(fixture.runtime.questionReplies, [{
      requestId: 'question-1',
      answers: [{ value: 'yes' }],
    }])
    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const allowedAudit = auditEvents.find((event) => event.eventType === 'cloud_interaction.question.replied')
    assert.ok(allowedAudit)
    assert.equal(asRecord(allowedAudit.metadata).policyReasonCode, 'cloud-rbac-workspace-membership-required')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP channel approval responses fail closed unless the profile opts in', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }
  try {
    const agentResponse = await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-1',
        name: 'Gateway agent',
      }),
    })
    assert.equal(agentResponse.status, 201)

    const bindingResponse = await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'telegram-binding',
        agentId: 'agent-1',
        provider: 'telegram',
        displayName: 'Telegram',
        externalWorkspaceId: 'bot-1',
        credentialRef: 'secret/telegram',
      }),
    })
    assert.equal(bindingResponse.status, 201)
    const channelBinding = asRecord((await readJson(bindingResponse)).binding)

    const identityResponse = await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-1',
        externalUserId: 'tg-user-1',
        accountId: 'user-1',
        role: 'member',
        status: 'active',
      }),
    })
    assert.equal(identityResponse.status, 200)
    const identity = asRecord((await readJson(identityResponse)).identity)

    const bindResponse = await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: channelBinding.bindingId,
        provider: 'telegram',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-1',
        title: 'Telegram thread',
      }),
    })
    assert.equal(bindResponse.status, 200)
    const bound = await readJson(bindResponse)
    const cloudSession = asRecord(asRecord(bound.session).session)

    const interactionResponse = await fetch(`${baseUrl}/api/channels/interactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interactionId: 'interaction-policy-denied',
        agentId: 'agent-1',
        sessionId: cloudSession.sessionId,
        provider: 'telegram',
        kind: 'permission',
        targetId: 'permission-1',
        tokenSecret: 'test-secret',
      }),
    })
    assert.equal(interactionResponse.status, 201)
    const issuedInteraction = await readJson(interactionResponse)

    const denied = await fetch(`${baseUrl}/api/channels/interactions/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        token: issuedInteraction.plaintextToken,
        response: { allowed: true },
      }),
    })
    assert.equal(denied.status, 403)
    const body = await readJson(denied)
    assert.equal(asRecord(body.verdict).policyCode, 'gateway-remote-approval-disabled')

    assert.equal(await fixture.worker.processAllSessionCommands(), 0)
    assert.deepEqual(fixture.runtime.permissions, [])
    const pending = await fixture.store.findChannelInteraction({
      orgId: 'tenant-1',
      token: String(issuedInteraction.plaintextToken),
      provider: 'telegram',
    })
    assert.equal(pending?.status, 'pending')

    const auditEvents = await fixture.store.listAuditEvents('tenant-1')
    const deniedAudit = auditEvents.find((event) => event.eventType === 'channel_interaction.remote_policy.denied')
    assert.ok(deniedAudit)
    assert.equal(deniedAudit.targetType, 'channel_interaction')
    assert.equal(deniedAudit.targetId, 'interaction-policy-denied')
    assert.equal(asRecord(deniedAudit.metadata).policyReasonCode, 'gateway-remote-approval-disabled')
    assert.equal(asRecord(deniedAudit.metadata).interaction, 'permission-approval')
    assert.equal(asRecord(deniedAudit.metadata).authority, 'cloud-channel-gateway')
    assert.equal(asRecord(deniedAudit.metadata).actorWorkspaceMember, true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server paginates session lists with scoped cursors and filters', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const createdSessionIds: string[] = []
    for (const [index, profileName] of ['default', 'data-analyst', 'default', 'default', 'default'].entries()) {
      const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileName }),
      }))
      const sessionId = String(asRecord(created.session).sessionId)
      createdSessionIds.push(sessionId)
      fixture.store.updateSessionStatus({
        tenantId: 'tenant-1',
        sessionId,
        status: index === 2 ? 'closed' : 'idle',
        title: index === 1 ? 'Revenue model' : `Cursor contract ${index + 1}`,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    }

    const firstResponse = await fetch(`${baseUrl}/api/sessions?limit=2`)
    assert.equal(firstResponse.status, 200)
    const first = await readJson(firstResponse)
    const firstItems = asArray(first.sessions).map((session) => String(asRecord(session).sessionId))
    assert.deepEqual(firstItems, [createdSessionIds[0], createdSessionIds[1]])
    // totalEstimate is a bounded has-more probe (limit + 1), not the true count (#915).
    assert.equal(first.totalEstimate, 3)
    assert.equal(typeof first.nextCursor, 'string')

    const secondResponse = await fetch(`${baseUrl}/api/sessions?limit=2&cursor=${encodeURIComponent(String(first.nextCursor))}`)
    assert.equal(secondResponse.status, 200)
    const second = await readJson(secondResponse)
    const secondItems = asArray(second.sessions).map((session) => String(asRecord(session).sessionId))
    assert.deepEqual(secondItems, [createdSessionIds[2], createdSessionIds[3]])
    assert.equal(new Set([...firstItems, ...secondItems]).size, 4)

    const statusFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?status=closed`))
    assert.deepEqual(asArray(statusFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[2]])

    const profileFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?profileName=data-analyst`))
    assert.deepEqual(asArray(profileFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const qFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?q=revenue`))
    assert.deepEqual(asArray(qFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const queryFiltered = await readJson(await fetch(`${baseUrl}/api/sessions?query=revenue`))
    assert.deepEqual(asArray(queryFiltered.sessions).map((session) => String(asRecord(session).sessionId)), [createdSessionIds[1]])

    const malformedCursor = await fetch(`${baseUrl}/api/sessions?cursor=not-a-valid-cursor`)
    assert.equal(malformedCursor.status, 400)
    assert.match(String((await readJson(malformedCursor)).error), /cursor/i)

    const mismatchedFilterCursor = await fetch(`${baseUrl}/api/sessions?status=closed&cursor=${encodeURIComponent(String(first.nextCursor))}`)
    assert.equal(mismatchedFilterCursor.status, 400)
    assert.match(String((await readJson(mismatchedFilterCursor)).error), /cursor/i)

    const unsupportedStatus = await fetch(`${baseUrl}/api/sessions?status=deleted`)
    assert.equal(unsupportedStatus.status, 400)
    assert.match(String((await readJson(unsupportedStatus)).error), /status/i)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session list cursors are scoped to the authenticated tenant', async () => {
  const tenant1Principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner1@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const tenant2Principal = {
    tenantId: 'tenant-2',
    tenantName: 'Tenant 2',
    orgId: 'tenant-2',
    userId: 'owner-2',
    accountId: 'owner-2',
    email: 'owner2@example.test',
    role: 'owner' as const,
    authSource: 'user' as const,
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-tenant']) === 'tenant-2' ? tenant2Principal : tenant1Principal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.service.ensurePrincipal(tenant1Principal)
    await fixture.service.ensurePrincipal(tenant2Principal)
    for (let index = 0; index < 3; index += 1) {
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    }
    const first = await readJson(await fetch(`${baseUrl}/api/sessions?limit=1`))
    assert.equal(typeof first.nextCursor, 'string')

    const tenantTwoList = await readJson(await fetch(`${baseUrl}/api/sessions`, { headers: { 'x-test-tenant': 'tenant-2' } }))
    assert.deepEqual(asArray(tenantTwoList.sessions), [])

    const tenantTwoCursor = await fetch(`${baseUrl}/api/sessions?cursor=${encodeURIComponent(String(first.nextCursor))}`, {
      headers: { 'x-test-tenant': 'tenant-2' },
    })
    assert.equal(tenantTwoCursor.status, 400)
    assert.match(String((await readJson(tenantTwoCursor)).error), /cursor/i)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server imports a redacted local session snapshot and audits the copy', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const importResponse = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'local-session',
          fingerprint: 'sha256:source-session-redacted',
          title: 'Local import',
        },
        title: 'Local import',
        selection: {
          includeMessages: true,
          includeArtifacts: true,
          includeAttachments: false,
          includeProjectSource: false,
        },
        itemCounts: {
          messages: 2,
          artifacts: 1,
          attachments: 0,
          projectSource: 0,
          excluded: 3,
        },
        messages: [{
          id: 'local-user-1',
          role: 'user',
          content: 'Summarize the redacted project.',
          timestamp: '2026-05-28T10:00:00.000Z',
          order: 1,
        }, {
          id: 'local-assistant-1',
          role: 'assistant',
          content: 'Summary complete.',
          timestamp: '2026-05-28T10:00:01.000Z',
          order: 2,
        }],
        artifacts: [{
          id: 'local-artifact-1',
          filename: 'summary.txt',
          contentType: 'text/plain',
          dataBase64: Buffer.from('artifact body').toString('base64'),
          order: 3,
          kind: 'document',
          status: 'in-review',
          authorAgentId: 'agent-writer',
          projectId: 'project-1',
          taskId: 'task-1',
          statusUpdatedBy: 'reviewer-1',
          statusUpdatedAt: '2026-05-28T10:00:02.000Z',
        }],
        warnings: [{
          code: 'redacted-local-data',
          message: 'Some local paths or secret-like text will be redacted before cloud import.',
          severity: 'warning',
        }],
        excluded: [{
          kind: 'secrets',
          count: 1,
          reason: 'Secrets stay local.',
        }],
      }),
    })
    assert.equal(importResponse.status, 201)
    const imported = await readJson(importResponse)
    const session = asRecord(imported.session)
    const sessionId = String(session.sessionId)
    assert.equal(fixture.runtime.createdSessions.length, 0, 'import should not create an OpenCode runtime session')
    const projection = asRecord(asRecord(imported.projection).view)
    assert.equal(asRecord(projection.origin).sourceFingerprint, 'sha256:source-session-redacted')
    assert.equal(asArray(projection.messages).length, 2)
    assert.equal(asRecord(asArray(projection.messages)[0]).content, 'Summarize the redacted project.')
    assert.equal(asArray(projection.artifacts).length, 1)
    const projectedArtifact = asRecord(asArray(projection.artifacts)[0])
    assert.equal(projectedArtifact.kind, 'document')
    assert.equal(projectedArtifact.status, 'in-review')
    assert.equal(projectedArtifact.authorAgentId, 'agent-writer')
    assert.equal(projectedArtifact.projectId, 'project-1')
    assert.equal(projectedArtifact.taskId, 'task-1')
    assert.equal(projectedArtifact.statusUpdatedBy, 'reviewer-1')
    assert.equal(projectedArtifact.statusUpdatedAt, '2026-05-28T10:00:02.000Z')

    const artifacts = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(artifacts.artifacts).length, 1)
    const listedArtifact = asRecord(asArray(artifacts.artifacts)[0])
    assert.equal(listedArtifact.status, 'in-review')
    assert.equal(listedArtifact.projectId, 'project-1')
    assert.equal(listedArtifact.taskId, 'task-1')
    assert.equal(listedArtifact.statusUpdatedAt, '2026-05-28T10:00:02.000Z')
    assert.equal('key' in listedArtifact, false)

    const promptResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'continue in cloud' }),
    })
    assert.equal(promptResponse.status, 202)
    assert.equal(fixture.runtime.createdSessions.length, 1)
    const prompted = await readJson(promptResponse)
    assert.equal(asArray(asRecord(asRecord(asRecord(prompted.view).projection).view).messages).length, 4)

    const audit = await fixture.store.listAuditEvents('tenant-1')
    const completed = audit.find((event) => event.eventType === 'session_import.completed')
    assert.ok(completed)
    assert.equal(completed.targetId, sessionId)
    assert.equal(asRecord(completed.metadata).sourceFingerprint, 'sha256:source-session-redacted')
    assert.equal(JSON.stringify(audit).includes('/Users/'), false)
    assert.equal(JSON.stringify(audit).includes('sk-'), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session import rejects more than 25 artifacts before mutating state', async () => {
  const fixture = createFixture()
  const originalPutObject = fixture.objectStore.putObject.bind(fixture.objectStore)
  let artifactWrites = 0
  fixture.objectStore.putObject = async (input) => {
    artifactWrites += 1
    return originalPutObject(input)
  }
  const baseUrl = await fixture.server.listen()
  try {
    const artifacts = Array.from({ length: 26 }, (_, index) => ({
      id: `artifact-${index + 1}`,
      filename: `artifact-${index + 1}.txt`,
      dataBase64: Buffer.from(`artifact ${index + 1}`).toString('base64'),
      order: index + 1,
    }))
    const response = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionImportPayload(artifacts)),
    })

    assert.equal(response.status, 400)
    assert.match(String((await readJson(response)).error), /no more than 25 artifacts/i)
    assert.equal(asArray((await readJson(await fetch(`${baseUrl}/api/sessions`))).sessions).length, 0)
    assert.equal(artifactWrites, 0)
    assert.equal((await fixture.store.listAuditEvents('tenant-1')).some((event) => event.eventType.startsWith('session_import.')), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session import validates every artifact before mutating state', async () => {
  const fixture = createFixture()
  const originalPutObject = fixture.objectStore.putObject.bind(fixture.objectStore)
  let artifactWrites = 0
  fixture.objectStore.putObject = async (input) => {
    artifactWrites += 1
    return originalPutObject(input)
  }
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionImportPayload([{
        id: 'valid-artifact',
        filename: 'valid.txt',
        dataBase64: Buffer.from('valid').toString('base64'),
        order: 1,
      }, null])),
    })

    assert.equal(response.status, 400)
    assert.match(String((await readJson(response)).error), /artifact 2.*object/i)
    assert.equal(asArray((await readJson(await fetch(`${baseUrl}/api/sessions`))).sessions).length, 0)
    assert.equal(artifactWrites, 0)
    assert.equal((await fixture.store.listAuditEvents('tenant-1')).some((event) => event.eventType.startsWith('session_import.')), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP session import rejects local paths before projection or audit persistence', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/import/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'local-session',
          fingerprint: 'sha256:unsafe',
          title: 'Unsafe import',
        },
        title: 'Unsafe import',
        selection: { includeMessages: true },
        itemCounts: {
          messages: 1,
          artifacts: 0,
          attachments: 0,
          projectSource: 0,
          excluded: 0,
        },
        messages: [{
          id: 'msg-1',
          role: 'user',
          content: 'Read /Users/alice/private-project/.env',
          order: 1,
        }],
      }),
    })
    assert.equal(response.status, 400)
    const body = await readJson(response)
    assert.match(String(body.error), /local paths|secret-like/)
    assert.equal((await fixture.store.listAuditEvents('tenant-1')).some((event) => event.eventType.startsWith('session_import.')), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server enforces prompt quotas before processing commands and exposes usage events', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxPromptsPerHour: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const firstPrompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    })
    assert.equal(firstPrompt.status, 202)
    assert.equal(fixture.runtime.prompts.length, 1)

    const blockedPrompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    })
    assert.equal(blockedPrompt.status, 429)
    assert.equal(Number(blockedPrompt.headers.get('retry-after')) > 0, true)
    const blocked = await readJson(blockedPrompt)
    assert.equal(asRecord(blocked.verdict).policyCode, 'quota.prompts_per_hour_exceeded')
    assert.equal(fixture.runtime.prompts.length, 1)

    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events`))
    const events = asArray(usage.events).map(asRecord)
    assert.equal(events.some((event) => event.eventType === 'prompt.enqueued'), true)
    assert.equal(events.some((event) => event.eventType === 'worker.minute'), true)
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const quotas = asArray(summary.quotas).map(asRecord)
    const promptQuota = quotas.find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.limit, 1)
    assert.equal(promptQuota?.used, 1)
    assert.equal(typeof promptQuota?.resetAt, 'string')
    assert.equal(summary.totalsScope, 'recent_events')
    assert.equal(summary.eventSampleLimit, 50)
    const totals = asArray(summary.totals).map(asRecord)
    assert.equal(totals.some((total) => total.eventType === 'prompt.enqueued' && total.quantity === 1), true)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP usage analytics require operations or billing permission', async () => {
  let currentPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-user',
    accountId: 'member-user',
    email: 'member@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({
    auth: () => ({ ...currentPrincipal }),
  })
  await fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1', orgId: 'tenant-1' })
  await fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1', orgId: 'tenant-1' })
  await fixture.store.createAccount({ accountId: 'ops-user', email: 'ops@example.test' })
  await fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'usage-ops',
    name: 'Usage Operations',
    baseRole: 'member',
    permissions: ['org:read', 'operations:view'],
  })
  await fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: 'ops-user',
    role: 'member',
    customRoleKey: 'usage-ops',
    status: 'active',
  })
  await fixture.store.createAccount({ accountId: 'billing-user', email: 'billing@example.test' })
  await fixture.store.createCustomRole({
    orgId: 'tenant-1',
    roleKey: 'usage-billing',
    name: 'Usage Billing',
    baseRole: 'member',
    permissions: ['org:read', 'billing:manage'],
  })
  await fixture.store.upsertMembership({
    orgId: 'tenant-1',
    accountId: 'billing-user',
    role: 'member',
    customRoleKey: 'usage-billing',
    status: 'active',
  })
  await fixture.store.recordUsageEvent({
    orgId: 'tenant-1',
    accountId: 'ops-user',
    eventType: 'prompt.enqueued',
    unit: 'count',
    quantity: 1,
  })
  const baseUrl = await fixture.server.listen()
  try {
    const deniedEvents = await fetch(`${baseUrl}/api/usage/events`)
    assert.equal(deniedEvents.status, 403)
    assert.match(String((await readJson(deniedEvents)).error), /operations:view|billing:manage/)
    const deniedSummary = await fetch(`${baseUrl}/api/usage/summary`)
    assert.equal(deniedSummary.status, 403)

    currentPrincipal = {
      ...currentPrincipal,
      userId: 'ops-user',
      accountId: 'ops-user',
      email: 'ops@example.test',
    }
    const allowedEvents = await readJson(await fetch(`${baseUrl}/api/usage/events`))
    assert.equal(asArray(allowedEvents.events).length, 1)

    currentPrincipal = {
      ...currentPrincipal,
      userId: 'billing-user',
      accountId: 'billing-user',
      email: 'billing@example.test',
    }
    const allowedSummary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    assert.equal(allowedSummary.totalsScope, 'recent_events')
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks managed command queue depth before enqueueing extra work', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxQueuedCommandsPerOrg: 1,
      maxPromptsPerHour: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const first = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first queued prompt' }),
    })
    assert.equal(first.status, 202)
    assert.equal(fixture.runtime.prompts.length, 0)

    const blocked = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'this prompt text must not be metered' }),
    })
    assert.equal(blocked.status, 429)
    const body = await readJson(blocked)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.queued_commands_exceeded')
    assert.equal(fixture.runtime.prompts.length, 0)

    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events?limit=50`))
    const usageText = JSON.stringify(usage)
    assert.equal(usageText.includes('first queued prompt'), false)
    assert.equal(usageText.includes('this prompt text must not be metered'), false)
    const events = asArray(usage.events).map(asRecord)
    assert.equal(events.some((event) => event.eventType === 'work.queued'), true)
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const promptQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server gates gateway-originated prompts separately from general prompts', async () => {
  const fixture = createFixture({
    autoProcessCommands: false,
    abuse: testAbuseConfig({
      maxPromptsPerHour: 100,
      maxGatewayPromptsPerHour: 1,
      maxQueuedCommandsPerOrg: 100,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  const headers = { 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(`${baseUrl}/api/channels/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: 'agent-gateway-quota',
        name: 'Gateway quota agent',
        profileName: 'full',
      }),
    })).status, 201)
    assert.equal((await fetch(`${baseUrl}/api/channels/bindings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        bindingId: 'binding-gateway-quota',
        agentId: 'agent-gateway-quota',
        provider: 'telegram',
        displayName: 'Telegram quota',
        externalWorkspaceId: 'bot-quota',
      }),
    })).status, 201)
    const identity = asRecord((await readJson(await fetch(`${baseUrl}/api/channels/identities/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'telegram',
        externalWorkspaceId: 'bot-quota',
        externalUserId: 'tg-quota-user',
        accountId: 'user-1',
        role: 'member',
        status: 'active',
      }),
    }))).identity)
    const bound = await readJson(await fetch(`${baseUrl}/api/channels/sessions/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        channelBindingId: 'binding-gateway-quota',
        provider: 'telegram',
        externalChatId: 'chat-quota',
        externalThreadId: 'thread-quota',
        title: 'Gateway quota thread',
      }),
    }))
    const bindingId = String(asRecord(bound.binding).bindingId)

    const first = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId,
        text: 'first gateway prompt',
      }),
    })
    assert.equal(first.status, 202)
    const blocked = await fetch(`${baseUrl}/api/channels/sessions/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        identityId: identity.identityId,
        bindingId,
        text: 'second gateway prompt',
      }),
    })
    assert.equal(blocked.status, 429)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'quota.gateway_prompts_per_hour_exceeded')
    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const gatewayQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'gateway_prompts:hour')
    assert.equal(gatewayQuota?.limit, 1)
    assert.equal(gatewayQuota?.used, 1)
    const promptQuota = asArray(summary.quotas).map(asRecord).find((quota) => quota.quotaKey === 'prompts:hour')
    assert.equal(promptQuota?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks worker execution when worker-minute quota is exhausted', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxWorkerMinutesPerHour: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const now = new Date()
    fixture.store.consumeUsageQuota({
      orgId: 'tenant-1',
      quotaKey: 'worker_minutes:hour',
      quantity: 1,
      limit: 1,
      windowMs: 60 * 60 * 1000,
      now,
      policyCode: 'quota.worker_minutes_per_hour_exceeded',
    })

    const prompt = await fetch(`${baseUrl}/api/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do not execute' }),
    })
    assert.equal(prompt.status, 202)
    const body = await readJson(prompt)
    assert.equal(body.processed, 0)
    assert.equal(body.projectionFence, null)
    assert.equal(fixture.runtime.prompts.length, 0)

    const summary = await readJson(await fetch(`${baseUrl}/api/usage/summary?limit=50`))
    const quotas = asArray(summary.quotas).map(asRecord)
    const workerMinutes = quotas.find((quota) => quota.quotaKey === 'worker_minutes:hour')
    assert.equal(workerMinutes?.limit, 1)
    assert.equal(workerMinutes?.used, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server saturates worker-minute quota when a command crosses the limit', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxWorkerMinutesPerHour: 10,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  await fixture.server.listen()
  try {
    fixture.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
    fixture.store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
    const now = new Date()
    fixture.store.consumeUsageQuota({
      orgId: 'tenant-1',
      quotaKey: 'worker_minutes:hour',
      quantity: 9,
      limit: 10,
      windowMs: 60 * 60 * 1000,
      now,
      policyCode: 'quota.worker_minutes_per_hour_exceeded',
    })

    await fixture.service.recordWorkerMinutes({
      tenantId: 'tenant-1',
      sessionId: 'session-crossing',
      workerId: 'worker-a',
      elapsedMs: 2 * 60_000,
    })

    const counters = await fixture.store.listUsageQuotaCounters('tenant-1')
    const workerMinutes = counters.find((counter) => counter.quotaKey === 'worker_minutes:hour')
    assert.equal(workerMinutes?.quantity, 10)
    await assert.rejects(
      () => fixture.service.assertWorkerExecutionAllowed('tenant-1'),
      /Cloud worker minute quota exceeded/,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP server blocks session quotas before eager runtime creation', async () => {
  const fixture = createFixture({
    abuse: testAbuseConfig({
      maxConcurrentSessionsPerOrg: 1,
      httpRateLimit: { enabled: false, windowMs: 60_000, maxRequests: 100 },
    }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const first = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(first.status, 201)
    assert.equal(fixture.runtime.createdSessions.length, 0)

    const blocked = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(blocked.status, 429)
    assert.equal(fixture.runtime.createdSessions.length, 0)
    const body = await readJson(blocked)
    assert.equal(asRecord(body.verdict).policyCode, 'quota.concurrent_sessions_exceeded')
  } finally {
    await fixture.server.close()
  }
})
