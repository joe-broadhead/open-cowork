import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentFromArtifact, buildChartRerenderPrompt } from '../packages/app/src/components/chat/composer-events.ts'

test('attachmentFromArtifact marks image payloads as previewable composer attachments', () => {
  const attachment = attachmentFromArtifact({
    mime: 'image/png',
    url: 'data:image/png;base64,abc123',
    filename: 'chart.png',
  })

  assert.match(attachment.id, /^[-a-zA-Z0-9]+$/)
  assert.equal(attachment.mime, 'image/png')
  assert.equal(attachment.url, 'data:image/png;base64,abc123')
  assert.equal(attachment.filename, 'chart.png')
  assert.equal(attachment.preview, 'data:image/png;base64,abc123')
})

test('buildChartRerenderPrompt includes format, title, and exact spec JSON', () => {
  const prompt = buildChartRerenderPrompt({
    format: 'vega-lite',
    title: 'Sales trend',
    spec: {
      mark: 'line',
      encoding: {
        x: { field: 'month', type: 'ordinal' },
      },
    },
  })

  assert.match(prompt, /Sales trend/)
  assert.match(prompt, /Format: vega-lite/)
  assert.match(prompt, /"mark": "line"/)
  assert.match(prompt, /Please recreate or refine the attached chart/)
})
