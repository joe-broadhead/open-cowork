import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentFromArtifact, buildChartRerenderPrompt } from '../apps/desktop/src/renderer/components/chat/composer-events.ts'

test('attachmentFromArtifact marks image payloads as previewable composer attachments', () => {
  const attachment = attachmentFromArtifact({
    mime: 'image/png',
    url: 'data:image/png;base64,abc123',
    filename: 'chart.png',
  })

  assert.deepEqual(attachment, {
    mime: 'image/png',
    url: 'data:image/png;base64,abc123',
    filename: 'chart.png',
    preview: 'data:image/png;base64,abc123',
  })
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
