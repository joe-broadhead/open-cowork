import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceNavigationUserMessage } from '../packages/app/src/helpers/resource-navigation-copy.ts'

test('resource navigation maps technical status to recovery copy (JOE-891)', () => {
  assert.match(resourceNavigationUserMessage('not_found'), /not found/i)
  assert.match(resourceNavigationUserMessage('forbidden'), /do not have access/i)
  assert.match(resourceNavigationUserMessage('offline'), /Health Center/i)
  assert.match(resourceNavigationUserMessage('weird_code'), /weird_code/)
})
