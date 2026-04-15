import test from 'node:test'
import assert from 'node:assert/strict'
import { isVisibleRuntimeToolId, toRuntimeToolMetadata } from '../apps/desktop/src/main/runtime-tools.ts'

test('internal OpenCode runtime tools are hidden from Cowork tool catalogs', () => {
  assert.equal(isVisibleRuntimeToolId('skill'), false)
  assert.equal(isVisibleRuntimeToolId('invalid'), false)
  assert.equal(isVisibleRuntimeToolId('websearch'), true)
})

test('runtime tool metadata skips hidden internal tools', () => {
  assert.equal(
    toRuntimeToolMetadata({
      id: 'invalid',
      description: 'Do not use.',
    }),
    null,
  )

  assert.equal(
    toRuntimeToolMetadata({
      id: 'skill',
      description: 'Internal skill loading tool.',
    }),
    null,
  )

  assert.deepEqual(
    toRuntimeToolMetadata({
      id: 'websearch',
      description: 'Search the web.',
    }),
    { id: 'websearch', description: 'Search the web.' },
  )
})
