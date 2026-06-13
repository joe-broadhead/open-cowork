import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeArtifactOpenTarget } from '../packages/shared/dist/index.js'

test('artifact open policy allows passive documents and blocks active file types', () => {
  assert.equal(isSafeArtifactOpenTarget({ filename: 'report.md', mime: 'text/markdown' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'report.md', mime: 'text/markdown; charset=utf-8' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'report.md', mime: 'application/octet-stream' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'data.json', mime: 'application/json; charset=utf-8' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'chart.png', mime: 'image/png' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'summary.pdf', mime: 'application/pdf' }), true)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'spreadsheet.csv', mime: 'text/csv' }), false)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'spreadsheet.tsv', mime: 'text/tab-separated-values' }), false)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'run.command', mime: 'text/plain' }), false)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'page.html', mime: 'text/html' }), false)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'vector.svg', mime: 'image/svg+xml' }), false)
  assert.equal(isSafeArtifactOpenTarget({ filename: 'artifact', mime: 'text/plain' }), false)
})
