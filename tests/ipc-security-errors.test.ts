import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IpcSecurityError,
  ipcSecurityUserMessage,
  isIpcSecurityError,
} from '../packages/shared/src/ipc-security-errors.ts'
import { ProjectDirectoryGrantRegistry } from '../apps/desktop/src/main/directory-grants.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('IpcSecurityError serializes code and recovery (JOE-883)', () => {
  const err = new IpcSecurityError({
    code: 'MCP_POLICY_REJECTED',
    message: 'MCP blocked by policy.',
    recovery: 'Remove the server or ask an admin.',
  })
  assert.equal(err.code, 'MCP_POLICY_REJECTED')
  assert.equal(isIpcSecurityError(err), true)
  assert.match(ipcSecurityUserMessage(err.toJSON()), /ask an admin/)
})

test('directory grant denials use typed security codes (JOE-883)', () => {
  const registry = new ProjectDirectoryGrantRegistry()
  try {
    registry.resolve('/tmp/definitely-missing-open-cowork-grant-path')
    assert.fail('expected throw')
  } catch (error) {
    assert.equal(isIpcSecurityError(error), true)
    assert.equal((error as IpcSecurityError).code, 'DIRECTORY_GRANT_MISSING_PATH')
  }

  const root = mkdtempSync(join(tmpdir(), 'oc-grant-'))
  const file = join(root, 'file.txt')
  writeFileSync(file, 'x')
  try {
    try {
      registry.grant(file)
      assert.fail('expected not directory')
    } catch (error) {
      assert.equal((error as IpcSecurityError).code, 'DIRECTORY_GRANT_NOT_DIRECTORY')
    }
    // Grant the real directory, then resolve a sibling ungranted path under same parent
    // is not how grants work — resolve after grant on the directory itself succeeds.
    const granted = registry.grant(root)
    assert.equal(registry.resolve(granted), granted)
    // Clear by using a fresh registry without the grant
    const locked = new ProjectDirectoryGrantRegistry()
    try {
      locked.resolve(root)
      assert.fail('expected grant required')
    } catch (error) {
      assert.equal((error as IpcSecurityError).code, 'DIRECTORY_GRANT_REQUIRED')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
