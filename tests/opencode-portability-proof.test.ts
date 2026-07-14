import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  assertPortabilitySnapshotsMatch,
  digestSdkSnapshot,
  mapPortableEntryPath,
} from '../scripts/opencode-portability-proof.ts'
import { runtimePathsForPortability } from '@open-cowork/cloud-server/runtime-snapshot-portability'

test('OpenCode portability proof maps portable runtime paths into a separate restore root', () => {
  const sourceRuntimePaths = runtimePathsForPortability({
    home: '/tmp/source/runtime-home',
    configHome: '/tmp/source/runtime-home/.config',
    dataHome: '/tmp/source/runtime-home/.local/share',
    cacheHome: '/tmp/source/runtime-home/.cache',
    stateHome: '/tmp/source/runtime-home/.local/state',
  })
  const targetRuntimePaths = runtimePathsForPortability({
    home: '/tmp/target/runtime-home',
    configHome: '/tmp/target/runtime-home/.config',
    dataHome: '/tmp/target/runtime-home/.local/share',
    cacheHome: '/tmp/target/runtime-home/.cache',
    stateHome: '/tmp/target/runtime-home/.local/state',
  })

  assert.equal(
    mapPortableEntryPath({
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
    mapPortableEntryPath({
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

test('OpenCode portability proof snapshot digest compares the SDK surfaces used for reopen', () => {
  const snapshot = {
    session: { id: 'session-1', title: 'Portability proof' },
    messages: [{
      id: 'message-1',
      type: 'user',
      text: 'hello',
    }],
    history: [{
      type: 'session.next.prompt.admitted',
      data: {
        messageID: 'message-1',
        prompt: { text: 'hello' },
        delivery: 'queue',
      },
    }],
    children: [],
    permissions: [],
    questions: [],
  }

  assert.deepEqual(digestSdkSnapshot(snapshot), {
    sessionId: 'session-1',
    title: 'Portability proof',
    messages: [{ id: 'message-1', role: 'user', text: 'hello' }],
    promptAdmissions: [{ messageId: 'message-1', text: 'hello', delivery: 'queue' }],
    childCount: 0,
    permissionCount: 0,
    questionCount: 0,
  })
  assert.doesNotThrow(() => assertPortabilitySnapshotsMatch(snapshot, structuredClone(snapshot)))
  assert.throws(() => assertPortabilitySnapshotsMatch(snapshot, {
    ...snapshot,
    messages: [],
  }), /Expected values to be strictly deep-equal/)
})
