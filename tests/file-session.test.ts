import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { registerSessionFileHandlers } from '../apps/desktop/src/main/ipc/session-file-handlers.ts'

type SnippetRequest = {
  sessionId: string
  filePath: string
  startLine: number
  endLine: number
}

function createFileSessionHarness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-data-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-root-'))
  const sessionId = `file-session-${Date.now()}-${Math.random().toString(16).slice(2)}`
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearSessionRegistryCache()
  upsertSessionRecord(toSessionRecord({
    id: sessionId,
    title: 'File session',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    opencodeDirectory: workspaceRoot,
  }))
  registerSessionFileHandlers({
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => any) {
        handlers.set(channel, handler)
      },
    },
  } as any)
  const readSnippet = (request: Omit<SnippetRequest, 'sessionId'>) => {
    const handler = handlers.get('session:file-snippet')
    assert.ok(handler, 'expected session:file-snippet handler to be registered')
    return handler({}, { sessionId, ...request }) as Promise<string[]>
  }
  const cleanup = () => {
    clearSessionRegistryCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
  return { workspaceRoot, readSnippet, cleanup }
}

test('file sessions read only bounded text snippets inside the session workspace', async () => {
  const harness = createFileSessionHarness()
  try {
    writeFileSync(join(harness.workspaceRoot, 'notes.txt'), 'one\ntwo\nthree\n')
    assert.deepEqual(await harness.readSnippet({
      filePath: 'notes.txt',
      startLine: 2,
      endLine: 20,
    }), ['two', 'three', ''])
  } finally {
    harness.cleanup()
  }
})

test('file sessions reject traversal outside the session workspace', async () => {
  const harness = createFileSessionHarness()
  const outside = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    await assert.rejects(
      () => harness.readSnippet({
        filePath: join('..', '..', outside, 'secret.txt'),
        startLine: 1,
        endLine: 1,
      }),
      /escapes the session directory|not available/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
    harness.cleanup()
  }
})

test('file sessions reject symlink escapes outside the session workspace', { skip: process.platform === 'win32' }, async () => {
  const harness = createFileSessionHarness()
  const outside = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(harness.workspaceRoot, 'secret-link.txt'))
    await assert.rejects(
      () => harness.readSnippet({
        filePath: 'secret-link.txt',
        startLine: 1,
        endLine: 1,
      }),
      /escapes the session directory/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
    harness.cleanup()
  }
})

test('file sessions reject binary snippets and cap line expansion', async () => {
  const harness = createFileSessionHarness()
  try {
    writeFileSync(join(harness.workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await assert.rejects(
      () => harness.readSnippet({
        filePath: 'binary.bin',
        startLine: 1,
        endLine: 1,
      }),
      /Binary files/,
    )

    mkdirSync(join(harness.workspaceRoot, 'src'))
    writeFileSync(join(harness.workspaceRoot, 'src', 'many.txt'), Array.from({ length: 600 }, (_, index) => `line-${index + 1}`).join('\n'))
    const lines = await harness.readSnippet({
      filePath: 'src/many.txt',
      startLine: 1,
      endLine: 10_000,
    })
    assert.equal(lines.length, 500)
    assert.equal(lines[499], 'line-500')
  } finally {
    harness.cleanup()
  }
})
