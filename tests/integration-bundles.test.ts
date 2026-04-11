import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_INTEGRATION_BUNDLES } from '../apps/desktop/src/main/integration-bundles.ts'

test('github bundle is disabled by default and uses a token-backed hosted MCP', () => {
  const github = BUILTIN_INTEGRATION_BUNDLES.find((bundle) => bundle.id === 'github')

  assert.ok(github)
  assert.equal(github.enabledByDefault, false)
  assert.equal(github.skills.length, 0)
  assert.equal(github.credentials?.[0]?.key, 'githubToken')

  const mcp = github.mcps[0]
  assert.equal(mcp.name, 'github')
  assert.equal(mcp.authMode, 'api_token')
  assert.equal(mcp.url, 'https://api.githubcopilot.com/mcp/')
  assert.equal(mcp.headers?.['X-MCP-Toolsets'], 'repos,issues,pull_requests,actions,code_security,secret_protection,projects,users,orgs')
  assert.deepEqual(mcp.headerSettings, [
    { header: 'Authorization', key: 'githubToken', prefix: 'Bearer ' },
  ])
})
