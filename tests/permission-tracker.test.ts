import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearPermission,
  clearPermissionsForSession,
  getPermissionSession,
  trackPermission,
} from '../apps/desktop/src/main/permission-tracker.ts'

test('permission tracker stores and clears entries', () => {
  trackPermission('perm-1', 'session-1')
  assert.equal(getPermissionSession('perm-1'), 'session-1')

  clearPermission('perm-1')
  assert.equal(getPermissionSession('perm-1'), null)
})

test('permission tracker clears all permissions for a session', () => {
  trackPermission('perm-a', 'session-a')
  trackPermission('perm-b', 'session-a')
  trackPermission('perm-c', 'session-c')

  clearPermissionsForSession('session-a')

  assert.equal(getPermissionSession('perm-a'), null)
  assert.equal(getPermissionSession('perm-b'), null)
  assert.equal(getPermissionSession('perm-c'), 'session-c')

  clearPermission('perm-c')
})

test('permission tracker bounds memory by evicting the oldest entries (P3-13)', () => {
  // Far exceed the cap with permissions that are never explicitly cleared (auto-resolved/superseded).
  for (let index = 0; index < 1_200; index += 1) {
    trackPermission(`leak-${index}`, `session-${index}`)
  }
  // The oldest entries are evicted; the most recent survive.
  assert.equal(getPermissionSession('leak-0'), null)
  assert.equal(getPermissionSession('leak-1199'), 'session-1199')
  clearPermissionsForSession('session-1199')
})
