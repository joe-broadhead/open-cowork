import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOMATION_CONSECUTIVE_FAILURE_LIMIT,
  classifyAutomationFailure,
} from '../apps/desktop/src/main/automation-failure-policy.ts'

test('classifyAutomationFailure marks parseable-brief failures as deterministic', () => {
  assert.deepEqual(
    classifyAutomationFailure({
      code: 'brief_unparseable',
      message: 'Automation enrichment did not return a parseable execution brief.',
    }),
    {
      code: 'brief_unparseable',
      retryable: false,
      reason: 'The automation output was not parseable and needs prompt or task changes.',
    },
  )
})

test('classifyAutomationFailure keeps network/rate-limit issues retryable', () => {
  assert.equal(classifyAutomationFailure('Provider rate limit hit, try again later.').code, 'provider_capacity')
  assert.equal(classifyAutomationFailure('Fetch failed: socket hang up').code, 'network_transient')
})

test('AUTOMATION_CONSECUTIVE_FAILURE_LIMIT stays pinned at 3', () => {
  assert.equal(AUTOMATION_CONSECUTIVE_FAILURE_LIMIT, 3)
})
