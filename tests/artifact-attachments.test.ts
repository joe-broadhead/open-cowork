import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArtifactAttachmentPayload, inferArtifactMime } from '../apps/desktop/src/main/artifact-attachments.ts'
import { saveChartArtifact } from '../apps/desktop/src/main/chart-artifacts.ts'

const ONE_PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

test('inferArtifactMime recognizes common chart and text artifact extensions', () => {
  assert.equal(inferArtifactMime('/tmp/chart.png'), 'image/png')
  assert.equal(inferArtifactMime('/tmp/notes.md'), 'text/markdown')
  assert.equal(inferArtifactMime('/tmp/report.csv'), 'text/csv')
  assert.equal(inferArtifactMime('/tmp/blob.bin'), 'application/octet-stream')
})

test('buildArtifactAttachmentPayload returns a data-url attachment for generic artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-attachment-'))
  try {
    const filePath = join(root, 'summary.txt')
    writeFileSync(filePath, 'hello world', 'utf-8')

    const attachment = buildArtifactAttachmentPayload(filePath)

    assert.equal(attachment.mime, 'text/plain')
    assert.equal(attachment.filename, 'summary.txt')
    assert.match(attachment.url, /^data:text\/plain;base64,/)
    assert.equal(attachment.chart, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildArtifactAttachmentPayload includes saved chart metadata when present', () => {
  const sessionId = 'sess-test-attachment-meta-' + Date.now()
  const artifact = saveChartArtifact({
    sessionId,
    toolCallId: 'tool-attachment-meta',
    toolName: 'render_chart',
    dataUrl: ONE_PX_PNG,
    chart: {
      format: 'vega',
      title: 'Latency distribution',
      spec: {
        marks: [{ type: 'rect' }],
      },
    },
  })

  try {
    const attachment = buildArtifactAttachmentPayload(artifact.filePath)
    assert.equal(attachment.mime, 'image/png')
    assert.equal(attachment.filename, artifact.filename)
    assert.equal(attachment.chart?.format, 'vega')
    assert.equal(attachment.chart?.title, 'Latency distribution')
    assert.deepEqual(attachment.chart?.spec, {
      marks: [{ type: 'rect' }],
    })
  } finally {
    rmSync(dirname(artifact.filePath), { recursive: true, force: true })
  }
})
