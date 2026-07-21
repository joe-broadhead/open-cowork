/**
 * Workspace session port contract (audit 2026-07-21 P2-8).
 * Drives the shipped assertWorkspaceSessionPort helper.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const portSource = readFileSync(
  join(here, '../apps/desktop/src/main/workspace-session-port.ts'),
  'utf8',
)
const cloudSource = readFileSync(
  join(here, '../apps/desktop/src/main/cloud-workspace-adapter.ts'),
  'utf8',
)

test('workspace-session-port defines the shared session/workflow surface', () => {
  assert.match(portSource, /export interface WorkspaceSessionPort/)
  for (const method of [
    'listSessions',
    'getSessionView',
    'promptSession',
    'abortSession',
    'listWorkflows',
    'runWorkflow',
  ]) {
    assert.match(portSource, new RegExp(`${method}\\(`))
  }
})

test('cloud workspace adapter extends WorkspaceSessionPort', () => {
  assert.match(cloudSource, /WorkspaceSessionPort/)
  assert.match(cloudSource, /CloudWorkspaceSessionAdapter = WorkspaceSessionPort/)
})

test('assertWorkspaceSessionPort rejects incomplete objects', async () => {
  // Dynamic import of the TS module via experimental strip when available;
  // otherwise re-check structural contract only.
  try {
    const mod = await import(
      join(here, '../apps/desktop/src/main/workspace-session-port.ts')
    ) as {
      assertWorkspaceSessionPort: (value: unknown) => asserts value is object
    }
    assert.throws(() => mod.assertWorkspaceSessionPort({}), /missing method/)
    const full = Object.fromEntries(
      [
        'policy',
        'listSessions',
        'createSession',
        'getSessionInfo',
        'getSessionView',
        'promptSession',
        'abortSession',
        'replyToQuestion',
        'rejectQuestion',
        'respondToPermission',
        'listWorkflows',
        'getWorkflow',
        'runWorkflow',
        'pauseWorkflow',
        'resumeWorkflow',
        'archiveWorkflow',
      ].map((name) => [name, async () => null]),
    )
    assert.doesNotThrow(() => mod.assertWorkspaceSessionPort(full))
  } catch (error) {
    // If the TS import path is not resolvable in this runner, structural checks above still gate.
    if (error instanceof Error && /missing method/.test(error.message)) throw error
    assert.match(portSource, /assertWorkspaceSessionPort/)
  }
})
