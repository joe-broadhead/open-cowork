import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWLEDGE_AGENT_TOKEN_TTL_MS,
  signKnowledgeAgentToken,
  verifyKnowledgeAgentToken,
} from '@open-cowork/cloud-server/knowledge-agent-token'
import {
  KNOWLEDGE_AGENT_ROUTE_BASE_PATH,
  applyKnowledgeAgentRuntimeAugmentation,
  buildKnowledgeAgentRuntimeAugmentation,
} from '@open-cowork/cloud-server/knowledge-agent-runtime'

const SIGNING_KEY = 'knowledge-agent-signing-secret-key'
const EXP = 2_000_000_000_000

test('knowledge agent token round-trips a tenant+session-bound payload before expiry', () => {
  const token = signKnowledgeAgentToken(SIGNING_KEY, {
    tenantId: 'tenant-1', sessionId: 'session-1', exp: EXP,
  })
  assert.deepEqual(verifyKnowledgeAgentToken(SIGNING_KEY, token, EXP - 1000), {
    tenantId: 'tenant-1', sessionId: 'session-1', exp: EXP,
  })
})

test('knowledge agent token rejects expiry, wrong secret, tampering, and malformed input', () => {
  const token = signKnowledgeAgentToken(SIGNING_KEY, {
    tenantId: 'tenant-1', sessionId: 'session-1', exp: EXP,
  })

  // Expired (exp boundary is exclusive — at-exp is already expired).
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, token, EXP), null)
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, token, EXP + 1), null)
  // Wrong signing secret.
  assert.equal(verifyKnowledgeAgentToken('a-different-secret-key', token, EXP - 1), null)
  // An empty secret must never validate a token signed with a real secret.
  assert.equal(verifyKnowledgeAgentToken('', token, EXP - 1), null)

  // Tampered payload (retarget to another tenant) keeps the old signature → rejected.
  const [, signature] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({
    tenantId: 'tenant-victim', sessionId: 'session-1', exp: EXP,
  })).toString('base64url')
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, `${forgedPayload}.${signature}`, EXP - 1), null)

  // Malformed inputs.
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, 'not-a-token', EXP - 1), null)
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, 'only-one-part.', EXP - 1), null)
  assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, '', EXP - 1), null)

  // Missing/blank required fields are rejected even with a valid signature.
  for (const badPayload of [
    { sessionId: 'session-1', exp: EXP },
    { tenantId: 'tenant-1', exp: EXP },
    { tenantId: '', sessionId: 'session-1', exp: EXP },
    { tenantId: 'tenant-1', sessionId: '  ', exp: EXP },
    { tenantId: 'tenant-1', sessionId: 'session-1' },
  ]) {
    const reForged = signKnowledgeAgentToken(SIGNING_KEY, badPayload as never)
    assert.equal(verifyKnowledgeAgentToken(SIGNING_KEY, reForged, EXP - 1), null)
  }
})

test('knowledge agent runtime augmentation mints a per-session token + mcp entry when fully configured', () => {
  const now = () => 1_000
  const augmentation = buildKnowledgeAgentRuntimeAugmentation({
    knowledgeEnabled: true,
    secret: SIGNING_KEY,
    publicUrl: 'https://cloud.example.com/',
    mcpScriptPath: '/dist/cloud/mcp-knowledge.mjs',
    execution: { tenantId: 'tenant-7', sessionId: 'session-7' },
    now,
    ttlMs: 60_000,
  })
  assert.ok(augmentation)

  // The tool URL is the public origin + the agent base path (trailing slash trimmed),
  // so the MCP's `${URL}/propose` resolves to the registered route.
  assert.equal(
    augmentation.env.OPEN_COWORK_KNOWLEDGE_TOOL_URL,
    `https://cloud.example.com${KNOWLEDGE_AGENT_ROUTE_BASE_PATH}`,
  )
  assert.equal(augmentation.env.OPEN_COWORK_KNOWLEDGE_TOOL_URL, 'https://cloud.example.com/api/knowledge/agent')

  // The injected token is valid, scoped to THIS session's tenant, and expires per TTL.
  const verified = verifyKnowledgeAgentToken(SIGNING_KEY, augmentation.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN, now())
  assert.deepEqual(verified, { tenantId: 'tenant-7', sessionId: 'session-7', exp: now() + 60_000 })

  // The MCP is registered as a local command pointing at the bundled file.
  assert.deepEqual(augmentation.mcp.knowledge, {
    type: 'local',
    command: ['node', '/dist/cloud/mcp-knowledge.mjs'],
    enabled: true,
  })

  // The default TTL is exported for the spawn path.
  assert.equal(KNOWLEDGE_AGENT_TOKEN_TTL_MS, 24 * 60 * 60 * 1000)
})

test('knowledge agent runtime augmentation fails closed on any missing prerequisite', () => {
  const base = {
    knowledgeEnabled: true,
    secret: SIGNING_KEY,
    publicUrl: 'https://cloud.example.com',
    mcpScriptPath: '/dist/cloud/mcp-knowledge.mjs',
    execution: { tenantId: 'tenant-7', sessionId: 'session-7' },
  }
  // Each fail-closed condition independently yields null (no token, no env).
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, knowledgeEnabled: false }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, secret: null }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, secret: '   ' }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, publicUrl: null }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, publicUrl: '' }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, mcpScriptPath: null }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, execution: { tenantId: '', sessionId: 'session-7' } }), null)
  assert.equal(buildKnowledgeAgentRuntimeAugmentation({ ...base, execution: { tenantId: 'tenant-7', sessionId: '' } }), null)
})

test('applyKnowledgeAgentRuntimeAugmentation merges env + mcp without mutating inputs, and is a no-op when null', () => {
  const baseEnv = { EXISTING: 'value' }
  const baseConfig = { mcp: { other: { type: 'local' as const, command: ['node', 'other.mjs'] } } }
  const augmentation = buildKnowledgeAgentRuntimeAugmentation({
    knowledgeEnabled: true,
    secret: SIGNING_KEY,
    publicUrl: 'https://cloud.example.com',
    mcpScriptPath: '/dist/cloud/mcp-knowledge.mjs',
    execution: { tenantId: 'tenant-9', sessionId: 'session-9' },
  })
  assert.ok(augmentation)

  const merged = applyKnowledgeAgentRuntimeAugmentation({
    env: baseEnv,
    runtimeConfig: baseConfig,
    augmentation,
  })
  // Pre-existing env + mcp survive alongside the injected knowledge entry.
  assert.equal(merged.env.EXISTING, 'value')
  assert.equal(merged.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN, augmentation.env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN)
  assert.ok(merged.runtimeConfig.mcp?.other)
  assert.ok(merged.runtimeConfig.mcp?.knowledge)
  // Inputs are not mutated.
  assert.equal((baseEnv as Record<string, string>).OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN, undefined)
  assert.equal(Object.keys(baseConfig.mcp).length, 1)

  // No augmentation ⇒ inputs returned structurally unchanged (config may even be undefined).
  const passthrough = applyKnowledgeAgentRuntimeAugmentation({
    env: baseEnv,
    runtimeConfig: undefined,
    augmentation: null,
  })
  assert.equal(passthrough.env, baseEnv)
  assert.equal(passthrough.runtimeConfig, undefined)
})
