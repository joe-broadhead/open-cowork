import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SessionView, ToolCall } from '@open-cowork/shared'
import {
  buildSyntheticSessionDiffs,
  mergeSessionDiffsWithSynthetic,
  normalizeSessionFileDiffs,
  summarizeSessionDiffs,
} from '../apps/desktop/src/main/session-diff-fallback.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function createEmptyView(toolCalls: ToolCall[]): SessionView {
  return {
    messages: [],
    toolCalls,
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

test('buildSyntheticSessionDiffs turns write artifacts into added-file diffs', () => {
  const root = testTempDir('open-cowork-diff-')
  try {
    const reportPath = join(root, 'report.md')
    writeFileSync(reportPath, '# Report\n\nHello\n')

    const diffs = buildSyntheticSessionDiffs(createEmptyView([
      {
        id: 'tool-1',
        name: 'write',
        input: { filePath: reportPath },
        status: 'complete',
        order: 10,
      },
    ]), root)

    assert.equal(diffs.length, 1)
    assert.equal(diffs[0]?.file, 'report.md')
    assert.equal(diffs[0]?.status, 'added')
    assert.equal(diffs[0]?.source, 'synthetic')
    assert.equal(diffs[0]?.synthetic, true)
    assert.equal(diffs[0]?.deletions, 0)
    assert.equal(diffs[0]?.additions, 3)
    assert.match(diffs[0]?.patch || '', /^@@ -0,0 \+1,3 @@/)
    assert.match(diffs[0]?.patch || '', /\+# Report/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildSyntheticSessionDiffs ignores write artifacts outside the session root', () => {
  const root = testTempDir('open-cowork-diff-root-')
  const outside = testTempDir('open-cowork-diff-outside-')
  try {
    const outsidePath = join(outside, 'secret.txt')
    writeFileSync(outsidePath, 'nope\n')

    const diffs = buildSyntheticSessionDiffs(createEmptyView([
      {
        id: 'tool-1',
        name: 'write',
        input: { filePath: outsidePath },
        status: 'complete',
        order: 1,
      },
    ]), root)

    assert.deepEqual(diffs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('mergeSessionDiffsWithSynthetic appends write-only files without duplicating SDK diffs', () => {
  const root = testTempDir('open-cowork-diff-merge-')
  try {
    const reportPath = join(root, 'report.md')
    writeFileSync(reportPath, '# Report\n')

    const merged = mergeSessionDiffsWithSynthetic([
      {
        file: 'existing.md',
        patch: '@@ -1,1 +1,1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
        status: 'modified',
      },
      {
        file: 'report.md',
        patch: '@@ -1,1 +1,1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
        status: 'modified',
      },
    ], createEmptyView([
      {
        id: 'tool-1',
        name: 'write',
        input: { filePath: reportPath },
        status: 'complete',
        order: 1,
      },
    ]), root)

    assert.equal(merged.length, 2)
    assert.deepEqual(merged.map((diff) => diff.file), ['existing.md', 'report.md'])
    assert.equal(merged[0]?.source, undefined)
    assert.equal(merged[1]?.source, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeSessionFileDiffs drops SDK entries without file paths', () => {
  assert.deepEqual(normalizeSessionFileDiffs([
    {
      file: 'src/app.ts',
      patch: '@@ -1,1 +1,1 @@',
      additions: 1.8,
      deletions: -2,
      status: 'modified',
    },
    {
      patch: '@@ -1,1 +1,1 @@',
      additions: 1,
      deletions: 0,
    },
    null,
    {
      file: '   ',
      patch: '',
    },
  ]), [
    {
      file: 'src/app.ts',
      patch: '@@ -1,1 +1,1 @@',
      additions: 1,
      deletions: 0,
      source: 'sdk',
      status: 'modified',
    },
  ])
})

test('summarizeSessionDiffs returns authoritative aggregate sidebar stats', () => {
  assert.deepEqual(summarizeSessionDiffs([
    {
      file: 'a.md',
      patch: '',
      additions: 3,
      deletions: 0,
      status: 'added',
    },
    {
      file: 'b.md',
      patch: '',
      additions: 1,
      deletions: 2,
      status: 'modified',
    },
  ]), {
    additions: 4,
    deletions: 2,
    files: 2,
  })
  assert.equal(summarizeSessionDiffs([]), null)
})

test('summarizeSessionDiffs labels synthetic and mixed projection fallback stats', () => {
  assert.deepEqual(summarizeSessionDiffs([
    {
      file: 'generated.md',
      patch: '',
      additions: 2,
      deletions: 0,
      status: 'added',
      source: 'synthetic',
      synthetic: true,
    },
  ]), {
    additions: 2,
    deletions: 0,
    files: 1,
    source: 'synthetic',
    synthetic: true,
  })

  assert.deepEqual(summarizeSessionDiffs([
    {
      file: 'real.md',
      patch: '',
      additions: 1,
      deletions: 1,
      status: 'modified',
      source: 'sdk',
    },
    {
      file: 'generated.md',
      patch: '',
      additions: 2,
      deletions: 0,
      status: 'added',
      source: 'synthetic',
      synthetic: true,
    },
  ]), {
    additions: 3,
    deletions: 1,
    files: 2,
    source: 'mixed',
    synthetic: true,
  })
})
