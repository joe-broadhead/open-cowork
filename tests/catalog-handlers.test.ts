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
