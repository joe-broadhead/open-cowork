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
