import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('cloud client package is standalone and desktop transport is a compatibility re-export', () => {
  const root = process.cwd()
  const packageJson = JSON.parse(readFileSync(join(root, 'packages/cloud-client/package.json'), 'utf8')) as {
    name?: string
  }
  const clientSource = readFileSync(join(root, 'packages/cloud-client/src/index.ts'), 'utf8')
  const desktopTransport = readFileSync(join(root, 'apps/desktop/src/main/cloud/transport-adapter.ts'), 'utf8')

  assert.equal(packageJson.name, '@open-cowork/cloud-client')
  assert.doesNotMatch(clientSource, /apps\/desktop|control-plane-store|session-service/)
  assert.equal(desktopTransport.trim(), "export * from '../../../../../packages/cloud-client/src/index.ts'")
})
