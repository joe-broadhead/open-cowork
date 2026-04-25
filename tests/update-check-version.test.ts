import assert from 'node:assert/strict'
import test from 'node:test'
import { compareVersions } from '../apps/desktop/src/main/update-check.ts'

test('compareVersions treats v-prefixed and bare versions identically', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('V2.0.0', 'v2.0.0'), 0)
})

test('compareVersions orders semver core numerically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1, 'handles double-digit minor')
  assert.equal(compareVersions('1.10.0', '1.9.0-rc.1'), 1, 'handles double-digit minor against prerelease')
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
})

test('compareVersions follows semver prerelease ordering', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.1'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.1'), 1)
})

test('compareVersions handles missing segments gracefully', () => {
  assert.equal(compareVersions('1', '1.0.0'), 0)
  assert.equal(compareVersions('1.0', '1.0.1'), -1)
})
