import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudWebBrowserHarness, waitFor } from './browser-test-harness.ts'

test('cloud web browser renders signed-out OIDC bootstrap state', async () => {
  const harness = await createCloudWebBrowserHarness({ signedOut: true }).start()
  try {
    assert.equal(harness.document.body.dataset.auth, 'signed-out')
    assert.equal(harness.document.querySelector('#status')?.textContent, 'Sign in required')
    assert.equal(harness.document.body.dataset.route, 'org')
    assert.equal((harness.document.querySelector('[data-route-link="byok"]') as HTMLElement).hidden, true)
    assert.equal(harness.lastRequest((request) => request.path === '/auth/me')?.method, 'GET')
  } finally {
    harness.close()
  }
})

test('cloud web browser gates admin controls for member workspaces', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'member' }).start()
  try {
    assert.equal(harness.document.body.dataset.auth, 'signed-in')
    assert.equal(harness.document.querySelector('#role-name')?.textContent, 'member')
    assert.equal((harness.document.querySelector('#admin-notice') as HTMLElement).hidden, false)
    assert.equal((harness.document.querySelector('[data-route-link="byok"]') as HTMLElement).hidden, true)
    assert.equal((harness.document.querySelector('#byok-form input[name="providerId"]') as HTMLInputElement).disabled, true)
    assert.equal((harness.document.querySelector('#desktop-token') as HTMLButtonElement).disabled, true)
    assert.equal(harness.lastRequest((request) => request.path === '/api/workspace')?.method, 'GET')
  } finally {
    harness.close()
  }
})

test('cloud web browser creates, prompts, streams, reloads, and continues a cloud thread', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1/))
    assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Workspace summary for Cloud thread 1/)
    assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Approval/)
    assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Question/)

    const profile = harness.document.querySelector('#session-form input[name="profileName"]') as HTMLInputElement
    profile.value = 'default'
    harness.submit('#session-form')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Created browser thread/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/sessions'))

    const message = harness.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement
    message.value = 'Continue the work.'
    harness.submit('#prompt-form')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Live answer from cloud/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/prompt$/.test(request.path)))

    const sessionId = harness.sessions[0].sessionId
    harness.views[sessionId].projection.view.messages.push({ id: 'live-update', role: 'assistant', content: 'SSE live update arrived.', order: 30 })
    harness.views[sessionId].projection.sequence += 1
    const sessionSource = harness.eventSources.find((source) => source.url.includes(`/api/sessions/${sessionId}/events`))
    assert.ok(sessionSource)
    sessionSource.emit('assistant.message', { type: 'assistant.message', sessionId, sequence: harness.views[sessionId].projection.sequence })
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /SSE live update arrived/))

    const reloaded = createCloudWebBrowserHarness({ role: 'admin' })
    try {
      reloaded.sessions.splice(0, reloaded.sessions.length, ...harness.sessions)
      Object.assign(reloaded.views, harness.views)
      await reloaded.start()
      await waitFor(() => assert.equal(reloaded.document.body.dataset.auth, 'signed-in'))
      await waitFor(() => assert.match(reloaded.document.querySelector('#chat-timeline')?.textContent || '', /SSE live update arrived/))
    } finally {
      reloaded.close()
    }
  } finally {
    harness.close()
  }
})

test('cloud web browser pages cloud threads through backend cursors without losing loaded pages on SSE', async () => {
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    sessionCount: 1001,
    hydratedViewCount: 1,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, 200))
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/sessions?limit=200'))

    const loadMore = harness.document.querySelector('#thread-load-more') as HTMLButtonElement
    for (const expected of [400, 600, 800, 1000]) {
      loadMore.click()
      await waitFor(() => assert.equal(harness.document.querySelectorAll('#thread-list [role="row"]').length, expected))
    }
    assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1000/)
    assert.match(harness.document.querySelector('#thread-limit-status')?.textContent || '', /1000 of 1000 loaded of about 1001 total/)
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path.includes('cursor=offset%3A800')))
    assert.equal((loadMore as HTMLElement).hidden, false)

    const laterPageRow = [...harness.document.querySelectorAll('#thread-list [role="row"]')]
      .find((row) => row.textContent?.includes('Cloud thread 1000'))
    assert.ok(laterPageRow)
    ;(laterPageRow.querySelector('button') as HTMLButtonElement).click()
    await waitFor(() => assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1000/))

    const workspaceSource = harness.eventSources.find((source) => source.url === '/api/events')
    assert.ok(workspaceSource)
    workspaceSource.emit('snapshot.required', { type: 'snapshot.required', sequence: 0 })
    await waitFor(() => {
      const rows = [...harness.document.querySelectorAll('#thread-list [role="row"]')]
      assert.equal(rows.length, 1000)
      assert.equal(new Set(rows.map((row) => row.textContent || '')).size, rows.length)
      assert.match(harness.document.querySelector('#thread-list')?.textContent || '', /Cloud thread 1000/)
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1000/)
      assert.match(harness.document.querySelector('#thread-list [data-selected="true"]')?.textContent || '', /Cloud thread 1000/)
      assert.equal((loadMore as HTMLElement).hidden, false)
    })
  } finally {
    harness.close()
  }
})

test('cloud web browser bounds large admin surfaces and redacts unsafe operational details', async () => {
  const harness = await createCloudWebBrowserHarness({
    role: 'admin',
    memberCount: 150,
    tokenCount: 140,
    deliveryCount: 80,
    workflowCount: 140,
    workerCount: 120,
    auditCount: 130,
    usageCount: 40,
    artifactCount: 140,
  }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))

    assert.equal(harness.document.querySelectorAll('#member-list .member-row').length, 100)
    assert.equal(harness.document.querySelectorAll('#token-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#delivery-list > .row').length, 50)
    assert.equal(harness.document.querySelectorAll('#workflow-list [role="row"]').length, 100)
    assert.equal(harness.document.querySelectorAll('#audit-list > .row').length, 100)
    assert.equal(harness.document.querySelectorAll('#artifact-list .artifact-card').length, 100)
    assert.ok(harness.document.querySelectorAll('#usage-list > .row').length <= 12)
    assert.ok(harness.document.querySelectorAll('#admin-worker-summary > .row').length <= 11)

    assert.ok(harness.lastRequest((request) => request.path === '/api/admin/members?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/api-tokens?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/agents?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/bindings?limit=100'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/channels/deliveries?limit=50'))
    assert.ok(harness.lastRequest((request) => request.path === '/api/workflows?limit=100'))

    const auditText = harness.document.querySelector('#audit-list')?.textContent || ''
    assert.doesNotMatch(auditText, /leaked-secret|signed\?token=/)
    assert.match(auditText, /\[redacted\]/)

    const deliveryText = harness.document.querySelector('#delivery-list')?.textContent || ''
    assert.doesNotMatch(deliveryText, /leaked-secret|signed\?token=/)

    const artifactText = harness.document.querySelector('#artifact-list')?.textContent || ''
    assert.doesNotMatch(artifactText, /signed\?token=|objectKey/)

    harness.clickText('#diagnostics button', 'Prepare bundle')
    await waitFor(() => assert.match(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /secrets-redacted/))
    assert.doesNotMatch(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /leaked-secret|signed\?token=/)
  } finally {
    harness.close()
  }
})

test('cloud web browser handles approvals, questions, artifacts, and workflow runs', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /Run read-only tests/))

    harness.clickText('.runtime-card[data-kind="approval"] button', 'Allow')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /approved/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /permission-respond$/.test(request.path)))

    const answer = harness.document.querySelector('[data-question-answer]') as HTMLTextAreaElement
    answer.value = 'Yes'
    harness.clickText('.runtime-card[data-kind="question"] button', 'Send answer')
    await waitFor(() => assert.match(harness.document.querySelector('#chat-timeline')?.textContent || '', /answered/))
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /question-reply$/.test(request.path)))

    harness.clickText('.artifact-card button', 'Inspect')
    await waitFor(() => {
      assert.equal(harness.document.body.dataset.route, 'artifacts')
      assert.match(harness.document.querySelector('#artifact-detail')?.textContent || '', /Artifact metadata/)
    })
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && /\/artifacts(?:\?|$)/.test(request.path)))

    harness.clickText('.artifact-card button', 'Download')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'GET' && /\/artifacts\/session-1-artifact$/.test(request.path))))

    harness.clickText('[data-route-link]', 'Workflows')
    await waitFor(() => assert.equal(harness.document.body.dataset.route, 'workflows'))
    harness.clickText('#workflow-detail button', 'Run now')
    await waitFor(() => {
      assert.match(harness.document.querySelector('#chat-session-title')?.textContent || '', /Workflow run thread/)
      assert.equal(harness.document.body.dataset.route, 'chat')
    })
    assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/api\/workflows\/workflow-1\/run$/.test(request.path)))
  } finally {
    harness.close()
  }
})

test('cloud web browser exercises BYOK, gateway, billing, diagnostics, and quota/policy blocked states', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))

    ;(harness.document.querySelector('#byok-form input[name="providerId"]') as HTMLInputElement).value = 'openai'
    ;(harness.document.querySelector('#byok-form input[name="apiKey"]') as HTMLInputElement).value = 'sk-test-secret'
    harness.submit('#byok-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/byok/openai')))
    assert.doesNotMatch(harness.document.querySelector('#byok-list')?.textContent || '', /sk-test-secret/)

    ;(harness.document.querySelector('#agent-form input[name="name"]') as HTMLInputElement).value = 'Release helper'
    harness.submit('#agent-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/channels/agents')))

    ;(harness.document.querySelector('#binding-form input[name="displayName"]') as HTMLInputElement).value = 'Team Slack'
    ;(harness.document.querySelector('#binding-form input[name="credentialRef"]') as HTMLInputElement).value = 'secret://gateway/slack'
    harness.submit('#binding-form')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/channels/bindings')))

    harness.clickText('#delivery-list button', 'Retry')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && /\/retry$/.test(request.path))))

    assert.match(harness.document.querySelector('#billing-summary')?.textContent || '', /active/)
    assert.match(harness.document.querySelector('#usage-quota-list')?.textContent || '', /Prompts\/hour/)
    assert.match(harness.document.querySelector('#admin-worker-summary')?.textContent || '', /Primary worker pool/)
    assert.match(harness.document.querySelector('#admin-worker-summary')?.textContent || '', /Worker one/)
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/admin/worker-pools?limit=100'))
    assert.ok(harness.lastRequest((request) => request.method === 'GET' && request.path === '/api/admin/workers?limit=100'))

    harness.clickText('#diagnostics button', 'Prepare bundle')
    await waitFor(() => assert.match(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /secrets-redacted/))
    assert.doesNotMatch(harness.document.querySelector('#diagnostics-bundle')?.textContent || '', /sk-test-secret|occ_created_token/)
  } finally {
    harness.close()
  }

  const policyBlocked = await createCloudWebBrowserHarness({ role: 'admin', projectSourceDenied: true }).start()
  try {
    ;(policyBlocked.document.querySelector('#session-form input[name="repositoryUrl"]') as HTMLInputElement).value = 'https://blocked.example/repo.git'
    policyBlocked.submit('#session-form')
    await waitFor(() => assert.match(policyBlocked.document.querySelector('#status')?.textContent || '', /blocked by policy/i))
  } finally {
    policyBlocked.close()
  }

  const billingBlocked = await createCloudWebBrowserHarness({
    role: 'admin',
    promptFailure: { status: 402, error: 'Billing subscription inactive.' },
  }).start()
  try {
    await waitFor(() => assert.match(billingBlocked.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1/))
    ;(billingBlocked.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value = 'Run more work.'
    billingBlocked.submit('#prompt-form')
    await waitFor(() => assert.match(billingBlocked.document.querySelector('#status')?.textContent || '', /Billing subscription inactive/))
  } finally {
    billingBlocked.close()
  }

  const quotaBlocked = await createCloudWebBrowserHarness({
    role: 'admin',
    promptFailure: { status: 429, error: 'Quota exceeded.' },
  }).start()
  try {
    await waitFor(() => assert.match(quotaBlocked.document.querySelector('#chat-session-title')?.textContent || '', /Cloud thread 1/))
    ;(quotaBlocked.document.querySelector('#prompt-form textarea[name="text"]') as HTMLTextAreaElement).value = 'Run more work.'
    quotaBlocked.submit('#prompt-form')
    await waitFor(() => assert.match(quotaBlocked.document.querySelector('#status')?.textContent || '', /Quota exceeded/))
  } finally {
    quotaBlocked.close()
  }
})

test('cloud web browser requires typed confirmation for destructive admin actions', async () => {
  const harness = await createCloudWebBrowserHarness({ role: 'admin' }).start()
  try {
    await waitFor(() => assert.equal(harness.document.body.dataset.auth, 'signed-in'))

    Object.defineProperty(harness.window, 'prompt', { value: () => 'wrong-id', configurable: true })
    harness.clickText('#token-list button', 'Revoke')
    await waitFor(() => assert.match(harness.document.querySelector('#status')?.textContent || '', /Confirmation did not match the token id/))
    assert.equal(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/api-tokens/token-1'), undefined)

    const prompts = ['anthropic', 'token-1', 'acct-2', 'workflow-1', 'delivery-1', 'Operator reviewed the stuck delivery.']
    Object.defineProperty(harness.window, 'prompt', {
      value: () => prompts.shift() || '',
      configurable: true,
    })

    harness.clickText('#byok-list button', 'Disable')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/byok/anthropic')))

    harness.clickText('#token-list button', 'Revoke')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'DELETE' && request.path === '/api/api-tokens/token-1')))

    const memberRow = [...harness.document.querySelectorAll('#member-list .member-row')]
      .find((row) => row.textContent?.includes('member@example.test'))
    assert.ok(memberRow)
    ;(memberRow.querySelector('button.danger') as HTMLButtonElement).click()
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/admin/members/acct-2/update')))

    harness.clickText('#workflow-detail button', 'Archive')
    await waitFor(() => assert.ok(harness.lastRequest((request) => request.method === 'POST' && request.path === '/api/workflows/workflow-1/archive')))

    harness.clickText('#delivery-list button', 'Dead-letter')
    await waitFor(() => {
      const request = harness.lastRequest((entry) => entry.method === 'POST' && entry.path === '/api/channels/deliveries/delivery-1/dead-letter')
      assert.ok(request)
      assert.equal((request.body as Record<string, unknown>).lastError, 'Operator reviewed the stuck delivery.')
    })
  } finally {
    harness.close()
  }
})
