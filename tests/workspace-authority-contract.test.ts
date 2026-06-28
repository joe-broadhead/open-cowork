import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

test('workspace support contract is shared instead of duplicated by Desktop surfaces', () => {
  const gatewaySource = read('apps/desktop/src/main/workspace-gateway.ts')
  const rendererSupport = read('packages/app/src/stores/workspace-support.ts')
  const sharedWorkspace = read('packages/shared/src/workspace.ts')

  assert.match(gatewaySource, /WORKSPACE_SUPPORT_APIS/)
  assert.doesNotMatch(gatewaySource, /const WORKSPACE_SUPPORT_APIS = \[/)
  assert.match(rendererSupport, /export \{ WORKSPACE_SUPPORT_APIS \} from '@open-cowork\/shared'/)
  assert.match(rendererSupport, /supportContext/)
  assert.match(rendererSupport, /canExposeLocalPaths/)
  assert.doesNotMatch(rendererSupport, /workspace\.kind === 'cloud'/)
  for (const api of [
    'coordination.projects',
    'coordination.tasks',
    'coordination.runs',
    'coordination.schedules',
    'coordination.watches',
    'coordination.delegation',
  ]) {
    assert.match(sharedWorkspace, new RegExp(api.replace('.', '\\.')))
    assert.match(gatewaySource, new RegExp(api.replace('.', '\\.')))
  }
})

test('renderer project entry gates host-path exposure through authority support', () => {
  const newThreadButton = read('packages/app/src/components/sidebar/NewThreadButton.tsx')

  assert.match(newThreadButton, /canExposeLocalPaths/)
  assert.doesNotMatch(
    newThreadButton,
    /const projectDisabled = activeWorkspaceIsLocal\s*\?/,
    'project path actions must use authority path-exposure support, not workspace kind/id branching',
  )
  assert.match(newThreadButton, /workspaceSupportState\.flags\.canExposeLocalPaths/)
})
