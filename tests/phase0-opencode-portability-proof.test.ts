import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  assertPhase0SnapshotsMatch,
  digestSdkSnapshot,
  mapPhase0PortableEntryPath,
} from '../scripts/phase0-opencode-portability-proof.ts'
import { runtimePathsForPhase0 } from '../apps/desktop/src/main/cloud/phase0-runtime-portability.ts'

test('phase0 proof maps portable runtime paths into a separate restore root', () => {
  const sourceRuntimePaths = runtimePathsForPhase0({
    home: '/tmp/source/runtime-home',
    configHome: '/tmp/source/runtime-home/.config',
    dataHome: '/tmp/source/runtime-home/.local/share',
    cacheHome: '/tmp/source/runtime-home/.cache',
    stateHome: '/tmp/source/runtime-home/.local/state',
  })
  const targetRuntimePaths = runtimePathsForPhase0({
    home: '/tmp/target/runtime-home',
    configHome: '/tmp/target/runtime-home/.config',
    dataHome: '/tmp/target/runtime-home/.local/share',
    cacheHome: '/tmp/target/runtime-home/.cache',
    stateHome: '/tmp/target/runtime-home/.local/state',
  })

  assert.equal(
    mapPhase0PortableEntryPath({
      path: '/tmp/source/runtime-home/.local/share/opencode',
      sourceArtifactDir: '/tmp/source/artifacts',
      sourceMetadataPath: '/tmp/source/sessions.json',
      sourceRuntimePaths,
      sourceWorkspaceDir: '/tmp/source/workspace',
      targetArtifactDir: '/tmp/target/artifacts',
      targetMetadataPath: '/tmp/target/sessions.json',
      targetRuntimePaths,
      targetWorkspaceDir: '/tmp/target/workspace',
    }),
    '/tmp/target/runtime-home/.local/share/opencode',
  )

  assert.equal(
    mapPhase0PortableEntryPath({
      path: join('/tmp/source/workspace', 'README.md'),
      sourceArtifactDir: '/tmp/source/artifacts',
      sourceMetadataPath: '/tmp/source/sessions.json',
      sourceRuntimePaths,
      sourceWorkspaceDir: '/tmp/source/workspace',
      targetArtifactDir: '/tmp/target/artifacts',
      targetMetadataPath: '/tmp/target/sessions.json',
      targetRuntimePaths,
      targetWorkspaceDir: '/tmp/target/workspace',
    }),
    '/tmp/target/workspace/README.md',
  )
})

test('phase0 proof snapshot digest compares the SDK surfaces used for reopen', () => {
  const snapshot = {
    session: { id: 'session-1', title: 'Phase 0' },
    messages: [{
      info: { id: 'message-1', role: 'user' },
      parts: [{ type: 'text', text: 'hello' }],
    }],
    todos: [],
    children: [],
    permissions: [],
    questions: [],
  }

  assert.deepEqual(digestSdkSnapshot(snapshot), {
    sessionId: 'session-1',
    title: 'Phase 0',
    messages: [{ id: 'message-1', role: 'user', text: 'hello' }],
    todos: [],
    childCount: 0,
    permissionCount: 0,
    questionCount: 0,
  })
  assert.doesNotThrow(() => assertPhase0SnapshotsMatch(snapshot, structuredClone(snapshot)))
  assert.throws(() => assertPhase0SnapshotsMatch(snapshot, {
    ...snapshot,
    messages: [],
  }), /Expected values to be strictly deep-equal/)
})
