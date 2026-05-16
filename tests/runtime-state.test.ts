import assert from 'node:assert/strict'
import test from 'node:test'
import type { OpencodeClient as V2OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  RuntimeState,
} from '../apps/desktop/src/main/runtime-state.ts'

function fakeClient(id: string) {
  return { id } as unknown as V2OpencodeClient
}

test('RuntimeState reset clears runtime-owned mutable state but keeps lifecycle handlers', () => {
  const state = new RuntimeState()
  const created: string[] = []
  const evicted: string[] = []

  state.setClient(fakeClient('root'))
  state.setServerUrl('http://127.0.0.1:1234')
  state.setServerAuth({
    username: 'opencode',
    password: 'redacted',
    authorizationHeader: 'Basic redacted',
  })
  state.setServerClose(() => {})
  state.setCurrentRuntimePid(1234)
  state.setCachedModelInfo({
    pricing: { a: { inputPer1M: 1, outputPer1M: 2 } },
    contextLimits: { b: 2 },
  })
  state.setActiveProjectOverlayDirectory('/project')
  state.setDirectoryClient('/project', fakeClient('project'))
  state.setDirectoryClientLifecycleHandlers({
    onCreate: (directory) => created.push(directory),
    onEvict: (directory) => evicted.push(directory),
  })

  state.resetAfterStop()

  assert.equal(state.getClient(), null)
  assert.equal(state.getServerUrl(), null)
  assert.equal(state.getServerAuth(), null)
  assert.equal(state.takeServerClose(), null)
  assert.equal(state.takeCurrentRuntimePid(), null)
  assert.equal(state.getCachedModelInfo(), null)
  assert.equal(state.getActiveProjectOverlayDirectory(), null)
  assert.equal(state.getDirectoryClients().size, 0)

  state.getDirectoryClientCreatedHandler()?.('/next', fakeClient('next'))
  state.getDirectoryClientEvictedHandler()?.('/old', fakeClient('old'))
  assert.deepEqual(created, ['/next'])
  assert.deepEqual(evicted, ['/old'])
})
