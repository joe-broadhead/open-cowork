import { createPostgresKnowledgeStore } from '@open-cowork/runtime-host/knowledge/postgres-knowledge-store'
import { createSqliteKnowledgeStore, setKnowledgeDatabaseForTests } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import type { KnowledgeStore } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { CLOUD_CONTROL_PLANE_KNOWLEDGE_STATEMENTS } from '@open-cowork/cloud-server/postgres-schema'
import { createPglitePool } from './helpers/pglite-pool.ts'

// A real external Postgres is exercised only when a URL is provided (CI service
// container). pglite is real PostgreSQL-in-WASM and runs the store's *actual*
// SQL, so the suite already proves Postgres parity everywhere without a daemon.
const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real Postgres knowledge contract tests.'

type StoreHandle = { store: KnowledgeStore; dispose: () => Promise<void> }

function pageBody(text: string) {
  return [
    { id: 'summary', type: 'callout' as const, text },
    { id: 'details', type: 'p' as const, text: `${text} Detail block.` },
  ]
}

// --- SQLite (:memory:) ------------------------------------------------------
function makeSqliteStore(): StoreHandle {
  const db = new DatabaseSync(':memory:')
  setKnowledgeDatabaseForTests(db)
  return {
    store: createSqliteKnowledgeStore(),
    dispose: async () => {
      setKnowledgeDatabaseForTests(null)
      db.close()
    },
  }
}

// --- pglite (real PostgreSQL in WASM) --------------------------------------
async function makePgliteStore(connectionString: string, pool = createPglitePool()): Promise<StoreHandle> {
  void connectionString
  // The cloud_knowledge_* statements are a self-contained baseline domain
  // (their FKs only reference each other), so this contract can create only
  // the schema it owns.
  for (const statement of CLOUD_CONTROL_PLANE_KNOWLEDGE_STATEMENTS) {
    await pool.query(statement)
  }
  const store = createPostgresKnowledgeStore(pool, { ownsPool: true })
  return {
    store,
    dispose: async () => { await store.close?.() },
  }
}

runKnowledgeStoreContracts('sqlite', async () => makeSqliteStore())
runKnowledgeStoreContracts('pglite', async () => makePgliteStore('pglite://memory'))
runKnowledgeStoreContracts('postgres', async () => {
  assert.ok(POSTGRES_URL)
  const { Pool } = await import('pg') as unknown as { Pool: new (config: { connectionString: string }) => Parameters<typeof createPostgresKnowledgeStore>[0] }
  return makePgliteStore(POSTGRES_URL, new Pool({ connectionString: POSTGRES_URL }))
}, POSTGRES_SKIP)

function runKnowledgeStoreContracts(
  label: string,
  makeStore: () => Promise<StoreHandle>,
  skip?: false | string,
) {
  test(`${label} knowledge store: accepted proposals publish versioned pages with history + graph + server diff`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceId = `${label}-knowledge-main`
      const seeded = await store.listSnapshot(workspaceId)
      assert.equal(seeded.spaces.length, 1)
      assert.equal(seeded.spaces[0]?.role, 'Maintainer')
      assert.equal(seeded.pages[0]?.version, 1)
      assert.ok(seeded.graph.nodes.some((node) => node.kind === 'root' && node.label === 'Company OS'))

      const seedPage = seeded.pages[0]!
      const seedSpace = seeded.spaces[0]!

      const update = await store.createProposal(workspaceId, {
        spaceId: seedSpace.id,
        pageId: seedPage.id,
        pageTitle: seedPage.title,
        by: 'cleo',
        summary: 'Capture a clarified operating-model decision.',
        links: [{ kind: 'thread', label: 'Architecture chat', targetId: 'thread-1' }],
        body: pageBody('Accepted operating model update.'),
      }, { id: 'proposal-update', now: new Date('2026-06-01T10:00:00.000Z') })
      assert.equal(update.status, 'pending')
      assert.equal(update.add, 2)
      assert.equal(update.pageId, seedPage.id)

      const accepted = await store.acceptProposal(workspaceId, update.id, { reviewedBy: 'human-reviewer' })
      assert.equal(accepted.proposal.status, 'accepted')
      assert.equal(accepted.proposal.reviewedBy, 'human-reviewer')
      assert.equal(accepted.page.id, seedPage.id)
      assert.equal(accepted.page.pageId, seedPage.id)
      assert.equal(accepted.page.versionId, `version:${seedPage.id}:2`)
      assert.equal(accepted.page.version, 2)
      assert.equal(accepted.page.proposalId, update.id)

      const newPageProposal = await store.createProposal(workspaceId, {
        spaceId: seedSpace.id,
        pageTitle: 'Launch readiness',
        by: 'builder',
        summary: 'Publish launch readiness knowledge.',
        links: [{ kind: 'thread', label: seedPage.title, targetId: seedPage.id }],
        body: pageBody('Launch readiness was accepted.'),
      }, { id: 'proposal-new-page', now: new Date('2026-06-01T11:00:00.000Z') })
      const newPage = (await store.acceptProposal(workspaceId, newPageProposal.id, { reviewedBy: 'maintainer' })).page
      assert.equal(newPage.title, 'Launch readiness')
      assert.equal(newPage.id, newPage.pageId)
      assert.equal(newPage.versionId, `version:${newPage.id}:1`)
      assert.equal(newPage.version, 1)

      const history = await store.listPageHistory(workspaceId, seedPage.id)
      assert.deepEqual(history.map((entry) => entry.version), [2, 1])
      assert.deepEqual(history.map((entry) => entry.id), [seedPage.id, seedPage.id])
      assert.deepEqual(history.map((entry) => entry.versionId), [`version:${seedPage.id}:2`, `version:${seedPage.id}:1`])
      assert.equal(history[0]?.proposalId, update.id)
      assert.deepEqual((await store.listPageHistory(workspaceId, seedPage.id, { limit: 1 })).map((entry) => entry.version), [2])

      const afterAccept = await store.listSnapshot(workspaceId)
      assert.equal(afterAccept.proposals.length, 0)
      assert.ok(afterAccept.pages.some((page) => page.title === 'Launch readiness'))
      assert.ok(afterAccept.graph.edges.some((edge) => edge.kind === 'links' && edge.source === newPage.id && edge.target === seedPage.id))

      const decline = await store.createProposal(workspaceId, {
        spaceId: seedSpace.id,
        pageTitle: 'Declined note',
        by: 'you',
        summary: 'Do not publish this note.',
        body: pageBody('Declined content.'),
      }, { id: 'proposal-decline', now: new Date('2026-06-01T12:00:00.000Z') })
      const declined = await store.declineProposal(workspaceId, decline.id, { reviewedBy: 'maintainer' })
      assert.equal(declined.status, 'declined')
      assert.equal((await store.listSnapshot(workspaceId)).proposals.length, 0)
    } finally {
      await dispose()
    }
  })

  test(`${label} knowledge store: server-side diff stats override client add/del`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceId = `${label}-knowledge-diff`
      const seeded = await store.listSnapshot(workspaceId)
      const seedPage = seeded.pages[0]!
      const seedSpace = seeded.spaces[0]!

      const proposal = await store.createProposal(workspaceId, {
        spaceId: seedSpace.id,
        pageId: seedPage.id,
        pageTitle: seedPage.title,
        summary: 'Ignore client supplied counters.',
        add: 0,
        del: 0,
        body: [{ id: 'capture-summary', type: 'p', text: 'A replacement paragraph.' }],
      }, { id: 'proposal-diff-stats' })

      // Client passed add=0/del=0 but the store recomputes from content.
      assert.equal(proposal.add, 1)
      assert.equal(proposal.del, 6)
    } finally {
      await dispose()
    }
  })

  test(`${label} knowledge store: createSpace returns a new space and restoreVersion appends an audited version`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceId = `${label}-knowledge-create-restore`
      const seeded = await store.listSnapshot(workspaceId)
      const seedPage = seeded.pages[0]!
      const seedSpace = seeded.spaces[0]!
      const originalBody = seedPage.body

      // createSpace
      const created = await store.createSpace(workspaceId, {
        name: 'Launch Space',
        visibility: 'team',
        role: 'Maintainer',
      }, { id: 'space:created' })
      assert.equal(created.id, 'space:created')
      assert.equal(created.name, 'Launch Space')
      assert.equal(created.role, 'Maintainer')
      assert.equal((await store.getSpaceDetail(workspaceId, 'space:created'))?.name, 'Launch Space')
      // Creating the same space id again is rejected.
      await assert.rejects(
        Promise.resolve().then(() => store.createSpace(workspaceId, { name: 'Dup' }, { id: 'space:created' })),
        /already exists/,
      )
      // The new space shows up in the snapshot.
      assert.ok((await store.listSnapshot(workspaceId)).spaces.some((space) => space.id === 'space:created'))

      // Replace the operating model body, then restore version 1.
      const update = await store.createProposal(workspaceId, {
        spaceId: seedSpace.id,
        pageId: seedPage.id,
        pageTitle: seedPage.title,
        summary: 'Replace the operating model body.',
        body: pageBody('A completely rewritten operating model.'),
      }, { id: 'proposal-restore-update', now: new Date('2026-06-02T10:00:00.000Z') })
      const accepted = await store.acceptProposal(workspaceId, update.id, { reviewedBy: 'maintainer' })
      assert.equal(accepted.page.version, 2)

      const restored = await store.restoreVersion(workspaceId, seedPage.id, `version:${seedPage.id}:1`, { reviewedBy: 'maintainer' })
      assert.equal(restored.page.id, seedPage.id)
      assert.equal(restored.page.version, 3)
      assert.equal(restored.page.versionId, `version:${seedPage.id}:3`)
      assert.equal(restored.page.proposalId, null)
      assert.deepEqual(restored.page.body, originalBody)

      const snapshot = await store.listSnapshot(workspaceId)
      const live = snapshot.pages.find((page) => page.id === seedPage.id)!
      assert.equal(live.version, 3)
      assert.deepEqual(live.body, originalBody)
      assert.deepEqual((await store.listPageHistory(workspaceId, seedPage.id)).map((entry) => entry.version), [3, 2, 1])

      // Restoring the current version is a client error; unknown versions are not-found.
      await assert.rejects(
        Promise.resolve().then(() => store.restoreVersion(workspaceId, seedPage.id, `version:${seedPage.id}:3`, { reviewedBy: 'maintainer' })),
        /is already the current version/,
      )
      await assert.rejects(
        Promise.resolve().then(() => store.restoreVersion(workspaceId, seedPage.id, `version:${seedPage.id}:99`, { reviewedBy: 'maintainer' })),
        /not found/,
      )
    } finally {
      await dispose()
    }
  })

  test(`${label} knowledge store: enforces Reader/Contributor/Maintainer role gates (propose + review + restore)`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceId = `${label}-knowledge-roles`
      await store.listSnapshot(workspaceId)
      await store.createSpace(workspaceId, { name: 'Reader Space', visibility: 'team', role: 'Reader' }, { id: 'space-reader' })
      await store.createSpace(workspaceId, { name: 'Contributor Space', visibility: 'team', role: 'Contributor' }, { id: 'space-contributor' })
      await store.createSpace(workspaceId, { name: 'Owner Space', visibility: 'team', role: 'Maintainer' }, { id: 'space-owner' })

      // Reader cannot propose.
      await assert.rejects(
        Promise.resolve().then(() => store.createProposal(workspaceId, {
          spaceId: 'space-reader',
          pageTitle: 'Reader proposal',
          summary: 'Readers cannot propose.',
          body: pageBody('Reader content.'),
        })),
        /requires Contributor or Maintainer/,
      )

      // Contributor can propose, but cannot review (accept).
      const contribution = await store.createProposal(workspaceId, {
        spaceId: 'space-contributor',
        pageTitle: 'Contributor proposal',
        summary: 'Contributors can propose but cannot review.',
        body: pageBody('Contributor content.'),
      }, { id: 'proposal-contributor' })
      assert.equal(contribution.status, 'pending')
      await assert.rejects(
        Promise.resolve().then(() => store.acceptProposal(workspaceId, contribution.id, { reviewedBy: 'contributor' })),
        /requires Maintainer/,
      )

      // Publish a page (v1 + v2) in a Maintainer space, then prove restore is
      // Maintainer-gated: a Maintainer CAN restore an older version, and the
      // restore path shares the same review gate that already rejected the
      // Contributor accept above.
      const v1 = await store.acceptProposal(
        workspaceId,
        (await store.createProposal(workspaceId, { spaceId: 'space-owner', pageTitle: 'Owned page', summary: 'v1', body: pageBody('v1 content') }, { id: 'p-owned-1' })).id,
        { reviewedBy: 'maintainer' },
      )
      const pageId = v1.page.id
      await store.acceptProposal(
        workspaceId,
        (await store.createProposal(workspaceId, { spaceId: 'space-owner', pageId, pageTitle: 'Owned page', summary: 'v2', body: pageBody('v2 content rewritten') }, { id: 'p-owned-2' })).id,
        { reviewedBy: 'maintainer' },
      )
      const restored = await store.restoreVersion(workspaceId, pageId, `version:${pageId}:1`, { reviewedBy: 'maintainer' })
      assert.equal(restored.page.version, 3)
    } finally {
      await dispose()
    }
  })

  test(`${label} knowledge store: tenant isolation — workspace A cannot read/accept/decline/restore workspace B`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceA = `${label}-tenant-a`
      const workspaceB = `${label}-tenant-b`
      const seedA = await store.listSnapshot(workspaceA)
      const seedB = await store.listSnapshot(workspaceB)
      const spaceA = seedA.spaces[0]!
      const pageA = seedA.pages[0]!

      // A space/page id from workspace A must not resolve under workspace B.
      assert.equal(await store.getSpaceDetail(workspaceB, spaceA.id), null)
      assert.equal((await store.listSnapshot(workspaceB)).spaces.some((space) => space.id === spaceA.id), false)
      assert.deepEqual(await store.listPageHistory(workspaceB, pageA.id), [])

      // A proposal created in workspace A is invisible + immutable from workspace B.
      const proposalA = await store.createProposal(workspaceA, {
        spaceId: spaceA.id,
        pageTitle: 'Tenant A only',
        summary: 'Belongs to tenant A.',
        body: pageBody('Tenant A content.'),
      }, { id: 'proposal-tenant-a' })

      assert.equal((await store.listSnapshot(workspaceB)).proposals.some((proposal) => proposal.id === proposalA.id), false)
      await assert.rejects(
        Promise.resolve().then(() => store.acceptProposal(workspaceB, proposalA.id, { reviewedBy: 'b' })),
        /not found/,
      )
      await assert.rejects(
        Promise.resolve().then(() => store.declineProposal(workspaceB, proposalA.id, { reviewedBy: 'b' })),
        /not found/,
      )
      // Restoring workspace A's page via workspace B is also closed.
      await assert.rejects(
        Promise.resolve().then(() => store.restoreVersion(workspaceB, pageA.id, `version:${pageA.id}:1`, { reviewedBy: 'b' })),
        /not found/,
      )

      // The proposal is still pending in A and can only be acted on there.
      assert.equal((await store.acceptProposal(workspaceA, proposalA.id, { reviewedBy: 'a' })).proposal.status, 'accepted')

      // Workspace B's seed is untouched by anything that happened in A.
      assert.equal(seedB.proposals.length, 0)
      assert.equal((await store.listSnapshot(workspaceB)).pages.some((page) => page.title === 'Tenant A only'), false)
    } finally {
      await dispose()
    }
  })

  test(`${label} knowledge store: bounds snapshots + graph page nodes`, { skip }, async () => {
    const { store, dispose } = await makeStore()
    try {
      const workspaceId = `${label}-knowledge-bounded`
      const seeded = await store.listSnapshot(workspaceId)
      const seedSpace = seeded.spaces[0]!
      for (let index = 0; index < 105; index += 1) {
        const proposal = await store.createProposal(workspaceId, {
          spaceId: seedSpace.id,
          pageTitle: `Generated page ${index}`,
          summary: `Generated ${index}.`,
          body: pageBody(`Generated page ${index}.`),
        }, { id: `proposal-bounded-${index}`, now: new Date(Date.UTC(2026, 5, 2, 0, 0, index)) })
        await store.acceptProposal(workspaceId, proposal.id, { reviewedBy: 'maintainer' })
      }

      const bounded = await store.listSnapshot(workspaceId)
      assert.equal(bounded.limit, 100)
      assert.equal(bounded.truncated, true)
      assert.equal(bounded.pages.length, 100)
      assert.equal(bounded.graph.nodes.filter((node) => node.kind === 'page').length, 100)

      const explicit = await store.listSnapshot(workspaceId, { limit: 12 })
      assert.equal(explicit.limit, 12)
      assert.equal(explicit.truncated, true)
      assert.equal(explicit.pages.length, 12)
    } finally {
      await dispose()
    }
  })
}
