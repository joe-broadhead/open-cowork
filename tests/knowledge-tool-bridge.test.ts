import { ensureKnowledgeToolBridge, getKnowledgeToolBridgeEnvironment, stopKnowledgeToolBridge } from '@open-cowork/runtime-host/knowledge/knowledge-tool-bridge'
import { listKnowledgeSnapshot, setKnowledgeDatabaseForTests } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const LOCAL_SPACE_ID = 'space:local:company-os'

function knowledgeBody(text: string) {
  return [
    { id: 'summary', type: 'callout' as const, text },
    { id: 'details', type: 'p' as const, text: `${text} Detail block.` },
  ]
}

async function postRaw(url: string, headers: Record<string, string>, body: string) {
  const response = await fetch(url, { method: 'POST', headers, body })
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  }
}

async function postProposal(bearer: string, body: Record<string, unknown>) {
  const env = getKnowledgeToolBridgeEnvironment()
  assert.ok(env.OPEN_COWORK_KNOWLEDGE_TOOL_URL)
  return postRaw(`${env.OPEN_COWORK_KNOWLEDGE_TOOL_URL}/propose`, {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  }, JSON.stringify(body))
}

function withMemoryKnowledgeStore(run: (db: DatabaseSync) => Promise<void>) {
  return async () => {
    const db = new DatabaseSync(':memory:')
    try {
      setKnowledgeDatabaseForTests(db)
      await ensureKnowledgeToolBridge()
      await run(db)
    } finally {
      stopKnowledgeToolBridge()
      setKnowledgeDatabaseForTests(null)
      db.close()
    }
  }
}

test('knowledge tool bridge binds to loopback only', withMemoryKnowledgeStore(async () => {
  const env = getKnowledgeToolBridgeEnvironment()
  assert.ok(env.OPEN_COWORK_KNOWLEDGE_TOOL_URL)
  // The bridge mirrors the workflow bridge: it listens on 127.0.0.1 so a
  // non-loopback peer can never reach it. The MCP additionally refuses any URL
  // whose hostname is not loopback before it ever sends a request.
  assert.match(env.OPEN_COWORK_KNOWLEDGE_TOOL_URL, /^http:\/\/127\.0\.0\.1:\d+$/)
}))

test('knowledge tool bridge mints a >=32 char token and rejects bad or missing tokens', withMemoryKnowledgeStore(async () => {
  const env = getKnowledgeToolBridgeEnvironment()
  assert.ok(env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN)
  assert.ok((env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN || '').length >= 32)

  const proposal = {
    spaceId: LOCAL_SPACE_ID,
    pageTitle: 'Onboarding checklist',
    summary: 'Document the onboarding steps.',
    body: knowledgeBody('Onboarding overview.'),
  }

  // Wrong token → 401, no proposal created.
  assert.equal((await postProposal('wrong-token-with-enough-entropy-for-tests-1234', proposal)).status, 401)

  // Missing Authorization header → 401.
  const url = `${env.OPEN_COWORK_KNOWLEDGE_TOOL_URL}/propose`
  const noAuth = await postRaw(url, { 'content-type': 'application/json' }, JSON.stringify(proposal))
  assert.equal(noAuth.status, 401)

  // Token of correct shape but wrong value (same length as the real token) → 401.
  const sameLengthWrong = 'a'.repeat((env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN || '').length)
  assert.equal((await postProposal(sameLengthWrong, proposal)).status, 401)

  const snapshot = listKnowledgeSnapshot({ workspaceId: 'local' })
  assert.equal(snapshot.proposals.length, 0)
}))

test('knowledge tool bridge accepts a valid proposal and returns a pending proposal', withMemoryKnowledgeStore(async () => {
  const env = getKnowledgeToolBridgeEnvironment()
  const bearer = env.OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN!

  const response = await postProposal(bearer, {
    spaceId: LOCAL_SPACE_ID,
    pageTitle: 'Operating model',
    summary: 'Refine the review workflow description.',
    body: knowledgeBody('Coworkers propose, Maintainers review.'),
    by: 'Atlas',
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  const proposal = response.body.proposal as {
    id?: string
    status?: string
    by?: string
    spaceId?: string
    summary?: string
  }
  assert.match(proposal.id || '', /^proposal:/)
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.by, 'Atlas')
  assert.equal(proposal.spaceId, LOCAL_SPACE_ID)
  assert.equal(proposal.summary, 'Refine the review workflow description.')

  // It is persisted as a pending proposal in the local workspace snapshot.
  const snapshot = listKnowledgeSnapshot({ workspaceId: 'local' })
  assert.equal(snapshot.proposals.length, 1)
  assert.equal(snapshot.proposals[0]?.id, proposal.id)
  assert.equal(snapshot.proposals[0]?.status, 'pending')
}))

test('knowledge tool bridge defaults the author to Coworker', withMemoryKnowledgeStore(async () => {
  const bearer = getKnowledgeToolBridgeEnvironment().OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN!
  const response = await postProposal(bearer, {
    spaceId: LOCAL_SPACE_ID,
    pageTitle: 'Runbook',
    summary: 'Capture the deploy runbook.',
    body: knowledgeBody('Deploy runbook outline.'),
  })
  assert.equal(response.status, 200)
  assert.equal((response.body.proposal as { by?: string }).by, 'Coworker')
}))

test('knowledge tool bridge forces the local workspace and never trusts an agent-supplied workspace', withMemoryKnowledgeStore(async () => {
  const bearer = getKnowledgeToolBridgeEnvironment().OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN!

  // The agent posts a foreign workspaceId; the bridge MUST ignore it and force
  // the local workspace, so the proposal can never land in another tenant.
  const response = await postProposal(bearer, {
    workspaceId: 'tenant-acme',
    spaceId: LOCAL_SPACE_ID,
    pageTitle: 'Security policy',
    summary: 'Attempt to write into another workspace.',
    body: knowledgeBody('This must stay local.'),
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)

  // Nothing leaked into the spoofed workspace.
  const foreign = listKnowledgeSnapshot({ workspaceId: 'tenant-acme' })
  assert.equal(foreign.proposals.length, 0)

  // The proposal lives in the forced local workspace.
  const local = listKnowledgeSnapshot({ workspaceId: 'local' })
  assert.equal(local.proposals.length, 1)
  assert.equal(local.proposals[0]?.id, (response.body.proposal as { id?: string }).id)
}))

test('knowledge tool bridge rejects invalid payloads through the shared validator', withMemoryKnowledgeStore(async () => {
  const bearer = getKnowledgeToolBridgeEnvironment().OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN!

  // Empty body fails normalizeBody in the store — the bridge runs the SAME
  // validator the IPC/HTTP paths use, so it does not bypass validation.
  const emptyBody = await postProposal(bearer, {
    spaceId: LOCAL_SPACE_ID,
    pageTitle: 'Broken page',
    summary: 'Missing body.',
    body: [],
  })
  assert.equal(emptyBody.status, 400)
  assert.equal(emptyBody.body.ok, false)

  // Non-JSON payload → 400.
  const env = getKnowledgeToolBridgeEnvironment()
  const malformed = await postRaw(`${env.OPEN_COWORK_KNOWLEDGE_TOOL_URL}/propose`, {
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  }, '{not json')
  assert.equal(malformed.status, 400)

  // Unknown space id → 400 (store cannot find it / assertCanPropose path).
  const unknownSpace = await postProposal(bearer, {
    spaceId: 'space:local:does-not-exist',
    pageTitle: 'Ghost',
    summary: 'No such space.',
    body: knowledgeBody('Ghost body.'),
  })
  assert.equal(unknownSpace.status, 400)

  // No proposals were persisted from any of the rejected requests.
  const snapshot = listKnowledgeSnapshot({ workspaceId: 'local' })
  assert.equal(snapshot.proposals.length, 0)
}))
