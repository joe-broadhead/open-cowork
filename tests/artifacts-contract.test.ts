import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  canAdvanceArtifactStatus,
  defaultArtifactStatusForKind,
  inferArtifactKind,
  isArtifactKind,
  isArtifactStatus,
} from '../packages/shared/dist/index.js'

test('artifact lifecycle contract exposes stable statuses, kinds, and defaults', () => {
  assert.deepEqual([...ARTIFACT_STATUSES], ['draft', 'in-review', 'final'])
  assert.deepEqual([...ARTIFACT_KINDS], ['document', 'chart', 'deck', 'spreadsheet', 'draft'])
  assert.equal(isArtifactStatus('in-review'), true)
  assert.equal(isArtifactStatus('review'), false)
  assert.equal(isArtifactKind('spreadsheet'), true)
  assert.equal(isArtifactKind('table'), false)
  assert.equal(defaultArtifactStatusForKind('chart'), 'final')
  assert.equal(defaultArtifactStatusForKind('document'), 'draft')
  assert.equal(inferArtifactKind({ filename: 'report.md', mime: 'text/markdown' }), 'document')
  assert.equal(inferArtifactKind({ filename: 'board.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), 'deck')
  assert.equal(inferArtifactKind({ filename: 'forecast.csv', mime: 'text/csv' }), 'spreadsheet')
  assert.equal(inferArtifactKind({ filename: 'unknown.bin', mime: 'application/octet-stream' }), 'draft')
  assert.equal(canAdvanceArtifactStatus('draft', 'in-review'), true)
  assert.equal(canAdvanceArtifactStatus('in-review', 'final'), true)
  assert.equal(canAdvanceArtifactStatus('final', 'draft'), false)
})
