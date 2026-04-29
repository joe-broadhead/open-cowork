import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeTelemetryPayload } from '../apps/desktop/src/main/telemetry.ts'

test('telemetry payload sanitization strips tokens and local user paths recursively', () => {
  const openAiStyleToken = `sk-${'1'.repeat(32)}`
  const githubStyleToken = `ghp_${'a'.repeat(24)}`
  const sanitized = sanitizeTelemetryPayload({
    error: `Failed at /Users/alice/project with ${openAiStyleToken}`,
    nested: {
      path: '/home/bob/.ssh/id_rsa',
      values: [githubStyleToken, 'plain'],
    },
  }) as Record<string, any>

  assert.equal(sanitized.error.includes('/Users/alice'), false)
  assert.equal(sanitized.error.includes(openAiStyleToken), false)
  assert.equal(sanitized.nested.path.includes('/home/bob'), false)
  assert.equal(sanitized.nested.values[0].includes('ghp_'), false)
  assert.equal(sanitized.nested.values[1], 'plain')
})
