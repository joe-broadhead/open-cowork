import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveToolStatus } from '../packages/shared/src/runtime-event-normalizers.ts'

test('deriveToolStatus is consistent across live + history paths (P2)', () => {
  // Error wins, even with output.
  assert.equal(deriveToolStatus({ hasOutput: true, hasError: true }), 'error')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: true }), 'error')
  // Output (or an explicit completed status) → complete.
  assert.equal(deriveToolStatus({ hasOutput: true, hasError: false }), 'complete')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: false, statusHint: 'completed' }), 'complete')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: false, statusHint: 'complete' }), 'complete')
  // Neither output nor error → still running (the history-replay bug previously returned 'complete').
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: false }), 'running')
  assert.equal(deriveToolStatus({ hasOutput: false, hasError: false, statusHint: 'running' }), 'running')
})
