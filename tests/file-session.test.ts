import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  catalogFileSession,
  createFileSession,
  readFileSessionBatch,
  writeFileSessionBatch,
} from '../apps/desktop/src/main/file-session.ts'

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'src', 'app.ts'), 'export const ok = true\n')
  writeFileSync(join(root, 'docs', 'report.md'), '# Report\n')
  writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=secret\n')
  return root
}

function contentRevision(content: string) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

test('file sessions catalog and read bounded workspace-relative files', async () => {
  const root = createWorkspace()
  try {
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'semantic-ui',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['src', 'docs'],
        limits: { maxFileBytes: 64, maxBatchBytes: 128 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    const catalog = await catalogFileSession(session, { now: new Date('2026-06-02T00:00:01.000Z') })
    assert.deepEqual(catalog.filter((entry) => entry.type === 'file').map((entry) => entry.path).sort(), [
      'docs/report.md',
      'src/app.ts',
    ])

    const reads = await readFileSessionBatch(session, ['src/app.ts', '../outside'], {
      now: new Date('2026-06-02T00:00:01.000Z'),
    })
    assert.equal(reads.results[0]?.ok, true)
    assert.equal(reads.results[0]?.content, 'export const ok = true\n')
    assert.equal(reads.results[1]?.ok, false)
    assert.equal(reads.results[1]?.reasonCode, 'path-escape-denied')
    assert.deepEqual(reads.auditEvents.map((event) => event.eventType), [
      'file-session.read',
      'file-session.read-denied',
    ])
    assert.equal(session.bytesRead, Buffer.byteLength('export const ok = true\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file sessions fail closed for sensitive paths, symlink escapes, and expiry', async () => {
  const root = createWorkspace()
  const outside = mkdtempSync(join(tmpdir(), 'open-cowork-file-session-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'secret\n')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'))

  try {
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'paired-readonly',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['.'],
        limits: { ttlMs: 1000, maxFileBytes: 64, maxBatchBytes: 128 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    const reads = await readFileSessionBatch(session, ['.env', 'linked-secret.txt'], {
      now: new Date('2026-06-02T00:00:00.500Z'),
    })
    assert.equal(reads.results[0]?.ok, false)
    assert.equal(reads.results[0]?.reasonCode, 'sensitive-path-denied')
    assert.equal(reads.results[1]?.ok, false)
    assert.equal(reads.results[1]?.reasonCode, 'symlink-denied')
    assert.equal(reads.auditEvents.every((event) => event.eventType === 'file-session.read-denied'), true)

    await assert.rejects(
      () => catalogFileSession(session, { now: new Date('2026-06-02T00:00:02.000Z') }),
      /expired/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('file sessions enforce idle timeout and audit expired access attempts', async () => {
  const root = createWorkspace()
  try {
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'paired-readonly',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['src'],
        limits: { ttlMs: 10_000, idleTtlMs: 1000, maxFileBytes: 64, maxBatchBytes: 128 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    await catalogFileSession(session, { now: new Date('2026-06-02T00:00:00.500Z') })
    const expiredRead = await readFileSessionBatch(session, ['src/app.ts'], {
      now: new Date('2026-06-02T00:00:02.000Z'),
    })

    assert.equal(expiredRead.results[0]?.ok, false)
    assert.equal(expiredRead.results[0]?.reasonCode, 'idle-timeout-expired')
    assert.equal(expiredRead.auditEvents[0]?.eventType, 'file-session.expired')
    assert.equal(expiredRead.auditEvents[0]?.reasonCode, 'idle-timeout-expired')
    await assert.rejects(
      () => catalogFileSession(session, { now: new Date('2026-06-02T00:00:02.000Z') }),
      /idle timeout/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file sessions write with exact revisions and emit redacted audit events', async () => {
  const root = createWorkspace()
  try {
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'workflow-preview',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['src', 'docs'],
        limits: { maxFileBytes: 128, maxBatchBytes: 256 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })
    const catalog = await catalogFileSession(session, { now: new Date('2026-06-02T00:00:01.000Z') })
    const currentRevision = catalog.find((entry) => entry.path === 'src/app.ts')?.revision
    assert.equal(currentRevision, contentRevision('export const ok = true\n'))

    const written = await writeFileSessionBatch(session, [
      {
        path: 'src/app.ts',
        content: 'export const ok = "updated"\n',
        expectedRevision: currentRevision,
      },
      {
        path: 'docs/new.md',
        content: '# New\n',
        expectedRevision: null,
      },
    ], { now: new Date('2026-06-02T00:00:02.000Z') })

    assert.deepEqual(written.results.map((result) => result.ok), [true, true])
    assert.deepEqual(written.auditEvents.map((event) => event.eventType), ['file-session.write', 'file-session.write'])
    assert.equal(written.auditEvents.every((event) => event.redacted), true)
    assert.equal(written.auditEvents[0]?.actorId, 'actor-1')

    const reads = await readFileSessionBatch(session, ['src/app.ts', 'docs/new.md'], {
      now: new Date('2026-06-02T00:00:03.000Z'),
    })
    assert.deepEqual(reads.results.map((result) => result.content), ['export const ok = "updated"\n', '# New\n'])
    assert.deepEqual(reads.auditEvents.map((event) => event.eventType), ['file-session.read', 'file-session.read'])

    const stale = await writeFileSessionBatch(session, [{
      path: 'src/app.ts',
      content: 'export const ok = false\n',
      expectedRevision: currentRevision,
    }], { now: new Date('2026-06-02T00:00:04.000Z') })
    assert.equal(stale.results[0]?.ok, false)
    assert.equal(stale.results[0]?.reasonCode, 'stale-revision')
    assert.equal(stale.auditEvents[0]?.eventType, 'file-session.write-denied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file sessions enforce total byte budget across reads and writes', async () => {
  const root = createWorkspace()
  try {
    const appBytes = Buffer.byteLength('export const ok = true\n')
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'workflow-preview',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['src', 'docs'],
        limits: { maxFileBytes: 128, maxBatchBytes: 256, maxSessionBytes: appBytes },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    const firstRead = await readFileSessionBatch(session, ['src/app.ts'], {
      now: new Date('2026-06-02T00:00:01.000Z'),
    })
    assert.equal(firstRead.results[0]?.ok, true)
    assert.equal(session.bytesRead, appBytes)

    const deniedWrite = await writeFileSessionBatch(session, [{
      path: 'docs/new.md',
      content: 'x',
      expectedRevision: null,
    }], { now: new Date('2026-06-02T00:00:02.000Z') })
    assert.equal(deniedWrite.results[0]?.ok, false)
    assert.equal(deniedWrite.results[0]?.reasonCode, 'session-byte-limit-exceeded')
    assert.equal(deniedWrite.auditEvents[0]?.eventType, 'file-session.write-denied')
    assert.equal(session.bytesWritten, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file session writes deny sensitive paths and oversized batches', async () => {
  const root = createWorkspace()
  try {
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'semantic-ui',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['.'],
        limits: { maxFileBytes: 8, maxBatchBytes: 12 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    const result = await writeFileSessionBatch(session, [
      {
        path: '.env',
        content: 'SAFE=0\n',
        expectedRevision: null,
      },
      {
        path: 'src/large.txt',
        content: '0123456789',
        expectedRevision: null,
      },
      {
        path: join(root, 'src', 'app.ts'),
        content: 'SAFE=1\n',
        expectedRevision: null,
      },
    ], { now: new Date('2026-06-02T00:00:01.000Z') })

    assert.deepEqual(result.results.map((entry) => entry.reasonCode), [
      'sensitive-path-denied',
      'file-too-large',
      'absolute-path-denied',
    ])
    assert.equal(result.auditEvents.every((event) => event.eventType === 'file-session.write-denied'), true)
    assert.equal(result.auditEvents[2]?.path, '[invalid-path]')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file session writes do not overwrite existing files without a bounded content revision', async () => {
  const root = createWorkspace()
  try {
    writeFileSync(join(root, 'src', 'huge.txt'), '0123456789')
    const session = createFileSession({
      workspaceId: 'workspace-1',
      actorId: 'actor-1',
      purpose: 'support-diagnostics',
      policy: {
        workspaceRoot: root,
        allowedPaths: ['src'],
        limits: { maxFileBytes: 8, maxBatchBytes: 16 },
      },
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    const catalog = await catalogFileSession(session, { now: new Date('2026-06-02T00:00:01.000Z') })
    const huge = catalog.find((entry) => entry.path === 'src/huge.txt')
    assert.equal(huge?.revision, null)
    assert.equal(huge?.reasonCode, 'file-too-large')

    const result = await writeFileSessionBatch(session, [{
      path: 'src/huge.txt',
      content: 'small\n',
      expectedRevision: null,
    }], { now: new Date('2026-06-02T00:00:02.000Z') })
    assert.equal(result.results[0]?.ok, false)
    assert.equal(result.results[0]?.reasonCode, 'current-file-too-large')
    assert.equal(result.auditEvents[0]?.path, 'src/huge.txt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
