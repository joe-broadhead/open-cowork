import { existsSync, readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { saveChartArtifact, getChartArtifactsRoot } from '../apps/desktop/src/main/chart-artifacts.ts'

// 1x1 transparent PNG — minimal valid payload that's decoded and
// written verbatim by `saveChartArtifact`. Using a real PNG keeps
// the data-url shape check realistic.
const ONE_PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function cleanup(sessionId: string) {
  const root = getChartArtifactsRoot(sessionId)
  rmSync(root, { recursive: true, force: true })
}

test('saveChartArtifact writes a base64 PNG to a per-session root', () => {
  const sessionId = 'sess-test-write-' + Date.now()
  try {
    const artifact = saveChartArtifact({
      sessionId,
      toolCallId: 'tool-xyz-123',
      toolName: 'render_chart',
      dataUrl: ONE_PX_PNG,
      taskRunId: null,
    })

    assert.equal(artifact.toolId, 'tool-xyz-123')
    assert.equal(artifact.toolName, 'render_chart')
    assert.equal(artifact.filename, 'chart-tool-xyz-123.png')
    assert.ok(artifact.filePath.endsWith('/chart-tool-xyz-123.png'))
    assert.ok(existsSync(artifact.filePath))
    const written = readFileSync(artifact.filePath)
    assert.ok(written.length > 0)

    const root = getChartArtifactsRoot(sessionId)
    assert.ok(artifact.filePath.startsWith(root + '/'))
  } finally {
    cleanup(sessionId)
  }
})

test('saveChartArtifact rejects non-PNG data URLs', () => {
  assert.throws(() => saveChartArtifact({
    sessionId: 'sess-test-rejects',
    toolCallId: 'tool-1',
    toolName: 'render_chart',
    dataUrl: 'data:image/jpeg;base64,AAAA',
  }), /base64-encoded PNG/)
})

test('saveChartArtifact overwrites the same tool-call id idempotently', () => {
  const sessionId = 'sess-test-overwrite-' + Date.now()
  try {
    const first = saveChartArtifact({
      sessionId,
      toolCallId: 'repeat-tool',
      toolName: 'render_chart',
      dataUrl: ONE_PX_PNG,
    })
    const second = saveChartArtifact({
      sessionId,
      toolCallId: 'repeat-tool',
      toolName: 'render_chart',
      dataUrl: ONE_PX_PNG,
    })
    // Same file path — the toolCallId keys the filename, so repeat
    // captures overwrite rather than accumulate.
    assert.equal(first.filePath, second.filePath)
    assert.equal(first.filename, 'chart-repeat-tool.png')
  } finally {
    cleanup(sessionId)
  }
})

test('saveChartArtifact sanitizes unsafe characters in tool-call ids', () => {
  const sessionId = 'sess-test-sanitize-' + Date.now()
  try {
    const artifact = saveChartArtifact({
      sessionId,
      toolCallId: '../../evil/path?x=1',
      toolName: 'render_chart',
      dataUrl: ONE_PX_PNG,
    })
    assert.ok(!artifact.filename.includes('/'))
    assert.ok(!artifact.filename.includes('..'))
    assert.ok(artifact.filePath.endsWith(artifact.filename))
  } finally {
    cleanup(sessionId)
  }
})
