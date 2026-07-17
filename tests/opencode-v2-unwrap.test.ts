import test from 'node:test'
import assert from 'node:assert/strict'
import { unwrapNativeData } from '../packages/runtime-host/src/opencode-v2.ts'

test('unwrapNativeData peels the SDK V2 double data envelope', () => {
  const payload = { id: 'ses_1', title: 'hello' }
  assert.deepEqual(unwrapNativeData({ data: { data: payload } }), payload)
})

test('unwrapNativeData rejects missing outer data', () => {
  assert.throws(() => unwrapNativeData({}), /invalid data payload/)
})

test('unwrapNativeData rejects missing inner data', () => {
  assert.throws(() => unwrapNativeData({ data: {} }), /did not contain data/)
})

test('unwrapNativeData rejects non-objects', () => {
  assert.throws(() => unwrapNativeData(null), /invalid response envelope/)
  assert.throws(() => unwrapNativeData([]), /invalid response envelope/)
})
