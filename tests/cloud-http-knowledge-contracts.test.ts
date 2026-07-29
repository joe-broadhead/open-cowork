import { setKnowledgeDatabaseForTests } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { resolveCloudRuntimePolicy, type CloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { CloudHttpError } from '@open-cowork/cloud-server/http-server'
import { type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { KNOWLEDGE_AGENT_TOKEN_TTL_MS, signKnowledgeAgentToken } from '@open-cowork/cloud-server/knowledge-agent-token'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  KNOWLEDGE_CAPABILITY_CONFIG,
  readJson,
  asRecord,
  asArray,
  headerValue,
} from './helpers/cloud-http-test-support.ts'

test('cloud HTTP knowledge routes expose snapshot, proposal review, and version history', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'user',
  }
  const memberPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'member-1',
    accountId: 'member-1',
    email: 'member@example.test',
    role: 'member',
    authSource: 'user',
  }
  const fixture = createFixture({
    auth: (req) => headerValue(req.headers['x-test-role']) === 'member' ? memberPrincipal : ownerPrincipal,
  })
  const baseUrl = await fixture.server.listen()
  try {
    const snapshot = await readJson(await fetch(`${baseUrl}/api/knowledge`))
    const spaces = asArray(snapshot.spaces).map(asRecord)
    const pages = asArray(snapshot.pages).map(asRecord)
    assert.equal(spaces[0]?.role, 'Maintainer')
    assert.equal(pages[0]?.version, 1)
    assert.equal(snapshot.limit, 100)
    assert.equal(snapshot.truncated, false)
    assert.ok(asArray(asRecord(snapshot.graph).nodes).some((node) => asRecord(node).label === 'Company OS'))

    // Creating a Space is org-admin gated (structural). A member cannot; the org admin can, and the
    // new Space is tenant-scoped and appears in the snapshot — making the Space model usable.
    const memberSpace = await fetch(`${baseUrl}/api/knowledge/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ name: 'Member space', visibility: 'team' }),
    })
    assert.equal(memberSpace.status, 403)
    const createdSpace = await fetch(`${baseUrl}/api/knowledge/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering', visibility: 'team', icon: 'blocks' }),
    })
    assert.equal(createdSpace.status, 201)
    assert.equal(asRecord(await readJson(createdSpace)).name, 'Engineering')
    assert.ok(asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/knowledge`))).spaces)
      .map(asRecord).some((space) => space.name === 'Engineering'))

    // A member with a contributor/maintainer Space role MAY propose — the space role governs (the
    // store's assertCanPropose), not the Cloud org-admin role. Proposals stay pending until a
    // Maintainer reviews, so the "Contributor can propose" path is reachable on cloud.
    const memberProposal = await fetch(`${baseUrl}/api/knowledge/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({
        spaceId: String(spaces[0]?.id),
        pageId: String(pages[0]?.id),
        pageTitle: String(pages[0]?.title),
        by: 'member',
        summary: 'A member contributor proposes a Cloud Knowledge change.',
        body: [{ type: 'p', text: 'Member proposal pending review.' }],
      }),
    })
    assert.equal(memberProposal.status, 201)
    const memberProposalId = String(asRecord(await readJson(memberProposal)).id)
    // Reviewing still requires admin authority — decline it as the org admin so it does not linger.
    const memberProposalDecline = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(memberProposalId)}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(memberProposalDecline.status, 200)

    const proposalResponse = await fetch(`${baseUrl}/api/knowledge/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        spaceId: String(spaces[0]?.id),
        pageId: String(pages[0]?.id),
        pageTitle: String(pages[0]?.title),
        by: 'you',
        summary: 'Capture Cloud conversation decisions for review.',
        links: [{ kind: 'thread', label: 'Cloud conversation', targetId: 'session-1' }],
        body: [
          { type: 'callout', text: 'Captured from Cloud Web for Knowledge review.' },
          { type: 'p', text: 'The accepted result should publish as the next version.' },
        ],
      }),
    })
    assert.equal(proposalResponse.status, 201)
    const proposal = await readJson(proposalResponse)
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.pageId, pages[0]?.id)
    assert.equal(proposal.by, ownerPrincipal.email)

    const unauthorizedReview = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ reviewedBy: 'member' }),
    })
    assert.equal(unauthorizedReview.status, 403)
    assert.match(String((await readJson(unauthorizedReview)).error), /admin|review/i)

    const acceptedResponse = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(acceptedResponse.status, 200)
    const accepted = await readJson(acceptedResponse)
    assert.equal(asRecord(accepted.proposal).status, 'accepted')
    assert.equal(asRecord(accepted.proposal).reviewedBy, ownerPrincipal.email)
    assert.equal(asRecord(accepted.page).id, pages[0]?.id)
    assert.equal(asRecord(accepted.page).pageId, pages[0]?.id)
    assert.equal(asRecord(accepted.page).versionId, `version:${String(pages[0]?.id)}:2`)
    assert.equal(asRecord(accepted.page).version, 2)
    assert.equal(asRecord(accepted.page).proposalId, proposal.id)

    const history = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history`))).map(asRecord)
    assert.deepEqual(history.map((entry) => entry.version), [2, 1])
    assert.deepEqual(history.map((entry) => entry.id), [pages[0]?.id, pages[0]?.id])
    const limitedHistory = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history?limit=1`))).map(asRecord)
    assert.deepEqual(limitedHistory.map((entry) => entry.version), [2])

    const afterAccept = await readJson(await fetch(`${baseUrl}/api/knowledge`))
    assert.equal(asArray(afterAccept.proposals).length, 0)
    assert.equal(asArray(afterAccept.pages).map(asRecord).find((page) => page.id === pages[0]?.id)?.version, 2)

    // Restoring a historical version requires review authority and publishes a new audited version.
    const restoreUrl = `${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/restore`
    const restoreVersionId = `version:${String(pages[0]?.id)}:1`
    const unauthorizedRestore = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'member' },
      body: JSON.stringify({ versionId: restoreVersionId }),
    })
    assert.equal(unauthorizedRestore.status, 403)

    const restored = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: restoreVersionId }),
    })
    assert.equal(restored.status, 200)
    const restoredPage = asRecord((await readJson(restored)).page)
    assert.equal(restoredPage.version, 3)
    assert.equal(restoredPage.versionId, `version:${String(pages[0]?.id)}:3`)
    assert.equal(restoredPage.proposalId, null)

    const afterRestore = asArray(await readJson(await fetch(`${baseUrl}/api/knowledge/pages/${encodeURIComponent(String(pages[0]?.id))}/history`))).map(asRecord)
    assert.deepEqual(afterRestore.map((entry) => entry.version), [3, 2, 1])

    // Restoring the version that is already current is a client error; unknown versions are not-found.
    const alreadyCurrent = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: `version:${String(pages[0]?.id)}:3` }),
    })
    assert.equal(alreadyCurrent.status, 400)
    const unknownVersion = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: `version:${String(pages[0]?.id)}:99` }),
    })
    assert.equal(unknownVersion.status, 404)
    const missingVersionId = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missingVersionId.status, 400)

    const missing = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewedBy: 'maintainer' }),
    })
    assert.equal(missing.status, 400)

    fixture.store.upsertMembership({
      orgId: ownerPrincipal.orgId || ownerPrincipal.tenantId,
      accountId: ownerPrincipal.accountId || ownerPrincipal.userId,
      role: 'member',
      status: 'disabled',
    })
    const staleOwnerHeader = await fetch(`${baseUrl}/api/knowledge`, {
      headers: { 'x-test-role': 'owner' },
    })
    assert.equal(staleOwnerHeader.status, 403)
    assert.match(String((await readJson(staleOwnerHeader)).error), /membership is not active/i)
  } finally {
    await fixture.server.close()
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})

test('cloud HTTP knowledge agent-propose route is token-authed, tenant-scoped from the token, and propose-only', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const AGENT_SECRET = 'cloud-knowledge-agent-secret-for-tests'
  const now = Date.now()
  const ownerPrincipal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'owner-1',
    accountId: 'owner-1',
    email: 'owner@example.test',
    role: 'owner',
    authSource: 'user',
  }
  // The exact propose route is pre-user-auth and authenticates only via the
  // signed agent token. The normal user resolver deliberately rejects that
  // bearer so the test also proves it cannot authenticate a human review route.
  const fixture = createFixture({
    appConfig: KNOWLEDGE_CAPABILITY_CONFIG,
    knowledgeAgentTokenSecret: AGENT_SECRET,
    auth: (req) => {
      if (headerValue(req.headers.authorization)) {
        throw new CloudHttpError(401, 'Cloud user authentication is required.')
      }
      return ownerPrincipal
    },
  })
  const baseUrl = await fixture.server.listen()
  const proposeUrl = `${baseUrl}/api/knowledge/agent/propose`
  // The seeded default Space for the token's tenant (cloud:tenant-1). The agent
  // never learns this from the body — it proposes against its own workspace.
  const tokenSpaceId = 'space:cloud:tenant-1:company-os'
  const proposalBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
    spaceId: tokenSpaceId,
    pageTitle: 'Operating Model',
    summary: 'A cloud coworker proposes a knowledge change.',
    body: [{ type: 'p', text: 'Proposed by an agent; pending human review.' }],
    ...extra,
  })
  const signToken = (payload: { tenantId: string; sessionId: string; exp?: number }) =>
    signKnowledgeAgentToken(AGENT_SECRET, {
      tenantId: payload.tenantId,
      sessionId: payload.sessionId,
      exp: payload.exp ?? now + KNOWLEDGE_AGENT_TOKEN_TTL_MS,
    })

  try {
    // Missing token → 401.
    assert.equal((await fetch(proposeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: proposalBody() })).status, 401)

    // Malformed / wrong-secret / expired tokens → 401.
    assert.equal((await fetch(proposeUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-token' }, body: proposalBody() })).status, 401)
    assert.equal((await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signKnowledgeAgentToken('a-different-secret', { tenantId: 'tenant-1', sessionId: 's-1', exp: now + 1000 })}` },
      body: proposalBody(),
    })).status, 401)
    assert.equal((await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken({ tenantId: 'tenant-1', sessionId: 's-1', exp: now - 1 })}` },
      body: proposalBody(),
    })).status, 401)

    // Non-POST is rejected (propose-only, single verb).
    assert.equal((await fetch(proposeUrl, { method: 'GET', headers: { authorization: `Bearer ${signToken({ tenantId: 'tenant-1', sessionId: 's-1' })}` } })).status, 405)

    // Valid token → 201, a PENDING proposal scoped to the TOKEN's tenant.
    const validToken = signToken({ tenantId: 'tenant-1', sessionId: 'session-abc' })
    const created = await fetch(proposeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
      // The agent supplies a hostile `by` + a body-level workspace/tenant override.
      body: proposalBody({ by: 'totally-the-admin', workspaceId: 'cloud:tenant-victim', tenantId: 'tenant-victim' }),
    })
    assert.equal(created.status, 201)
    const createdBody = asRecord(await readJson(created))
    assert.equal(createdBody.ok, true)
    const proposal = asRecord(createdBody.proposal)
    assert.ok(proposal.id)
    // `by` is server-forced to 'Coworker' (the hostile body `by` is ignored).
    assert.equal(proposal.by, 'Coworker')
    // Created PENDING — it stays for a human Maintainer.
    assert.equal(proposal.status, 'pending')
    assert.equal(proposal.spaceId, tokenSpaceId)

    // The proposal landed in the TOKEN's tenant (cloud:tenant-1), NOT the body's
    // claimed tenant. It is visible in tenant-1's snapshot…
    const tenant1Snapshot = asRecord(await readJson(await fetch(`${baseUrl}/api/knowledge`, { headers: { 'x-test-role': 'owner' } })))
    assert.ok(asArray(tenant1Snapshot.proposals).map(asRecord).some((entry) => entry.id === proposal.id))

    // The agent route is propose-ONLY: its bearer cannot authenticate the
    // human-only accept endpoint, and the proposal remains pending.
    const acceptViaAgent = await fetch(`${baseUrl}/api/knowledge/proposals/${encodeURIComponent(String(proposal.id))}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${validToken}` },
      body: JSON.stringify({}),
    })
    assert.equal(acceptViaAgent.status, 401)
    const afterRejectedAccept = asRecord(await readJson(await fetch(`${baseUrl}/api/knowledge`, {
      headers: { 'x-test-role': 'owner' },
    })))
    assert.equal(
      asArray(afterRejectedAccept.proposals).map(asRecord).find((entry) => entry.id === proposal.id)?.status,
      'pending',
    )
  } finally {
    await fixture.server.close()
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})

test('cloud HTTP knowledge agent-propose route fails closed without a secret or current feature/tool/MCP permission', async () => {
  const knowledgeDb = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(knowledgeDb)
  const now = Date.now()
  const proposalBody = JSON.stringify({
    spaceId: 'space:cloud:tenant-1:company-os',
    pageTitle: 'Operating Model',
    summary: 'A cloud coworker proposes a knowledge change.',
    body: [{ type: 'p', text: 'Proposed by an agent.' }],
  })

  // No configured secret ⇒ the route rejects even a structurally valid-looking
  // token (it must NOT verify against an empty secret). Fail closed → 401.
  const noSecretFixture = createFixture({
    appConfig: KNOWLEDGE_CAPABILITY_CONFIG,
    knowledgeAgentTokenSecret: null,
  })
  const noSecretUrl = await noSecretFixture.server.listen()
  try {
    const forged = signKnowledgeAgentToken('', { tenantId: 'tenant-1', sessionId: 's-1', exp: now + 1000 })
    const rejected = await fetch(`${noSecretUrl}/api/knowledge/agent/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
      body: proposalBody,
    })
    assert.equal(rejected.status, 401)
  } finally {
    await noSecretFixture.server.close()
  }

  const AGENT_SECRET = 'cloud-knowledge-agent-secret-for-tests'
  // Mint once while all three current-policy prerequisites permit Knowledge.
  // The same still-valid token must not retain authority after any prerequisite
  // is revoked.
  const validToken = signKnowledgeAgentToken(AGENT_SECRET, {
    tenantId: 'tenant-1',
    sessionId: 's-1',
    exp: now + KNOWLEDGE_AGENT_TOKEN_TTL_MS,
  })
  const basePolicy = resolveCloudRuntimePolicy(KNOWLEDGE_CAPABILITY_CONFIG)
  const allowedPolicy: CloudRuntimePolicy = {
    ...basePolicy,
    allowedTools: ['knowledge'],
    allowedMcps: ['knowledge'],
  }
  const policyCases: Array<{
    name: string
    policy: CloudRuntimePolicy
    expectedStatus: number
  }> = [{
    name: 'feature, tool, and MCP allowed',
    policy: allowedPolicy,
    expectedStatus: 201,
  }, {
    name: 'feature removed',
    policy: {
      ...allowedPolicy,
      features: { ...allowedPolicy.features, knowledge: false },
    },
    expectedStatus: 403,
  }, {
    name: 'tool removed',
    policy: {
      ...allowedPolicy,
      allowedTools: [],
    },
    expectedStatus: 403,
  }, {
    name: 'MCP removed',
    policy: {
      ...allowedPolicy,
      allowedMcps: [],
    },
    expectedStatus: 403,
  }]
  try {
    for (const policyCase of policyCases) {
      const fixture = createFixture({
        appConfig: KNOWLEDGE_CAPABILITY_CONFIG,
        policy: policyCase.policy,
        knowledgeAgentTokenSecret: AGENT_SECRET,
      })
      const baseUrl = await fixture.server.listen()
      try {
        const response = await fetch(`${baseUrl}/api/knowledge/agent/propose`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${validToken}`,
          },
          body: proposalBody,
        })
        assert.equal(response.status, policyCase.expectedStatus, policyCase.name)
        if (policyCase.expectedStatus === 403) {
          assert.equal(
            asRecord((await readJson(response)).verdict).policyCode,
            'knowledge.disabled',
          )
        }
      } finally {
        await fixture.server.close()
      }
    }
  } finally {
    setKnowledgeDatabaseForTests(null)
    knowledgeDb.close()
  }
})
