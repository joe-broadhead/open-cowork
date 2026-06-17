import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  acceptKnowledgeProposal,
  createKnowledgeProposal,
  createKnowledgeSpace,
  declineKnowledgeProposal,
  listKnowledgePageHistory,
  listKnowledgeSnapshot,
  restoreKnowledgePageVersion,
  setKnowledgeDatabaseForTests,
} from '../apps/desktop/src/main/knowledge/knowledge-store.ts'
import type { KnowledgeSpaceVisibility } from '@open-cowork/shared'

function withMemoryKnowledgeStore(run: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:')
  try {
    setKnowledgeDatabaseForTests(db)
    run(db)
  } finally {
    setKnowledgeDatabaseForTests(null)
    db.close()
  }
}

function pageBody(text: string) {
  return [
    { id: 'summary', type: 'callout' as const, text },
    { id: 'details', type: 'p' as const, text: `${text} Detail block.` },
  ]
}

function insertSpace(db: DatabaseSync, input: {
  workspaceId: string
  id: string
  name: string
  role: 'Reader' | 'Contributor' | 'Maintainer'
}) {
  db.prepare(`
    insert into knowledge_spaces (id, workspace_id, name, icon, hue, visibility, role, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.workspaceId,
    input.name,
    'book-open',
    'azure',
    'team',
    input.role,
    '2026-06-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  )
}

test('knowledge store publishes accepted proposals as versioned pages with history and graph links', () => withMemoryKnowledgeStore(() => {
  const workspaceId = 'workspace-knowledge-main'
  const seeded = listKnowledgeSnapshot({ workspaceId })
  assert.equal(seeded.spaces.length, 1)
  assert.equal(seeded.spaces[0]?.role, 'Maintainer')
  assert.equal(seeded.pages[0]?.version, 1)
  assert.ok(seeded.graph.nodes.some((node) => node.kind === 'root' && node.label === 'Company OS'))

  const seedPage = seeded.pages[0]!
  const seedSpace = seeded.spaces[0]!
  const update = createKnowledgeProposal({
    workspaceId,
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

  const accepted = acceptKnowledgeProposal(update.id, { workspaceId, reviewedBy: 'human-reviewer' })
  assert.equal(accepted.proposal.status, 'accepted')
  assert.equal(accepted.proposal.reviewedBy, 'human-reviewer')
  assert.equal(accepted.page.id, seedPage.id)
  assert.equal(accepted.page.pageId, seedPage.id)
  assert.equal(accepted.page.versionId, `version:${seedPage.id}:2`)
  assert.equal(accepted.page.version, 2)
  assert.equal(accepted.page.proposalId, update.id)

  const newPageProposal = createKnowledgeProposal({
    workspaceId,
    spaceId: seedSpace.id,
    pageTitle: 'Launch readiness',
    by: 'builder',
    summary: 'Publish launch readiness knowledge.',
    links: [{ kind: 'thread', label: seedPage.title, targetId: seedPage.id }],
    body: pageBody('Launch readiness was accepted.'),
  }, { id: 'proposal-new-page', now: new Date('2026-06-01T11:00:00.000Z') })
  const newPage = acceptKnowledgeProposal(newPageProposal.id, { workspaceId, reviewedBy: 'maintainer' }).page
  assert.equal(newPage.title, 'Launch readiness')
  assert.equal(newPage.id, newPage.pageId)
  assert.equal(newPage.versionId, `version:${newPage.id}:1`)
  assert.equal(newPage.version, 1)

  const history = listKnowledgePageHistory(seedPage.id, { workspaceId })
  assert.deepEqual(history.map((entry) => entry.version), [2, 1])
  assert.deepEqual(history.map((entry) => entry.id), [seedPage.id, seedPage.id])
  assert.deepEqual(history.map((entry) => entry.versionId), [`version:${seedPage.id}:2`, `version:${seedPage.id}:1`])
  assert.equal(history[0]?.proposalId, update.id)
  assert.deepEqual(listKnowledgePageHistory(seedPage.id, { workspaceId, limit: 1 }).map((entry) => entry.version), [2])

  const afterAccept = listKnowledgeSnapshot({ workspaceId })
  assert.equal(afterAccept.proposals.length, 0)
  assert.ok(afterAccept.pages.some((page) => page.title === 'Launch readiness'))
  assert.ok(afterAccept.graph.edges.some((edge) => edge.kind === 'links' && edge.source === newPage.id && edge.target === seedPage.id))

  const decline = createKnowledgeProposal({
    workspaceId,
    spaceId: seedSpace.id,
    pageTitle: 'Declined note',
    by: 'you',
    summary: 'Do not publish this note.',
    body: pageBody('Declined content.'),
  }, { id: 'proposal-decline', now: new Date('2026-06-01T12:00:00.000Z') })
  const declined = declineKnowledgeProposal(decline.id, { workspaceId, reviewedBy: 'maintainer' })
  assert.equal(declined.status, 'declined')
  assert.equal(listKnowledgeSnapshot({ workspaceId }).proposals.length, 0)
}))

test('knowledge store restores a historical page version as a new audited version', () => withMemoryKnowledgeStore(() => {
  const workspaceId = 'workspace-knowledge-restore'
  const seeded = listKnowledgeSnapshot({ workspaceId })
  const seedPage = seeded.pages[0]!
  const seedSpace = seeded.spaces[0]!
  const originalBody = seedPage.body

  const update = createKnowledgeProposal({
    workspaceId,
    spaceId: seedSpace.id,
    pageId: seedPage.id,
    pageTitle: seedPage.title,
    summary: 'Replace the operating model body.',
    body: pageBody('A completely rewritten operating model.'),
  }, { id: 'proposal-restore-update', now: new Date('2026-06-02T10:00:00.000Z') })
  const accepted = acceptKnowledgeProposal(update.id, { workspaceId, reviewedBy: 'maintainer' })
  assert.equal(accepted.page.version, 2)

  // Restoring an older version appends a fresh version with the old content.
  const restored = restoreKnowledgePageVersion(seedPage.id, `version:${seedPage.id}:1`, {
    workspaceId,
    reviewedBy: 'maintainer',
  })
  assert.equal(restored.page.id, seedPage.id)
  assert.equal(restored.page.version, 3)
  assert.equal(restored.page.versionId, `version:${seedPage.id}:3`)
  assert.equal(restored.page.proposalId, null)
  assert.deepEqual(restored.page.body, originalBody)

  const snapshot = listKnowledgeSnapshot({ workspaceId })
  const live = snapshot.pages.find((page) => page.id === seedPage.id)!
  assert.equal(live.version, 3)
  assert.deepEqual(live.body, originalBody)

  const history = listKnowledgePageHistory(seedPage.id, { workspaceId })
  assert.deepEqual(history.map((entry) => entry.version), [3, 2, 1])

  // Restoring the version that is already current is rejected as a client error.
  assert.throws(
    () => restoreKnowledgePageVersion(seedPage.id, `version:${seedPage.id}:3`, { workspaceId, reviewedBy: 'maintainer' }),
    /is already the current version/,
  )
  // Unknown versions and unknown pages are not-found errors.
  assert.throws(
    () => restoreKnowledgePageVersion(seedPage.id, `version:${seedPage.id}:99`, { workspaceId, reviewedBy: 'maintainer' }),
    /not found/,
  )
}))

test('knowledge store requires Maintainer authority to restore a version', () => withMemoryKnowledgeStore((db) => {
  const workspaceId = 'workspace-knowledge-restore-roles'
  insertSpace(db, { workspaceId, id: 'space-contributor', name: 'Contributor Space', role: 'Contributor' })
  db.prepare(`
    insert into knowledge_pages (id, workspace_id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('page:contrib', workspaceId, 'space-contributor', 'Contributor page', 'test', '2026-06-02T00:00:00.000Z', 2, 'rev-2', JSON.stringify([]), JSON.stringify(pageBody('v2')), '2026-06-02T00:00:00.000Z')
  db.prepare(`
    insert into knowledge_page_versions (id, page_id, workspace_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('version:page:contrib:1', 'page:contrib', workspaceId, 'space-contributor', 'Contributor page', 'test', '2026-06-01T00:00:00.000Z', 1, 'rev-1', null, JSON.stringify([]), JSON.stringify(pageBody('v1')))

  assert.throws(
    () => restoreKnowledgePageVersion('page:contrib', 'version:page:contrib:1', { workspaceId, reviewedBy: 'contributor' }),
    /requires Maintainer/,
  )
}))

test('knowledge store computes diff stats from content instead of client input', () => withMemoryKnowledgeStore(() => {
  const workspaceId = 'workspace-knowledge-diff'
  const seeded = listKnowledgeSnapshot({ workspaceId })
  const seedPage = seeded.pages[0]!
  const seedSpace = seeded.spaces[0]!

  const proposal = createKnowledgeProposal({
    workspaceId,
    spaceId: seedSpace.id,
    pageId: seedPage.id,
    pageTitle: seedPage.title,
    summary: 'Ignore client supplied counters.',
    add: 0,
    del: 0,
    body: [
      { id: 'capture-summary', type: 'p', text: 'A replacement paragraph.' },
    ],
  }, { id: 'proposal-diff-stats' })

  assert.equal(proposal.add, 1)
  assert.equal(proposal.del, 6)
}))

test('knowledge store creates additional workspace-scoped Spaces', () => withMemoryKnowledgeStore(() => {
  const workspaceId = 'workspace-spaces'
  listKnowledgeSnapshot({ workspaceId }) // seed the default Space

  const space = createKnowledgeSpace(workspaceId, { name: 'Engineering', visibility: 'team', icon: 'blocks', hue: 'violet' })
  assert.equal(space.name, 'Engineering')
  assert.equal(space.visibility, 'team')
  assert.equal(space.role, 'Maintainer') // the creator owns the new Space

  // It appears in the workspace snapshot alongside the seeded Space, and is scoped to the workspace.
  assert.ok(listKnowledgeSnapshot({ workspaceId }).spaces.some((entry) => entry.name === 'Engineering'))
  assert.ok(!listKnowledgeSnapshot({ workspaceId: 'workspace-other' }).spaces.some((entry) => entry.name === 'Engineering'))

  // An invalid visibility falls back to team; a blank name is rejected.
  assert.equal(createKnowledgeSpace(workspaceId, { name: 'Private notes', visibility: 'bogus' as KnowledgeSpaceVisibility }).visibility, 'team')
  assert.throws(() => createKnowledgeSpace(workspaceId, { name: '' }), /name/i)
}))

test('knowledge store scopes proposal review to the requested workspace', () => withMemoryKnowledgeStore(() => {
  const cloudWorkspaceId = 'workspace-knowledge-cloud'
  const localWorkspaceId = 'local'
  const seeded = listKnowledgeSnapshot({ workspaceId: cloudWorkspaceId })
  const seedSpace = seeded.spaces[0]!

  const proposal = createKnowledgeProposal({
    workspaceId: cloudWorkspaceId,
    spaceId: seedSpace.id,
    pageTitle: 'Cloud-only note',
    summary: 'This proposal belongs to a cloud workspace.',
    body: pageBody('Cloud-only content.'),
  }, { id: 'proposal-cloud-only' })

  listKnowledgeSnapshot({ workspaceId: localWorkspaceId })
  assert.throws(() => acceptKnowledgeProposal(proposal.id, { workspaceId: localWorkspaceId }), /not found/)
  // Tenant-isolation regression: an accept/decline with NO workspace must NOT fall through to an
  // unscoped lookup that reaches another workspace's proposal — it resolves to the local sentinel.
  assert.throws(() => acceptKnowledgeProposal(proposal.id), /not found/)
  assert.throws(() => declineKnowledgeProposal(proposal.id), /not found/)
  // The cross-tenant attempts did not mutate it; the owning workspace can still accept.
  assert.equal(acceptKnowledgeProposal(proposal.id, { workspaceId: cloudWorkspaceId }).proposal.status, 'accepted')
}))

test('knowledge store enforces reader, contributor, and maintainer role gates', () => withMemoryKnowledgeStore((db) => {
  const workspaceId = 'workspace-knowledge-roles'
  insertSpace(db, {
    workspaceId,
    id: 'space-reader',
    name: 'Reader Space',
    role: 'Reader',
  })
  insertSpace(db, {
    workspaceId,
    id: 'space-contributor',
    name: 'Contributor Space',
    role: 'Contributor',
  })

  assert.throws(() => createKnowledgeProposal({
    workspaceId,
    spaceId: 'space-reader',
    pageTitle: 'Reader proposal',
    summary: 'Readers cannot propose.',
    body: pageBody('Reader content.'),
  }), /requires Contributor or Maintainer/)

  const contribution = createKnowledgeProposal({
    workspaceId,
    spaceId: 'space-contributor',
    pageTitle: 'Contributor proposal',
    summary: 'Contributors can propose but cannot review.',
    body: pageBody('Contributor content.'),
  }, { id: 'proposal-contributor' })
  assert.equal(contribution.status, 'pending')
  assert.throws(() => acceptKnowledgeProposal(contribution.id, {
    workspaceId,
    reviewedBy: 'contributor',
  }), /requires Maintainer/)
}))

test('knowledge store bounds snapshots and graph page nodes', () => withMemoryKnowledgeStore((db) => {
  const workspaceId = 'workspace-knowledge-bounded'
  const seeded = listKnowledgeSnapshot({ workspaceId })
  const seedSpace = seeded.spaces[0]!
  const insertPage = db.prepare(`
    insert into knowledge_pages (id, workspace_id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (let index = 0; index < 105; index += 1) {
    const pageId = `page:${workspaceId}:generated-${index}`
    const updatedAt = new Date(Date.UTC(2026, 5, 2, 0, 0, index)).toISOString()
    insertPage.run(
      pageId,
      workspaceId,
      seedSpace.id,
      `Generated page ${index}`,
      'test',
      updatedAt,
      1,
      `revision-${index}`,
      JSON.stringify([]),
      JSON.stringify(pageBody(`Generated page ${index}.`)),
      updatedAt,
    )
  }

  const bounded = listKnowledgeSnapshot({ workspaceId })
  assert.equal(bounded.limit, 100)
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.pages.length, 100)
  assert.equal(bounded.graph.nodes.filter((node) => node.kind === 'page').length, 100)

  const explicit = listKnowledgeSnapshot({ workspaceId, limit: 12 })
  assert.equal(explicit.limit, 12)
  assert.equal(explicit.truncated, true)
  assert.equal(explicit.pages.length, 12)
  assert.equal(explicit.graph.nodes.filter((node) => node.kind === 'page').length, 12)
}))
