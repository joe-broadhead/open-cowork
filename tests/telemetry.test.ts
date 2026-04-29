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

test('telemetry payload sanitization handles cyclic and oversized payloads', () => {
  const payload: Record<string, unknown> = { label: 'root' }
  payload.self = payload
  let cursor = payload
  for (let index = 0; index < 32; index += 1) {
    const next: Record<string, unknown> = { index }
    cursor.next = next
    cursor = next
  }
  payload.values = Array.from({ length: 150 }, (_, index) => `value-${index}`)
  payload.large = 'x'.repeat(5000)

  const sanitized = sanitizeTelemetryPayload(payload) as Record<string, any>

  assert.equal(sanitized.self, '[Telemetry payload omitted: circular reference]')
  assert.equal(sanitized.values.length, 101)
  assert.match(sanitized.values.at(-1), /Telemetry payload truncated: 50 array items/)
  assert.equal(sanitized.large.length, 4000)
})
