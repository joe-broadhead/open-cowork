import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CONFIG,
  type OpenCoworkConfig,
} from '@open-cowork/shared'
import {
  applyCloudRuntimeCapabilityPolicy,
  CloudRuntimeCapabilityPolicyError,
  compileCloudRuntimeCapabilityPolicy,
  isCloudRuntimeCapabilityAllowed,
} from '@open-cowork/cloud-server/cloud-runtime-capability-policy'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { createNodeManagedOpencodeServer } from '@open-cowork/runtime-host/runtime-node-managed-server'

const CAPABILITY_CONFIG: OpenCoworkConfig = {
  ...DEFAULT_CONFIG,
  tools: [
    {
      id: 'knowledge',
      name: 'Knowledge',
      description: 'Knowledge tool',
      kind: 'built-in',
      namespace: 'knowledge',
      patterns: ['mcp__knowledge__*'],
      askPatterns: ['mcp__knowledge__propose_knowledge_edit'],
    },
    {
      id: 'charts',
      name: 'Charts',
      description: 'Charts tool',
      kind: 'built-in',
      namespace: 'charts',
      patterns: ['mcp__charts__*'],
      allowPatterns: ['mcp__charts__*'],
    },
  ],
  mcps: [
    {
      name: 'knowledge',
      type: 'local',
      description: 'Knowledge MCP',
      authMode: 'none',
    },
    {
      name: 'charts',
      type: 'local',
      description: 'Charts MCP',
      authMode: 'none',
    },
  ],
}

function policy(allowedTools: string[] | null, allowedMcps: string[] | null) {
  return {
    ...resolveCloudRuntimePolicy(CAPABILITY_CONFIG),
    allowedTools,
    allowedMcps,
  }
}

type EffectivePermissionRule = {
  action: string
  resource: string
  effect: 'allow' | 'ask' | 'deny'
}

function wildcardMatches(pattern: string, value: string) {
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let resumeValueIndex = 0
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === '?' || pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1
      valueIndex += 1
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex
      patternIndex += 1
      resumeValueIndex = valueIndex
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeValueIndex += 1
      valueIndex = resumeValueIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

function effectivePermissionAction(
  rules: EffectivePermissionRule[],
  action: string,
  resource = '*',
) {
  let result: EffectivePermissionRule['effect'] = 'deny'
  for (const rule of rules) {
    if (
      wildcardMatches(rule.action, action)
      && wildcardMatches(rule.resource, resource)
    ) {
      result = rule.effect
    }
  }
  return result
}

function permissionConfigRules(permission: unknown): EffectivePermissionRule[] {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
    return []
  }
  const rules: EffectivePermissionRule[] = []
  for (const [action, rawRule] of Object.entries(permission)) {
    if (rawRule === 'allow' || rawRule === 'ask' || rawRule === 'deny') {
      rules.push({ action, resource: '*', effect: rawRule })
      continue
    }
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue
    for (const [resource, effect] of Object.entries(rawRule)) {
      if (effect === 'allow' || effect === 'ask' || effect === 'deny') {
        rules.push({ action, resource, effect })
      }
    }
  }
  return rules
}

test('Cloud runtime capability policy compiles the unrestricted profile into an explicit final permission set', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(null, null),
  })

  assert.equal(compiled.permission.bash, CAPABILITY_CONFIG.permissions.bash)
  assert.equal(compiled.permission.edit, CAPABILITY_CONFIG.permissions.fileWrite)
  assert.equal(compiled.permission.read, 'allow')
  assert.equal(compiled.permission.question, 'allow')
  assert.equal(compiled.permission.skill, 'allow')
  assert.equal(compiled.permission['*'], 'deny')
  assert.equal(compiled.permission['mcp__charts__*'], 'allow')
  assert.equal(compiled.permission['charts_*'], 'allow')
  assert.equal(compiled.permission['mcp__knowledge__propose_knowledge_edit'], 'ask')
  assert.deepEqual(compiled.allowedMcpNames, ['knowledge', 'charts'])
})

test('Cloud runtime capability policy preserves explicit empty allowlists and denies every tool and MCP', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy([], []),
  })

  assert.equal(compiled.permission.bash, 'deny')
  assert.equal(compiled.permission.edit, 'deny')
  assert.equal(compiled.permission.read, 'deny')
  assert.equal(compiled.permission.question, 'deny')
  assert.equal(compiled.permission.skill, 'deny')
  assert.equal(compiled.permission['mcp__charts__*'], 'deny')
  assert.equal(compiled.permission['charts_*'], 'deny')
  assert.equal(compiled.permission['unregistered_plugin_tool'], undefined)
  assert.equal(Object.keys(compiled.permission)[0], '*')
  assert.deepEqual(compiled.allowedToolIds, [])
  assert.deepEqual(compiled.allowedMcpNames, [])
})

test('Cloud runtime capability policy requires both tool and MCP allowlists for an MCP-backed capability', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['knowledge'], []),
  })

  assert.equal(compiled.permission['mcp__knowledge__*'], 'deny')
  assert.equal(compiled.permission['knowledge_*'], 'deny')
  assert.equal(isCloudRuntimeCapabilityAllowed(compiled, {
    toolId: 'knowledge',
    mcpName: 'knowledge',
  }), false)
})

test('Cloud runtime capability policy maps native capability groups and keeps app permission ceilings', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['bash', 'edit', 'web'], []),
  })

  assert.equal(compiled.permission.bash, CAPABILITY_CONFIG.permissions.bash)
  assert.equal(compiled.permission.edit, CAPABILITY_CONFIG.permissions.fileWrite)
  assert.equal(compiled.permission.write, CAPABILITY_CONFIG.permissions.fileWrite)
  assert.equal(compiled.permission.webfetch, CAPABILITY_CONFIG.permissions.web)
  assert.equal(compiled.permission.websearch, CAPABILITY_CONFIG.permissions.web)
  assert.equal(compiled.permission.read, 'deny')
  assert.equal(compiled.permission.task, 'deny')
})

test('Cloud runtime capability policy does not widen an individually named native tool', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['websearch'], []),
  })

  assert.equal(compiled.permission.websearch, CAPABILITY_CONFIG.permissions.web)
  assert.equal(compiled.permission.webfetch, 'deny')
  assert.equal(compiled.permission.codesearch, 'deny')
})

test('Cloud runtime capability policy preserves native question and skill as explicit capabilities', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['question', 'skill'], []),
  })

  assert.equal(compiled.permission.question, 'allow')
  assert.equal(compiled.permission.skill, 'allow')
  assert.equal(compiled.permission.bash, 'deny')
  assert.deepEqual(compiled.allowedToolIds, ['question', 'skill'])
})

test('Cloud runtime capability policy fails closed on unknown capability identifiers', () => {
  assert.throws(
    () => compileCloudRuntimeCapabilityPolicy({
      appConfig: CAPABILITY_CONFIG,
      policy: policy(['unknown-tool'], []),
    }),
    (error: unknown) => (
      error instanceof CloudRuntimeCapabilityPolicyError
      && error.code === 'unknown_tool'
      && error.capabilityId === 'unknown-tool'
    ),
  )
  assert.throws(
    () => compileCloudRuntimeCapabilityPolicy({
      appConfig: CAPABILITY_CONFIG,
      policy: policy([], ['unknown-mcp']),
    }),
    (error: unknown) => (
      error instanceof CloudRuntimeCapabilityPolicyError
      && error.code === 'unknown_mcp'
      && error.capabilityId === 'unknown-mcp'
    ),
  )
})

test('Cloud runtime capability policy removes denied MCP registrations and clamps agent rules', () => {
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['bash', 'read', 'charts'], ['charts']),
  })
  const applied = applyCloudRuntimeCapabilityPolicy({
    mcp: {
      charts: {
        type: 'local',
        command: ['node', 'charts.mjs'],
      },
      knowledge: {
        type: 'local',
        command: ['node', 'knowledge.mjs'],
      },
    },
    agent: {
      build: { mode: 'primary', permission: { '*': 'allow' } },
      general: {
        mode: 'subagent',
        permission: {
          bash: 'deny',
          read: 'ask',
          question: 'allow',
          'mcp__charts__*': 'deny',
          'mcp__knowledge__*': 'allow',
        },
      },
    },
  }, compiled)

  assert.deepEqual(Object.keys(applied.mcp || {}), ['charts'])
  assert.equal(applied.permission?.['mcp__charts__*'], 'allow')
  assert.equal(applied.permission?.['mcp__knowledge__*'], 'deny')
  assert.deepEqual(applied.agent?.build?.permission, {})
  const generalRules = [
    ...permissionConfigRules(applied.permission),
    ...permissionConfigRules(applied.agent?.general?.permission),
  ]
  assert.equal(effectivePermissionAction(generalRules, 'bash'), 'deny')
  assert.equal(effectivePermissionAction(generalRules, 'read'), 'ask')
  assert.equal(effectivePermissionAction(generalRules, 'question'), 'deny')
  assert.equal(effectivePermissionAction(generalRules, 'mcp__charts__render'), 'deny')
  assert.equal(effectivePermissionAction(generalRules, 'mcp__knowledge__search'), 'deny')
  assert.equal(effectivePermissionAction(generalRules, 'unregistered_plugin_tool'), 'deny')
})

test('Cloud runtime capability policy preserves resource restrictions without allowing an agent above the ceiling', () => {
  const appConfig: OpenCoworkConfig = {
    ...CAPABILITY_CONFIG,
    permissions: {
      ...CAPABILITY_CONFIG.permissions,
      bash: 'allow',
    },
  }
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig,
    policy: {
      ...resolveCloudRuntimePolicy(appConfig),
      allowedTools: ['bash'],
      allowedMcps: [],
    },
  })
  const applied = applyCloudRuntimeCapabilityPolicy({
    agent: {
      general: {
        mode: 'subagent',
        permission: {
          bash: {
            '*': 'ask',
            'git status': 'allow',
            'rm *': 'deny',
          },
          read: 'allow',
        },
      },
    },
  }, compiled)
  const rules = [
    ...permissionConfigRules(applied.permission),
    ...permissionConfigRules(applied.agent?.general?.permission),
  ]

  assert.equal(effectivePermissionAction(rules, 'bash', 'printf safe'), 'ask')
  assert.equal(effectivePermissionAction(rules, 'bash', 'git status'), 'allow')
  assert.equal(effectivePermissionAction(rules, 'bash', 'rm -rf project'), 'deny')
  assert.equal(effectivePermissionAction(rules, 'read', 'secret.txt'), 'deny')
})

test('pinned OpenCode V2 enforces the final Cloud policy used by native sessions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-cloud-capability-runtime-'))
  const project = join(root, 'project')
  const xdgConfig = join(root, 'xdg-config')
  const xdgData = join(root, 'xdg-data')
  const xdgCache = join(root, 'xdg-cache')
  const xdgState = join(root, 'xdg-state')
  mkdirSync(project, { recursive: true })
  const runtimeHostRequire = createRequire(new URL('../packages/runtime-host/package.json', import.meta.url))
  const opencodePackage = runtimeHostRequire.resolve('opencode-ai/package.json')
  const opencodeBinary = join(dirname(opencodePackage), 'bin', 'opencode.exe')
  const opencodeVersion = (
    runtimeHostRequire(opencodePackage) as { version?: string }
  ).version
  const chartsMcpScript = fileURLToPath(
    new URL('../mcps/charts/dist/index.js', import.meta.url),
  )
  assert.equal(opencodeVersion, '1.18.1')
  let chartToolResultReachedModel = false
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const hasToolResult = body.messages?.some((message) => message.role === 'tool') === true
    if (hasToolResult) {
      chartToolResultReachedModel = JSON.stringify(body).includes('vega')
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload: unknown) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    if (!hasToolResult) {
      send({
        id: 'chatcmpl-capability-policy',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-charts-bar-chart',
              type: 'function',
              function: {
                name: 'charts_bar_chart',
                arguments: JSON.stringify({
                  data: [{ category: 'A', value: 1 }],
                  x: 'category',
                  y: 'value',
                  title: 'Capability policy seam proof',
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      })
      send({
        id: 'chatcmpl-capability-policy',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })
    } else {
      send({
        id: 'chatcmpl-capability-policy',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'Chart tool completed.' },
          finish_reason: null,
        }],
      })
      send({
        id: 'chatcmpl-capability-policy',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    modelServer.once('error', rejectListen)
    modelServer.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => modelServer.close())
  const modelAddress = modelServer.address() as AddressInfo
  const compiled = compileCloudRuntimeCapabilityPolicy({
    appConfig: CAPABILITY_CONFIG,
    policy: policy(['read', 'charts'], ['charts']),
  })
  const config = applyCloudRuntimeCapabilityPolicy({
    autoupdate: false,
    share: 'manual',
    model: 'fixture/fixture-model',
    small_model: 'fixture/fixture-model',
    enabled_providers: ['fixture'],
    mcp: {
      charts: {
        type: 'local',
        command: [process.execPath, chartsMcpScript],
        enabled: true,
      },
    },
    agent: {
      build: { mode: 'primary', permission: compiled.permission },
      plan: { mode: 'primary', permission: compiled.permission },
      general: {
        mode: 'subagent',
        permission: {
          bash: 'deny',
          read: 'ask',
          'mcp__charts__*': 'deny',
        },
      },
      explore: { mode: 'subagent', permission: compiled.permission },
    },
    provider: {
      fixture: {
        name: 'Fixture provider',
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: 'synthetic-capability-policy-key',
          baseURL: `http://127.0.0.1:${modelAddress.port}/v1`,
        },
        models: {
          'fixture-model': {
            name: 'Fixture model',
          },
        },
      },
    },
  }, compiled)
  const server = await createNodeManagedOpencodeServer({
    hostname: '127.0.0.1',
    port: 0,
    timeout: 15_000,
    config,
    cwd: project,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
    opencodeBinPath: opencodeBinary,
  })
  t.after(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function createNativeV2Session(agent = 'build') {
    const response = await fetch(`${server.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent,
        location: { directory: project },
      }),
    })
    assert.equal(response.ok, true)
    const body = await response.json() as { data: { id: string } }
    assert.ok(body.data.id)
    return body.data.id
  }
  await createNativeV2Session()

  let chartsConnected = false
  for (let attempt = 0; attempt < 50 && !chartsConnected; attempt += 1) {
    const response = await fetch(
      `${server.url}/mcp?directory=${encodeURIComponent(project)}`,
    )
    assert.equal(response.ok, true)
    const payload = await response.json() as {
      charts?: { status?: string }
    }
    chartsConnected = payload.charts?.status === 'connected'
    if (!chartsConnected) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  assert.equal(chartsConnected, true)

  let agents: Array<{
    id: string
    mode: string
    permissions: EffectivePermissionRule[]
  }> = []
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${server.url}/api/agent`)
    assert.equal(response.ok, true)
    const payload = await response.json() as { data?: typeof agents }
    agents = payload.data || []
    if (agents.length) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  for (const name of ['build', 'plan', 'general', 'explore']) {
    const agent = agents.find((candidate) => candidate.id === name)
    assert.ok(agent, `expected OpenCode V2 agent ${name}`)
    assert.equal(
      effectivePermissionAction(agent.permissions, 'read'),
      name === 'general' ? 'ask' : 'allow',
    )
    assert.equal(effectivePermissionAction(agent.permissions, 'bash'), 'deny')
    assert.equal(
      effectivePermissionAction(agent.permissions, 'mcp__charts__render'),
      name === 'general' ? 'deny' : 'allow',
    )
    assert.equal(effectivePermissionAction(agent.permissions, 'mcp__knowledge__search'), 'deny')
    assert.equal(effectivePermissionAction(agent.permissions, 'unregistered_plugin_tool'), 'deny')
  }

  async function evaluateInvocationPermission(
    action: string,
    resource = '*',
    agent = 'build',
  ) {
    const sessionId = await createNativeV2Session(agent)
    const response = await fetch(
      `${server.url}/api/session/${encodeURIComponent(sessionId)}/permission`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          resources: [resource],
        }),
      },
    )
    assert.equal(response.ok, true)
    const body = await response.json() as {
      data?: { effect?: 'allow' | 'ask' | 'deny' }
    }
    return body.data?.effect
  }

  // This is the public V2 evaluator used by createNativeSession-driven Cloud
  // sessions; generated config and catalog visibility are not authorization.
  assert.equal(await evaluateInvocationPermission('bash', 'printf forbidden'), 'deny')
  assert.equal(await evaluateInvocationPermission('read', join(project, 'own.txt')), 'allow')
  assert.equal(await evaluateInvocationPermission('mcp__charts__render'), 'allow')
  assert.equal(await evaluateInvocationPermission('mcp__knowledge__search'), 'deny')
  assert.equal(await evaluateInvocationPermission('unregistered_plugin_tool'), 'deny')
  assert.equal(await evaluateInvocationPermission('read', join(project, 'own.txt'), 'general'), 'ask')
  assert.equal(await evaluateInvocationPermission('mcp__charts__render', '*', 'general'), 'deny')

  const invocationSessionId = await createNativeV2Session()
  const invocationResponse = await fetch(
    `${server.url}/session/${encodeURIComponent(invocationSessionId)}/message`
      + `?directory=${encodeURIComponent(project)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: {
          providerID: 'fixture',
          modelID: 'fixture-model',
        },
        agent: 'build',
        parts: [{
          type: 'text',
          text: 'Invoke the allowed Charts MCP bar chart tool.',
        }],
      }),
    },
  )
  const invocationText = await invocationResponse.text()
  assert.equal(
    invocationResponse.ok,
    true,
    `OpenCode invocation failed: ${invocationText}`,
  )
  const invocation = JSON.parse(invocationText) as {
    parts?: Array<{ type?: string; text?: string }>
  }
  assert.equal(chartToolResultReachedModel, true)
  assert.ok(invocation.parts?.some((part) => (
    part.type === 'text' && part.text === 'Chart tool completed.'
  )))
  const messagesResponse = await fetch(
    `${server.url}/session/${encodeURIComponent(invocationSessionId)}/message`
      + `?directory=${encodeURIComponent(project)}`,
  )
  assert.equal(messagesResponse.ok, true)
  const messages = await messagesResponse.json() as Array<{
    parts?: Array<{ type?: string; tool?: string; state?: { status?: string } }>
  }>
  assert.ok(messages.some((message) => message.parts?.some((part) => (
    part.type === 'tool'
    && part.tool === 'charts_bar_chart'
    && part.state?.status === 'completed'
  ))), JSON.stringify(messages))
})
