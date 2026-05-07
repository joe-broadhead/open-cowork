import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('resetAppData wipes user data and sandbox roots from explicit test directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-reset-'))
  const userDataDir = join(root, 'user-data')
  const sandboxDir = join(root, 'sandbox')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousSandboxDir = process.env.OPEN_COWORK_SANDBOX_DIR

  try {
    mkdirSync(userDataDir, { recursive: true })
    mkdirSync(sandboxDir, { recursive: true })
    writeFileSync(join(userDataDir, 'settings.enc'), 'secret settings')
    writeFileSync(join(sandboxDir, 'workspace.txt'), 'sandbox content')

    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    process.env.OPEN_COWORK_SANDBOX_DIR = sandboxDir

    const { resetAppData } = await import('../apps/desktop/src/main/app-reset.ts')
    const result = resetAppData()

    assert.deepEqual(new Set(result.removedPaths), new Set([userDataDir, sandboxDir]))
    assert.deepEqual(result.failedPaths, [])
    assert.equal(existsSync(userDataDir), false)
    assert.equal(existsSync(sandboxDir), false)
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    if (previousSandboxDir === undefined) delete process.env.OPEN_COWORK_SANDBOX_DIR
    else process.env.OPEN_COWORK_SANDBOX_DIR = previousSandboxDir
    rmSync(root, { recursive: true, force: true })
  }
})
