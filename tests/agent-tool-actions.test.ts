import { configureAgentToolBridge, ensureAgentToolBridge, getAgentToolBridgeEnvironment, stopAgentToolBridge } from '@open-cowork/runtime-host/agent-tool-bridge'
import { deleteAgentFromTool, getAgentFromTool, listAgentsFromTool, previewAgentFromTool, saveAgentFromTool } from '@open-cowork/runtime-host/agent-tool-actions'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-agent-tool-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function withAgentToolStore(name: string, run: (userDataDir: string) => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    await run(userDataDir)
  } finally {
    stopAgentToolBridge()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

const draft = {
  scope: 'machine' as const,
  directory: null,
  name: 'weekly-analyst',
  description: 'Analyze weekly business performance.',
  instructions: 'Load the analyst skill and produce a concise weekly summary.',
  skillNames: ['agent-creator'],
  toolIds: ['agents'],
  enabled: true,
  color: 'success' as const,
}

test('agent tool actions preview and save through the shared custom-agent store path', async () => {
  await withAgentToolStore('actions', async () => {
    const preview = await previewAgentFromTool(draft)
    assert.equal(preview.ok, true)
    assert.equal(preview.agent.name, 'weekly-analyst')
    assert.equal(preview.permission?.skill && typeof preview.permission.skill === 'object', true)
    assert.equal((preview.permission?.skill as Record<string, string>)['agent-creator'], 'allow')
    // JOE-831: MCP permissions default to ask for least privilege.
    assert.equal(preview.permission?.['mcp__agents__preview_agent'], 'ask')
    assert.equal(preview.permission?.['mcp__agents__save_agent'], 'ask')

    const saved = await saveAgentFromTool(draft)
    assert.equal(saved.ok, true)
    assert.equal(saved.runtimeRefreshRequired, true)
    assert.equal(listAgentsFromTool().agents.some((agent) => agent.name === 'weekly-analyst'), true)
    assert.equal(getAgentFromTool({ scope: 'machine', name: 'weekly-analyst' }).agent.description, draft.description)

    const deleted = deleteAgentFromTool({ scope: 'machine', name: 'weekly-analyst' })
    assert.equal(deleted.ok, true)
    assert.equal(listAgentsFromTool().agents.some((agent) => agent.name === 'weekly-analyst'), false)
  })
})

test('agent tool save preserves omitted mode and permission guardrails on update', async () => {
  await withAgentToolStore('preserve-guardrails', async () => {
    await saveAgentFromTool({
      ...draft,
      mode: 'primary',
      permissionOverrides: [
        { key: 'mcp', action: 'deny', rules: [{ pattern: 'mcp__agents__preview_agent', action: 'allow' }] },
      ],
    })

    await saveAgentFromTool({
      ...draft,
      description: 'Updated without touching guardrails.',
    })

    const preserved = getAgentFromTool({ scope: 'machine', name: 'weekly-analyst' }).agent
    assert.equal(preserved.mode, 'primary')
    assert.deepEqual(preserved.permissionOverrides, [
      { key: 'mcp', action: 'deny', rules: [{ pattern: 'mcp__agents__preview_agent', action: 'allow' }] },
    ])

    await saveAgentFromTool({
      ...draft,
      description: 'Explicitly clears guardrails.',
      mode: 'subagent',
      permissionOverrides: [],
    })

    const cleared = getAgentFromTool({ scope: 'machine', name: 'weekly-analyst' }).agent
    assert.equal(cleared.mode, 'subagent')
    assert.deepEqual(cleared.permissionOverrides, [])
  })
})

test('agent tool bridge requires bearer auth and returns before scheduling runtime refresh', async () => {
  await withAgentToolStore('bridge', async () => {
    let refreshCount = 0
    configureAgentToolBridge({ scheduleRuntimeRefresh: () => { refreshCount += 1 } })
    await ensureAgentToolBridge()
    const env = getAgentToolBridgeEnvironment()
    const baseUrl = env.OPEN_COWORK_AGENT_TOOL_URL
    const token = env.OPEN_COWORK_AGENT_TOOL_TOKEN
    assert.equal(typeof baseUrl, 'string')
    assert.equal(typeof token, 'string')

    const unauthorized = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
    assert.equal(unauthorized.status, 401)
    assert.match(await unauthorized.text(), /Unauthorized agent tool request/)

    const wrongSameLengthToken = token!.replace(/.$/, (last) => last === 'A' ? 'B' : 'A')
    const wrongToken = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${wrongSameLengthToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft),
    })
    assert.equal(wrongToken.status, 401)
    assert.match(await wrongToken.text(), /Unauthorized agent tool request/)

    const preview = await fetch(`${baseUrl}/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft),
    })
    assert.equal(preview.status, 200)
    assert.equal((await preview.json() as { ok: boolean }).ok, true)

    const saved = await fetch(`${baseUrl}/save`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft),
    })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json() as { ok: boolean }).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(refreshCount, 1)
  })
})
