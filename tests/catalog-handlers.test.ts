import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateMcpThroughRuntime, runtimeAgentCanWrite, runtimeAgentToolIds } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'

test('authenticateMcpThroughRuntime routes explicit auth through the runtime client', async () => {
  const calls: Array<{ method: string; name: string }> = []

  const result = await authenticateMcpThroughRuntime({
    mcp: {
      auth: {
        remove: async (payload) => {
          calls.push({ method: 'remove', name: payload.name })
        },
        authenticate: async (payload) => {
          calls.push({ method: 'authenticate', name: payload.name })
        },
      },
    },
  }, 'nova')

  assert.equal(result, true)
  assert.deepEqual(calls, [
    { method: 'remove', name: 'nova' },
    { method: 'authenticate', name: 'nova' },
  ])
})

test('authenticateMcpThroughRuntime still authenticates when clearing stored auth fails', async () => {
  const calls: string[] = []

  const result = await authenticateMcpThroughRuntime({
    mcp: {
      auth: {
        remove: async () => {
          calls.push('remove')
          throw new Error('no saved credentials')
        },
        authenticate: async () => {
          calls.push('authenticate')
        },
      },
    },
  }, 'nova')

  assert.equal(result, true)
  assert.deepEqual(calls, ['remove', 'authenticate'])
})

test('authenticateMcpThroughRuntime surfaces runtime auth failures', async () => {
  await assert.rejects(
    authenticateMcpThroughRuntime({
      mcp: {
        auth: {
          authenticate: async () => {
            throw new Error('state mismatch')
          },
        },
      },
    }, 'nova'),
    /state mismatch/,
  )
})

test('runtimeAgentCanWrite treats object-valued edit permissions as writable', () => {
  assert.equal(runtimeAgentCanWrite({
    permission: {
      edit: {
        '*': 'allow',
      },
    },
  }), true)
  assert.equal(runtimeAgentCanWrite({
    permission: {
      edit: {
        '*': 'deny',
      },
    },
  }), false)
})

test('runtimeAgentToolIds derives modern permission-backed tools', () => {
  assert.deepEqual(runtimeAgentToolIds({
    permission: {
      read: 'allow',
      bash: {
        'git status*': 'allow',
      },
      'mcp__charts__*': 'allow',
      'mcp__skills__get_skill_bundle': 'ask',
      'mcp__custom_reports__*': 'allow',
      'mcp__blocked__*': 'deny',
    },
  }), ['bash', 'charts', 'custom_reports', 'read', 'skills'])
})

test('runtimeAgentToolIds expands native v2 action globs and ignores denied rules', () => {
  const toolIds = runtimeAgentToolIds({
    permissions: [
      { action: '*', resource: '*', effect: 'ask' },
      { action: 'mcp__blocked__*', resource: '*', effect: 'deny' },
    ],
  })

  assert.equal(toolIds.includes('bash'), true)
  assert.equal(toolIds.includes('edit'), true)
  assert.equal(toolIds.includes('read'), true)
  assert.equal(toolIds.includes('blocked'), false)
})

test('native v2 permissions use last matching rule for tools and write access', () => {
  const permissions = [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'bash', resource: '*', effect: 'deny' },
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'write', resource: '*', effect: 'deny' },
    { action: 'apply_patch', resource: '*', effect: 'deny' },
    { action: 'todowrite', resource: '*', effect: 'deny' },
    { action: 'mcp__blocked__*', resource: '*', effect: 'deny' },
  ]

  const toolIds = runtimeAgentToolIds({ permissions })
  assert.equal(toolIds.includes('read'), true)
  assert.equal(toolIds.includes('bash'), false)
  assert.equal(toolIds.includes('edit'), false)
  assert.equal(toolIds.includes('write'), false)
  assert.equal(toolIds.includes('apply_patch'), false)
  assert.equal(toolIds.includes('todowrite'), false)
  assert.equal(toolIds.includes('blocked'), false)
  assert.equal(runtimeAgentCanWrite({ permissions }), false)
})

test('native v2 permissions allow a later narrow rule to override an earlier deny', () => {
  const permissions = [
    { action: 'bash', resource: '*', effect: 'deny' },
    { action: 'bash', resource: 'git status*', effect: 'ask' },
  ]

  assert.equal(runtimeAgentToolIds({ permissions }).includes('bash'), true)
  assert.equal(runtimeAgentCanWrite({ permissions }), false)
})

test('runtimeAgentCanWrite keeps read-only bash allowlists read-only', () => {
  assert.equal(runtimeAgentCanWrite({
    permission: {
      bash: {
        'git status*': 'allow',
        'grep *': 'ask',
      },
    },
  }), false)
  assert.equal(runtimeAgentCanWrite({
    permission: {
      bash: {
        'git commit*': 'allow',
      },
    },
  }), true)
})

test('runtimeAgentCanWrite classifies native v2 bash and wildcard permissions', () => {
  assert.equal(runtimeAgentCanWrite({
    permissions: [
      { action: 'bash', resource: 'git status*', effect: 'allow' },
      { action: 'bash', resource: 'grep *', effect: 'ask' },
    ],
  }), false)
  assert.equal(runtimeAgentCanWrite({
    permissions: [
      { action: 'bash', resource: 'git commit*', effect: 'ask' },
    ],
  }), true)
  assert.equal(runtimeAgentCanWrite({
    permissions: [
      { action: 'bash', resource: '*', effect: 'deny' },
    ],
  }), false)
  assert.equal(runtimeAgentCanWrite({
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
    ],
  }), true)
})
