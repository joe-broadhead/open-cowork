import { invalidateRuntimeCatalogSnapshotCache } from '@open-cowork/runtime-host/runtime-catalog-snapshot'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
} from './helpers/cloud-http-test-support.ts'

test('cloud HTTP exposes operator projection lag and repair routes', async () => {
  const fixture = createFixture({ autoProcessCommands: false })
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fixture.store.appendSessionEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      type: 'assistant.message',
      payload: {
        messageId: 'repair-http-message',
        content: 'repair over http',
      },
    })

    const status = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/projection-status`))
    assert.equal(asRecord(status).latestEventSequence, 2)
    assert.equal(asRecord(status).projectionSequence, 1)
    assert.equal(asRecord(status).lag, 1)

    const repaired = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/projection-repair`, {
      method: 'POST',
    }))
    assert.equal(asRecord(repaired).repaired, true)
    assert.equal(asRecord(repaired).projectionSequence, 2)

    const view = await readJson(await fetch(`${baseUrl}/api/sessions/oc-session-1/view`))
    const projectionView = asRecord(asRecord(view.projection).view)
    assert.equal(asRecord(asArray(projectionView.messages).at(-1)).content, 'repair over http')
  } finally {
    await fixture.server.close()
  }
})
test('cloud HTTP exposes worker heartbeat visibility for operators', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await fixture.store.recordWorkerHeartbeat({
      workerId: 'worker-1',
      role: 'worker',
      activeSessionIds: ['oc-session-1'],
      now: new Date('2026-05-26T12:00:00.000Z'),
    })

    const response = await fetch(`${baseUrl}/api/workers/heartbeats`)
    assert.equal(response.status, 200)
    const body = await readJson(response)
    const heartbeats = asArray(body.heartbeats)
    assert.equal(heartbeats.length, 1)
    assert.deepEqual(asRecord(heartbeats[0]), {
      workerId: 'worker-1',
      role: 'worker',
      activeSessionIds: ['oc-session-1'],
      lastSeenAt: '2026-05-26T12:00:00.000Z',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes a read-only capability catalog filtered by profile allowlists', async () => {
  const previousConfigPath = process.env.OPEN_COWORK_CONFIG_PATH
  const configDir = await mkdtemp(join(tmpdir(), 'open-cowork-capabilities-'))
  const configPath = join(configDir, 'open-cowork.config.json')
  await writeFile(configPath, JSON.stringify({
    tools: [{
      id: 'charts',
      name: 'Charts',
      description: 'Render chart artifacts.',
      kind: 'mcp',
      namespace: 'charts',
      patterns: ['mcp__charts__*'],
    }],
    mcps: [{
      name: 'charts',
      type: 'local',
      description: 'Charts MCP',
      authMode: 'none',
      command: ['node', 'charts.js'],
    }],
    agents: [{
      name: 'data-analyst',
      label: 'data-analyst',
      description: 'Analyze data.',
      instructions: 'Analyze data.',
      toolIds: ['charts'],
    }],
  }), 'utf8')
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()
  invalidateRuntimeCatalogSnapshotCache()

  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      allowedAgents: ['data-analyst'],
      allowedTools: ['charts'],
      allowedMcps: ['charts'],
      features: {
        ...basePolicy.features,
        customSkills: false,
        customMcps: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const catalog = await readJson(await fetch(`${baseUrl}/api/capabilities`))
    const tools = asArray(catalog.tools)
    assert.equal(tools.length, 1)
    assert.equal(asRecord(tools[0]).id, 'charts')

    const charts = await readJson(await fetch(`${baseUrl}/api/capabilities/tools/charts`))
    assert.equal(asRecord(charts.tool).namespace, 'charts')
    const clockResponse = await fetch(`${baseUrl}/api/capabilities/tools/clock`)
    assert.equal(clockResponse.status, 404)

    const skills = asArray((await readJson(await fetch(`${baseUrl}/api/capabilities/skills`))).skills)
    assert.equal(skills.some((skill) => asRecord(skill).name === 'workflow-creator'), false)
    assert.equal(skills.some((skill) => asRecord(skill).toolIds && asArray(asRecord(skill).toolIds).includes('charts')), true)
  } finally {
    await fixture.server.close()
    if (previousConfigPath === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousConfigPath
    clearConfigCaches()
    invalidateRuntimeCatalogSnapshotCache()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('cloud HTTP returns policy verdicts when capabilities are disabled', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        agents: false,
        customSkills: false,
        customMcps: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/capabilities`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Capabilities are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Capabilities are disabled for this cloud profile.',
      policyCode: 'capabilities.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes user-scoped settings metadata', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const saveResponse = await fetch(`${baseUrl}/api/settings/provider.openai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { secretRef: 'cloud-secret/openai' } }),
    })
    assert.equal(saveResponse.status, 200)
    const saved = asRecord((await readJson(saveResponse)).setting)
    assert.equal(saved.key, 'provider.openai')
    assert.deepEqual(saved.value, { secretRef: 'cloud-secret/openai' })

    const listed = await readJson(await fetch(`${baseUrl}/api/settings`))
    assert.equal(asArray(listed.settings).length, 1)
    const fetched = await readJson(await fetch(`${baseUrl}/api/settings/provider.openai`))
    assert.deepEqual(asRecord(fetched.setting).value, { secretRef: 'cloud-secret/openai' })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects settings APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        settings: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/settings`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Settings are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Settings are disabled for this cloud profile.',
      policyCode: 'settings.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects knowledge APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        knowledge: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/knowledge`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Knowledge is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Knowledge is disabled for this cloud profile.',
      policyCode: 'knowledge.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects channel APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        channels: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/channels`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Channels are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Channels are disabled for this cloud profile.',
      policyCode: 'channels.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects BYOK APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        byok: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/byok`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Bring-your-own-key is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Bring-your-own-key is disabled for this cloud profile.',
      policyCode: 'byok.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP enforces the deployer agent allowlist on the prompt path', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: { ...basePolicy, allowedAgents: ['plan'] },
  })
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    // An agent outside the deployer allowlist is rejected — without this gate a
    // caller could name any agent on a prompt and bypass a restricted profile.
    const blocked = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', agent: 'build' }),
    })
    assert.equal(blocked.status, 403)
    assert.equal(asRecord((await readJson(blocked)).verdict).policyCode, 'policy.agent_not_enabled')

    // An allowlisted agent is accepted.
    const allowed = await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', agent: 'plan' }),
    })
    assert.equal(allowed.status, 202)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP exposes durable thread tags, metadata, and smart filters', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const tagResponse = await fetch(`${baseUrl}/api/threads/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Revenue', color: '#22c55e' }),
    })
    assert.equal(tagResponse.status, 201)
    const tagBody = await readJson(tagResponse)
    const tag = asRecord(tagBody.tag)
    assert.equal(tag.name, 'Revenue')

    const applyResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['oc-session-1'] }),
    })
    assert.equal(applyResponse.status, 200)

    const threads = await readJson(await fetch(`${baseUrl}/api/threads?tagId=${tag.tagId}`))
    const thread = asRecord(asArray(threads.threads)[0])
    assert.equal(thread.sessionId, 'oc-session-1')
    assert.equal(asRecord(asArray(thread.tags)[0]).name, 'Revenue')

    const updateTagResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Finance' }),
    })
    assert.equal(updateTagResponse.status, 200)
    assert.equal(asRecord((await readJson(updateTagResponse)).tag).name, 'Finance')

    const filterResponse = await fetch(`${baseUrl}/api/threads/smart-filters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tagged finance', query: { tagIds: [tag.tagId] } }),
    })
    assert.equal(filterResponse.status, 201)
    const filter = asRecord((await readJson(filterResponse)).filter)
    assert.equal(filter.name, 'Tagged finance')

    const filters = await readJson(await fetch(`${baseUrl}/api/threads/smart-filters`))
    assert.equal(asArray(filters.filters).length, 1)

    const removeResponse = await fetch(`${baseUrl}/api/threads/tags/${tag.tagId}/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['oc-session-1'] }),
    })
    assert.equal(removeResponse.status, 200)
    const untagged = await readJson(await fetch(`${baseUrl}/api/threads`))
    assert.deepEqual(asRecord(asArray(untagged.threads)[0]).tags, [])
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects thread-index APIs when the cloud profile disables them', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        threadIndex: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/threads/tags`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Thread index is disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Thread index is disabled for this cloud profile.',
      policyCode: 'thread_index.disabled',
    })
  } finally {
    await fixture.server.close()
  }
})
