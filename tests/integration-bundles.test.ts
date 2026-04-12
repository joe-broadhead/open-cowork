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

test('perplexity bundle is disabled by default and uses an api-key-backed local MCP command', () => {
  const perplexity = BUILTIN_INTEGRATION_BUNDLES.find((bundle) => bundle.id === 'perplexity')

  assert.ok(perplexity)
  assert.equal(perplexity.enabledByDefault, false)
  assert.equal(perplexity.skills.length, 0)
  assert.equal(perplexity.credentials?.[0]?.key, 'perplexityApiKey')

  const mcp = perplexity.mcps[0]
  assert.equal(mcp.name, 'perplexity')
  assert.equal(mcp.authMode, 'api_token')
  assert.deepEqual(mcp.command, ['npx', '-y', '@perplexity-ai/mcp-server'])
  assert.deepEqual(mcp.envSettings, [
    { env: 'PERPLEXITY_API_KEY', key: 'perplexityApiKey' },
  ])
})
