import test from 'node:test'
import assert from 'node:assert/strict'
import { sdkErrorMessage } from '../apps/desktop/src/main/sdk-error.ts'

test('sdkErrorMessage prefers nested SDK cause message', () => {
  assert.equal(
    sdkErrorMessage({
      cause: { message: 'provider rejected request' },
      message: 'top-level wrapper',
    }),
    'provider rejected request',
  )
})

test('sdkErrorMessage falls back through SDK cause body, top-level message, and fallback', () => {
  assert.equal(
    sdkErrorMessage({ cause: { body: { error: 'invalid model' } } }),
    '{"error":"invalid model"}',
  )
  assert.equal(sdkErrorMessage({ message: 'request failed' }), 'request failed')
  assert.equal(sdkErrorMessage(null, 'fallback message'), 'fallback message')
})
