import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  KnowledgeGraph,
  KnowledgePage,
  KnowledgePageBlock,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeProposalInput,
  KnowledgeProposalStatus,
  KnowledgeReviewInput,
  KnowledgeSnapshotOptions,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
  KnowledgeSpaceRole,
  KnowledgeSpaceVisibility,
} from '@open-cowork/shared'
import {
  isKnowledgeLinkKind,
  isKnowledgeProposalStatus,
  isKnowledgeSpaceRole,
  isKnowledgeSpaceVisibility,
  knowledgeRoleCanPropose,
  knowledgeRoleCanRead,
  knowledgeRoleCanReview,
} from '@open-cowork/shared'
import { getAppDataDir } from '../config-loader.ts'
import type { KnowledgeCreateSpaceInput, KnowledgeStore } from './knowledge-store-contract.ts'

const KNOWLEDGE_DB_SCHEMA_VERSION = 1
const KNOWLEDGE_SCHEMA_VERSION_KEY = 'schema_version'
const LOCAL_WORKSPACE_ID = 'local'
// Byte/size limits and the snapshot ceiling are storage-agnostic (validation is
// identical for SQLite + Postgres), so they are exported for the Postgres impl
// to reuse instead of re-deriving its own — divergence here would be a contract
// hole, not a feature.
export const KNOWLEDGE_MAX_TITLE_BYTES = 240
export const KNOWLEDGE_MAX_TEXT_BYTES = 64 * 1024
export const KNOWLEDGE_MAX_LINKS = 100
export const KNOWLEDGE_MAX_BLOCKS = 300
export const KNOWLEDGE_MAX_LIST_ITEMS = 100
export const KNOWLEDGE_DEFAULT_SNAPSHOT_LIMIT = 100
export const KNOWLEDGE_MAX_SNAPSHOT_LIMIT = 100
const MAX_TITLE_BYTES = KNOWLEDGE_MAX_TITLE_BYTES
const MAX_TEXT_BYTES = KNOWLEDGE_MAX_TEXT_BYTES
const MAX_LINKS = KNOWLEDGE_MAX_LINKS
const MAX_BLOCKS = KNOWLEDGE_MAX_BLOCKS
const MAX_LIST_ITEMS = KNOWLEDGE_MAX_LIST_ITEMS
const DEFAULT_SNAPSHOT_LIMIT = KNOWLEDGE_DEFAULT_SNAPSHOT_LIMIT
const MAX_SNAPSHOT_LIMIT = KNOWLEDGE_MAX_SNAPSHOT_LIMIT

// A column→value bag from either backend. SQLite and the Postgres tables use
// the SAME column names (the Postgres DDL mirrors the SQLite schema), so the
// pure row→domain mappers below work unchanged against both.
export type KnowledgeDbRow = Record<string, unknown>
type DbRow = KnowledgeDbRow
type KnowledgeWriteOptions = {
  id?: string
  now?: Date
}
type KnowledgeStorageOptions = {
  storageDataDir?: string | null
}
type InternalKnowledgeSnapshotOptions = KnowledgeSnapshotOptions & KnowledgeStorageOptions
type InternalKnowledgeProposalInput = KnowledgeProposalInput & KnowledgeStorageOptions
type InternalKnowledgeReviewInput = KnowledgeReviewInput & KnowledgeStorageOptions

let knowledgeDb: DatabaseSync | null = null
const knowledgeDbsByPath = new Map<string, DatabaseSync>()
let knowledgeDbForTests: DatabaseSync | null = null
let transactionCounter = 0

function knowledgeDbPath(storageDataDir?: string | null) {
  const dir = storageDataDir || getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'knowledge.sqlite')
}

function ensureKnowledgeDbFileModes(dbPath = knowledgeDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function initDb(db: DatabaseSync) {
  db.exec(`
    create table if not exists knowledge_meta (
      key text primary key,
      value text not null
    );
    create table if not exists knowledge_spaces (
      id text primary key,
      workspace_id text not null,
      name text not null,
      icon text,
      hue text,
      visibility text not null,
      role text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists knowledge_pages (
      id text primary key,
      workspace_id text not null,
      space_id text not null,
      title text not null,
      updated_by text not null,
      updated_at text not null,
      version integer not null,
      revision text not null,
      links_json text not null,
      body_json text not null,
      created_at text not null,
      foreign key(space_id) references knowledge_spaces(id) on delete cascade
    );
    create table if not exists knowledge_page_versions (
      id text primary key,
      page_id text not null,
      workspace_id text not null,
      space_id text not null,
      title text not null,
      updated_by text not null,
      updated_at text not null,
      version integer not null,
      revision text not null,
      proposal_id text,
      links_json text not null,
      body_json text not null,
      foreign key(page_id) references knowledge_pages(id) on delete cascade
    );
    create table if not exists knowledge_proposals (
      id text primary key,
      workspace_id text not null,
      space_id text not null,
      page_id text,
      page_title text not null,
      by_name text not null,
      created_at text not null,
      summary text not null,
      add_count integer not null,
      del_count integer not null,
      status text not null,
      reviewed_at text,
      reviewed_by text,
      links_json text not null,
      body_json text not null,
      foreign key(space_id) references knowledge_spaces(id) on delete cascade,
      foreign key(page_id) references knowledge_pages(id) on delete set null
    );
    create index if not exists idx_knowledge_spaces_workspace on knowledge_spaces(workspace_id, name);
    create index if not exists idx_knowledge_pages_workspace on knowledge_pages(workspace_id, space_id, title);
    create index if not exists idx_knowledge_versions_page on knowledge_page_versions(page_id, version desc);
    create index if not exists idx_knowledge_proposals_workspace on knowledge_proposals(workspace_id, status, created_at);
  `)
  db.prepare(`
    insert into knowledge_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(KNOWLEDGE_SCHEMA_VERSION_KEY, String(KNOWLEDGE_DB_SCHEMA_VERSION))
}

export function getKnowledgeDb() {
  if (knowledgeDbForTests) return knowledgeDbForTests
  if (knowledgeDb) return knowledgeDb
  const dbPath = knowledgeDbPath()
  const db = openKnowledgeDb(dbPath)
  knowledgeDb = db
  return db
}

function openKnowledgeDb(dbPath: string) {
  const existing = knowledgeDbsByPath.get(dbPath)
  if (existing) return existing
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec('pragma foreign_keys = ON;')
    initDb(db)
    ensureKnowledgeDbFileModes(dbPath)
    knowledgeDbsByPath.set(dbPath, db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function getKnowledgeDbForStorage(options: KnowledgeStorageOptions = {}) {
  if (knowledgeDbForTests) return knowledgeDbForTests
  if (!options.storageDataDir) return getKnowledgeDb()
  return openKnowledgeDb(knowledgeDbPath(options.storageDataDir))
}

function closeKnowledgeDbCache() {
  const cachedDbs = new Set(knowledgeDbsByPath.values())
  if (knowledgeDb) cachedDbs.add(knowledgeDb)
  for (const cachedDb of cachedDbs) cachedDb.close()
  knowledgeDb = null
  knowledgeDbsByPath.clear()
}

export function setKnowledgeDatabaseForTests(db: DatabaseSync | null) {
  closeKnowledgeDbCache()
  knowledgeDbForTests = db
  transactionCounter = 0
  if (db) {
    db.exec('pragma foreign_keys = ON;')
    initDb(db)
  }
}

export function clearKnowledgeStoreCache() {
  closeKnowledgeDbCache()
  knowledgeDbForTests = null
  transactionCounter = 0
}

function withTransaction<T>(callback: (db: DatabaseSync) => T, options: KnowledgeStorageOptions = {}): T {
  const db = getKnowledgeDbForStorage(options)
  const savepoint = `knowledge_tx_${transactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    if (!knowledgeDbForTests) ensureKnowledgeDbFileModes(knowledgeDbPath(options.storageDataDir))
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      if (!knowledgeDbForTests) ensureKnowledgeDbFileModes(knowledgeDbPath(options.storageDataDir))
    }
    throw error
  }
}

function nowIso(options?: KnowledgeWriteOptions | InternalKnowledgeReviewInput) {
  return ((options as KnowledgeWriteOptions | undefined)?.now || new Date()).toISOString()
}

export function workspaceIdFrom(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || LOCAL_WORKSPACE_ID
}

export function knowledgeSnapshotLimit(value: number | null | undefined) {
  const limit = Math.floor(Number(value))
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_SNAPSHOT_LIMIT
  return Math.min(limit, MAX_SNAPSHOT_LIMIT)
}
const snapshotLimit = knowledgeSnapshotLimit

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function stringValue(value: unknown, label: string, options: { required?: boolean; maxBytes?: number } = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  const maxBytes = options.maxBytes || MAX_TEXT_BYTES
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label} is too large.`)
  return trimmed
}

export function requiredString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { required: true, maxBytes })!
}

export function optionalString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { maxBytes })
}

export function knowledgeJsonString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  const json = JSON.stringify(value)
  if (byteLength(json) > maxBytes) throw new Error(`${label} is too large.`)
  return json
}
const jsonString = knowledgeJsonString

// Postgres can return `jsonb` columns either as already-parsed objects (jsonb)
// or as JSON strings (json/text), so the parser tolerates both shapes. SQLite
// always stores text.
function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function normalizeLinks(value: unknown): KnowledgePageLink[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Knowledge links must be an array.')
  return value.slice(0, MAX_LINKS).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Knowledge link ${index + 1} must be an object.`)
    }
    const record = entry as Record<string, unknown>
    if (!isKnowledgeLinkKind(record.kind)) throw new Error(`Knowledge link ${index + 1} kind is invalid.`)
    return {
      kind: record.kind,
      label: requiredString(record.label, `Knowledge link ${index + 1} label`, MAX_TITLE_BYTES),
      targetId: optionalString(record.targetId, `Knowledge link ${index + 1} target`, 512),
    }
  })
}

function blockId(index: number) {
  return `block-${index + 1}`
}

export function normalizeBody(value: unknown): KnowledgePageBlock[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Knowledge page body must be a non-empty array.')
  return value.slice(0, MAX_BLOCKS).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Knowledge block ${index + 1} must be an object.`)
    }
    const record = entry as Record<string, unknown>
    const id = optionalString(record.id, `Knowledge block ${index + 1} id`, 128) || blockId(index)
    if (record.type === 'callout' || record.type === 'h' || record.type === 'p') {
      return {
        id,
        type: record.type,
        text: requiredString(record.text, `Knowledge block ${index + 1} text`),
      }
    }
    if (record.type === 'list') {
      if (!Array.isArray(record.items)) throw new Error(`Knowledge block ${index + 1} items must be an array.`)
      const items = record.items
        .slice(0, MAX_LIST_ITEMS)
        .map((item, itemIndex) => requiredString(item, `Knowledge block ${index + 1} item ${itemIndex + 1}`))
      if (!items.length) throw new Error(`Knowledge block ${index + 1} requires at least one item.`)
      return { id, type: 'list', items }
    }
    throw new Error(`Knowledge block ${index + 1} type is invalid.`)
  })
}

export function knowledgeRevisionFor(input: { pageId: string; version: number; body: KnowledgePageBlock[]; links: KnowledgePageLink[] }) {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}
const revisionFor = knowledgeRevisionFor

export function knowledgeDefaultSpaceId(workspaceId: string) {
  return `space:${workspaceId}:company-os`
}
const defaultSpaceId = knowledgeDefaultSpaceId

export function knowledgeDefaultPageId(workspaceId: string) {
  return `page:${workspaceId}:operating-model`
}
const defaultPageId = knowledgeDefaultPageId

export function toSpace(row: DbRow): KnowledgeSpace {
  const role = row.role
  const visibility = row.visibility
  if (!isKnowledgeSpaceRole(role)) throw new Error('Stored knowledge space role is invalid.')
  if (!isKnowledgeSpaceVisibility(visibility)) throw new Error('Stored knowledge space visibility is invalid.')
  return {
    id: String(row.id),
    name: String(row.name),
    icon: typeof row.icon === 'string' ? row.icon : null,
    hue: typeof row.hue === 'string' ? row.hue : null,
    visibility,
    role,
  }
}

export function toPage(row: DbRow): KnowledgePage {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    title: String(row.title),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    revision: String(row.revision),
    links: parseJson<KnowledgePageLink[]>(row.links_json, []),
    body: parseJson<KnowledgePageBlock[]>(row.body_json, []),
  }
}

export function toVersion(row: DbRow): KnowledgePageVersion {
  const pageId = String(row.page_id || row.id)
  return {
    ...toPage(row),
    id: pageId,
    pageId,
    versionId: String(row.id),
    proposalId: typeof row.proposal_id === 'string' ? row.proposal_id : null,
  }
}

export function toProposal(row: DbRow): KnowledgeProposal {
  const status = row.status
  if (!isKnowledgeProposalStatus(status)) throw new Error('Stored knowledge proposal status is invalid.')
  return {
    id: String(row.id),
    pageId: typeof row.page_id === 'string' ? row.page_id : null,
    pageTitle: String(row.page_title),
    spaceId: String(row.space_id),
    by: String(row.by_name),
    when: String(row.created_at),
    summary: String(row.summary),
    add: Number(row.add_count),
    del: Number(row.del_count),
    status,
    reviewedAt: typeof row.reviewed_at === 'string' ? row.reviewed_at : null,
    reviewedBy: typeof row.reviewed_by === 'string' ? row.reviewed_by : null,
    links: parseJson<KnowledgePageLink[]>(row.links_json, []),
    body: parseJson<KnowledgePageBlock[]>(row.body_json, []),
  }
}

/**
 * The canonical first-touch seed for a workspace: a "Company OS" Space and an
 * "Operating model" page (version 1). Pure + deterministic so BOTH backends
 * seed byte-identical content (same ids, blocks, revision hash) — the contract
 * test relies on this equivalence.
 */
export function knowledgeWorkspaceSeed(workspaceId: string, now = new Date('2026-01-01T00:00:00.000Z')) {
  const at = now.toISOString()
  const spaceId = defaultSpaceId(workspaceId)
  const pageId = defaultPageId(workspaceId)
  const body: KnowledgePageBlock[] = [
    { id: 'scope', type: 'callout', text: 'Knowledge captures accepted project decisions, task outcomes, and artifact context after human review.' },
    { id: 'workflow-heading', type: 'h', text: 'Review workflow' },
    { id: 'workflow-body', type: 'p', text: 'Coworkers and humans can propose updates. Maintainers review proposals before a page version is published.' },
    { id: 'workflow-list', type: 'list', items: ['Capture context from a conversation', 'Review the proposal diff stats', 'Accept to publish a new audited version'] },
  ]
  const links: KnowledgePageLink[] = []
  const revision = revisionFor({ pageId, version: 1, body, links })
  return {
    at,
    spaceId,
    pageId,
    versionId: `version:${pageId}:1`,
    space: { name: 'Company OS', icon: 'book-open', hue: 'azure', visibility: 'company' as const, role: 'Maintainer' as const },
    page: { title: 'Operating model', updatedBy: 'Open Cowork', version: 1, revision, body, links },
  }
}

function ensureWorkspaceSeed(db: DatabaseSync, workspaceId: string, now = new Date('2026-01-01T00:00:00.000Z')) {
  const count = db.prepare('select count(*) as count from knowledge_spaces where workspace_id = ?').get(workspaceId) as { count?: number } | undefined
  if (Number(count?.count || 0) > 0) return

  const seed = knowledgeWorkspaceSeed(workspaceId, now)
  const { at, spaceId, pageId, versionId } = seed
  const { space, page } = seed
  const linksJson = jsonString(page.links, 'Knowledge links')
  const bodyJson = jsonString(page.body, 'Knowledge body')

  db.prepare(`
    insert into knowledge_spaces (id, workspace_id, name, icon, hue, visibility, role, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(spaceId, workspaceId, space.name, space.icon, space.hue, space.visibility, space.role, at, at)
  db.prepare(`
    insert into knowledge_pages (id, workspace_id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pageId, workspaceId, spaceId, page.title, page.updatedBy, at, page.version, page.revision, linksJson, bodyJson, at)
  db.prepare(`
    insert into knowledge_page_versions (id, page_id, workspace_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(versionId, pageId, workspaceId, spaceId, page.title, page.updatedBy, at, page.version, page.revision, null, linksJson, bodyJson)
}

function getSpace(db: DatabaseSync, workspaceId: string, spaceId: string) {
  const row = db.prepare('select * from knowledge_spaces where workspace_id = ? and id = ?').get(workspaceId, spaceId) as DbRow | undefined
  return row ? toSpace(row) : null
}

function getPage(db: DatabaseSync, workspaceId: string, pageId: string) {
  const row = db.prepare('select * from knowledge_pages where workspace_id = ? and id = ?').get(workspaceId, pageId) as DbRow | undefined
  return row ? toPage(row) : null
}

function getPageByTitle(db: DatabaseSync, workspaceId: string, spaceId: string, title: string) {
  const row = db.prepare('select * from knowledge_pages where workspace_id = ? and space_id = ? and lower(title) = lower(?) order by updated_at desc limit 1').get(workspaceId, spaceId, title) as DbRow | undefined
  return row ? toPage(row) : null
}

// Proposal lookups are ALWAYS scoped to a concrete workspace — there is no
// unscoped (id-only) branch, so a review on the wrong/absent workspace can never
// reach another tenant's proposal (tenant-isolation invariant).
function getProposal(db: DatabaseSync, proposalId: string, workspaceId: string) {
  const row = db.prepare('select * from knowledge_proposals where workspace_id = ? and id = ?').get(workspaceId, proposalId)
  return row ? toProposal(row as DbRow) : null
}

export function assertReadable(space: KnowledgeSpace) {
  if (!knowledgeRoleCanRead(space.role)) throw new Error('Knowledge space is not readable for this role.')
}

export function assertCanPropose(space: KnowledgeSpace) {
  if (!knowledgeRoleCanPropose(space.role)) throw new Error('Knowledge space requires Contributor or Maintainer to propose changes.')
}

export function assertCanReview(space: KnowledgeSpace) {
  if (!knowledgeRoleCanReview(space.role)) throw new Error('Knowledge space requires Maintainer to review proposals.')
}

function blockDiffLines(blocks: KnowledgePageBlock[]) {
  return blocks.flatMap((block) => {
    if (block.type === 'list') return block.items.map((item) => item.trim()).filter(Boolean).map((item) => `list:${item}`)
    return block.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `${block.type}:${line}`)
  })
}

function commonLineCount(left: string[], right: string[]) {
  const previous = new Array(right.length + 1).fill(0) as number[]
  const current = new Array(right.length + 1).fill(0) as number[]
  for (const leftLine of left) {
    for (let index = 0; index < right.length; index += 1) {
      current[index + 1] = leftLine === right[index]
        ? (previous[index] ?? 0) + 1
        : Math.max(current[index] ?? 0, previous[index + 1] || 0)
    }
    previous.splice(0, previous.length, ...current)
    current.fill(0)
  }
  return previous[right.length] || 0
}

export function calculateDiffStats(current: KnowledgePage | null, body: KnowledgePageBlock[]) {
  const currentLines = current ? blockDiffLines(current.body) : []
  const nextLines = blockDiffLines(body)
  const unchanged = commonLineCount(currentLines, nextLines)
  return {
    add: Math.max(0, nextLines.length - unchanged),
    del: Math.max(0, currentLines.length - unchanged),
  }
}

export function graphFrom(spaces: KnowledgeSpace[], pages: KnowledgePage[]): KnowledgeGraph {
  const nodes = [
    { id: 'root', kind: 'root' as const, label: 'Company OS' },
    ...spaces.map((space) => ({ id: space.id, kind: 'space' as const, label: space.name, spaceId: space.id })),
    ...pages.map((page) => ({ id: page.id, kind: 'page' as const, label: page.title, spaceId: page.spaceId })),
  ]
  const pageByTitle = new Map(pages.map((page) => [page.title.toLowerCase(), page]))
  const pageById = new Map(pages.map((page) => [page.id, page]))
  const edges: KnowledgeGraph['edges'] = [
    ...spaces.map((space) => ({ id: `root:${space.id}`, source: 'root', target: space.id, kind: 'contains' as const })),
    ...pages.map((page) => ({ id: `${page.spaceId}:${page.id}`, source: page.spaceId, target: page.id, kind: 'contains' as const })),
  ]
  for (const page of pages) {
    for (const link of page.links) {
      const target = (link.targetId && pageById.get(link.targetId)) || pageByTitle.get(link.label.toLowerCase())
      if (target && target.id !== page.id) {
        edges.push({ id: `${page.id}:link:${target.id}`, source: page.id, target: target.id, kind: 'links' })
      }
    }
  }
  return { nodes, edges }
}

export function listKnowledgeSnapshot(options: InternalKnowledgeSnapshotOptions = {}): KnowledgeSnapshotPayload {
  const workspaceId = workspaceIdFrom(options.workspaceId)
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceId)
    const limit = snapshotLimit(options.limit)
    const spaceRows = (options.spaceId
      ? db.prepare('select * from knowledge_spaces where workspace_id = ? and id = ? order by name limit ?').all(workspaceId, options.spaceId, limit + 1)
      : db.prepare('select * from knowledge_spaces where workspace_id = ? order by name limit ?').all(workspaceId, limit + 1)) as DbRow[]
    const spaces = spaceRows.map(toSpace).filter((space) => knowledgeRoleCanRead(space.role))
    const boundedSpaces = spaces.slice(0, limit)
    const spaceIds = new Set(boundedSpaces.map((space) => space.id))
    const pageRows = (options.spaceId
      ? db.prepare('select * from knowledge_pages where workspace_id = ? and space_id = ? order by updated_at desc, title limit ?').all(workspaceId, options.spaceId, limit + 1)
      : db.prepare('select * from knowledge_pages where workspace_id = ? order by updated_at desc, title limit ?').all(workspaceId, limit + 1)) as DbRow[]
    const pages = pageRows.slice(0, limit).map(toPage).filter((page) => spaceIds.has(page.spaceId) && (!options.spaceId || page.spaceId === options.spaceId))
    for (const space of boundedSpaces) assertReadable(space)
    const proposalRows = (options.spaceId
      ? db.prepare(`
        select * from knowledge_proposals
        where workspace_id = ? and space_id = ? and status = 'pending'
        order by created_at desc
        limit ?
      `).all(workspaceId, options.spaceId, limit + 1)
      : db.prepare(`
        select * from knowledge_proposals
        where workspace_id = ? and status = 'pending'
        order by created_at desc
        limit ?
      `).all(workspaceId, limit + 1)) as DbRow[]
    const proposals = proposalRows.slice(0, limit).map(toProposal).filter((proposal) => spaceIds.has(proposal.spaceId))
    const truncated = spaceRows.length > limit || pageRows.length > limit || proposalRows.length > limit
    return {
      spaces: boundedSpaces,
      pages,
      proposals,
      graph: graphFrom(boundedSpaces, pages),
      limit,
      truncated,
    }
  }, options)
}

export function createKnowledgeProposal(input: InternalKnowledgeProposalInput, options: KnowledgeWriteOptions = {}): KnowledgeProposal {
  const workspaceId = workspaceIdFrom(input.workspaceId)
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceId)
    const spaceId = requiredString(input.spaceId, 'Knowledge space id', 512)
    const space = getSpace(db, workspaceId, spaceId)
    if (!space) throw new Error('Knowledge space was not found.')
    assertCanPropose(space)
    const pageTitle = requiredString(input.pageTitle, 'Knowledge page title', MAX_TITLE_BYTES)
    const page = input.pageId
      ? getPage(db, workspaceId, input.pageId)
      : getPageByTitle(db, workspaceId, spaceId, pageTitle)
    if (input.pageId && !page) throw new Error('Knowledge page was not found.')
    if (page && page.spaceId !== spaceId) throw new Error('Knowledge page belongs to a different space.')
    const body = normalizeBody(input.body)
    const links = normalizeLinks(input.links)
    const diff = calculateDiffStats(page, body)
    const at = nowIso(options)
    const id = options.id || `proposal:${randomUUID()}`
    db.prepare(`
      insert into knowledge_proposals (id, workspace_id, space_id, page_id, page_title, by_name, created_at, summary, add_count, del_count, status, reviewed_at, reviewed_by, links_json, body_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspaceId,
      spaceId,
      page?.id || null,
      pageTitle,
      optionalString(input.by, 'Knowledge proposal author', MAX_TITLE_BYTES) || 'you',
      at,
      requiredString(input.summary, 'Knowledge proposal summary', MAX_TEXT_BYTES),
      diff.add,
      diff.del,
      'pending',
      null,
      null,
      jsonString(links, 'Knowledge proposal links'),
      jsonString(body, 'Knowledge proposal body'),
    )
    const proposal = getProposal(db, id, workspaceId)
    if (!proposal) throw new Error('Knowledge proposal was not created.')
    return proposal
  }, input)
}

function updateProposalStatus(
  db: DatabaseSync,
  proposal: KnowledgeProposal,
  workspaceId: string,
  status: KnowledgeProposalStatus,
  input: KnowledgeReviewInput | undefined,
  at: string,
) {
  db.prepare(`
    update knowledge_proposals
    set status = ?, reviewed_at = ?, reviewed_by = ?
    where workspace_id = ? and id = ?
  `).run(
    status,
    at,
    optionalString(input?.reviewedBy, 'Knowledge reviewer', MAX_TITLE_BYTES) || 'you',
    workspaceId,
    proposal.id,
  )
  const updated = getProposal(db, proposal.id, workspaceId)
  if (!updated) throw new Error('Knowledge proposal was not found after review.')
  return updated
}

export function acceptKnowledgeProposal(proposalId: string, input: InternalKnowledgeReviewInput = {}): { proposal: KnowledgeProposal; page: KnowledgePageVersion } {
  const workspaceId = workspaceIdFrom(input.workspaceId)
  return withTransaction((db) => {
    const proposal = getProposal(db, requiredString(proposalId, 'Knowledge proposal id', 512), workspaceId)
    if (!proposal) throw new Error('Knowledge proposal was not found.')
    if (proposal.status !== 'pending') throw new Error('Knowledge proposal is not pending.')
    const space = getSpace(db, workspaceId, proposal.spaceId)
    if (!space) throw new Error('Knowledge space was not found.')
    assertCanReview(space)
    const existing = proposal.pageId ? getPage(db, workspaceId, proposal.pageId) : getPageByTitle(db, workspaceId, proposal.spaceId, proposal.pageTitle)
    const at = nowIso(input)
    const pageId = existing?.id || `page:${randomUUID()}`
    const version = (existing?.version || 0) + 1
    const revision = revisionFor({ pageId, version, body: proposal.body, links: proposal.links })
    if (existing) {
      db.prepare(`
        update knowledge_pages
        set title = ?, updated_by = ?, updated_at = ?, version = ?, revision = ?, links_json = ?, body_json = ?
        where id = ?
      `).run(proposal.pageTitle, proposal.by, at, version, revision, jsonString(proposal.links, 'Knowledge links'), jsonString(proposal.body, 'Knowledge body'), pageId)
    } else {
      db.prepare(`
        insert into knowledge_pages (id, workspace_id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pageId, workspaceId, proposal.spaceId, proposal.pageTitle, proposal.by, at, version, revision, jsonString(proposal.links, 'Knowledge links'), jsonString(proposal.body, 'Knowledge body'), at)
    }
    const versionId = `version:${pageId}:${version}`
    db.prepare(`
      insert into knowledge_page_versions (id, page_id, workspace_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, pageId, workspaceId, proposal.spaceId, proposal.pageTitle, proposal.by, at, version, revision, proposal.id, jsonString(proposal.links, 'Knowledge links'), jsonString(proposal.body, 'Knowledge body'))

    const reviewed = updateProposalStatus(db, proposal, workspaceId, 'accepted', input, at)
    const page = db.prepare('select * from knowledge_page_versions where id = ?').get(versionId) as DbRow | undefined
    if (!page) throw new Error('Knowledge page version was not created.')
    return { proposal: reviewed, page: toVersion(page) }
  }, input)
}

export function declineKnowledgeProposal(proposalId: string, input: InternalKnowledgeReviewInput = {}): KnowledgeProposal {
  const workspaceId = workspaceIdFrom(input.workspaceId)
  return withTransaction((db) => {
    const proposal = getProposal(db, requiredString(proposalId, 'Knowledge proposal id', 512), workspaceId)
    if (!proposal) throw new Error('Knowledge proposal was not found.')
    if (proposal.status !== 'pending') throw new Error('Knowledge proposal is not pending.')
    const space = getSpace(db, workspaceId, proposal.spaceId)
    if (!space) throw new Error('Knowledge space was not found.')
    assertCanReview(space)
    return updateProposalStatus(db, proposal, workspaceId, 'declined', input, nowIso(input))
  }, input)
}

export function listKnowledgePageHistory(pageId: string, options: InternalKnowledgeSnapshotOptions = {}): KnowledgePageVersion[] {
  const workspaceId = workspaceIdFrom(options.workspaceId)
  const limit = snapshotLimit(options.limit)
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceId)
    const page = getPage(db, workspaceId, requiredString(pageId, 'Knowledge page id', 512))
    if (!page) return []
    const space = getSpace(db, workspaceId, page.spaceId)
    if (!space) return []
    assertReadable(space)
    return (db.prepare(`
      select * from knowledge_page_versions
      where workspace_id = ? and page_id = ?
      order by version desc
      limit ?
    `).all(workspaceId, page.id, limit) as DbRow[]).map(toVersion)
  }, options)
}

export function restoreKnowledgePageVersion(
  pageId: string,
  versionId: string,
  input: InternalKnowledgeReviewInput = {},
): { page: KnowledgePageVersion } {
  const workspaceId = workspaceIdFrom(input.workspaceId)
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceId)
    const page = getPage(db, workspaceId, requiredString(pageId, 'Knowledge page id', 512))
    if (!page) throw new Error('Knowledge page was not found.')
    const space = getSpace(db, workspaceId, page.spaceId)
    if (!space) throw new Error('Knowledge space was not found.')
    // Restoring publishes a new authoritative page version, so it carries the
    // same Maintainer-only authority as accepting a proposal.
    assertCanReview(space)
    const targetId = requiredString(versionId, 'Knowledge version id', 512)
    const targetRow = db.prepare(
      'select * from knowledge_page_versions where workspace_id = ? and page_id = ? and id = ?',
    ).get(workspaceId, page.id, targetId) as DbRow | undefined
    if (!targetRow) throw new Error('Knowledge page version was not found.')
    const target = toVersion(targetRow)
    if (target.version === page.version) {
      throw new Error('Knowledge page version is already the current version.')
    }
    // Restore is non-destructive: it appends a fresh version whose content is a
    // copy of the chosen historical version, preserving the full audit trail.
    const at = nowIso(input)
    const version = page.version + 1
    const restoredBy = optionalString(input.reviewedBy, 'Knowledge reviewer', MAX_TITLE_BYTES) || 'you'
    const revision = revisionFor({ pageId: page.id, version, body: target.body, links: target.links })
    db.prepare(`
      update knowledge_pages
      set title = ?, updated_by = ?, updated_at = ?, version = ?, revision = ?, links_json = ?, body_json = ?
      where id = ?
    `).run(target.title, restoredBy, at, version, revision, jsonString(target.links, 'Knowledge links'), jsonString(target.body, 'Knowledge body'), page.id)
    const newVersionId = `version:${page.id}:${version}`
    db.prepare(`
      insert into knowledge_page_versions (id, page_id, workspace_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newVersionId, page.id, workspaceId, page.spaceId, target.title, restoredBy, at, version, revision, null, jsonString(target.links, 'Knowledge links'), jsonString(target.body, 'Knowledge body'))
    const created = db.prepare('select * from knowledge_page_versions where id = ?').get(newVersionId) as DbRow | undefined
    if (!created) throw new Error('Knowledge page version was not created.')
    return { page: toVersion(created) }
  }, input)
}

export function getKnowledgeSpaceDetail(spaceId: string, workspaceId = LOCAL_WORKSPACE_ID): KnowledgeSpace | null {
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceIdFrom(workspaceId))
    return getSpace(db, workspaceIdFrom(workspaceId), spaceId)
  })
}

export type NormalizedKnowledgeSpace = {
  id: string
  name: string
  icon: string | null
  hue: string | null
  visibility: KnowledgeSpaceVisibility
  role: KnowledgeSpaceRole
}

/**
 * Validate + normalize Space-creation input (storage-agnostic). Shared by both
 * backends so a created Space is shaped/validated identically regardless of
 * where it lands. Defaults: a derived slug id, `team` visibility, `Maintainer`
 * role (the creator owns the Space).
 */
export function normalizeKnowledgeSpaceInput(
  input: KnowledgeCreateSpaceInput,
  options: KnowledgeWriteOptions = {},
): NormalizedKnowledgeSpace {
  const name = requiredString(input.name, 'Knowledge space name', MAX_TITLE_BYTES)
  const icon = optionalString(input.icon, 'Knowledge space icon', MAX_TITLE_BYTES)
  const hue = optionalString(input.hue, 'Knowledge space hue', MAX_TITLE_BYTES)
  // An unrecognized visibility falls back to the default team scope (the original
  // createKnowledgeSpace contract — consumers pre-validate, so this only guards
  // direct/raw callers and keeps both store impls forgiving + identical).
  const visibilityInput = input.visibility ?? undefined
  const visibility = isKnowledgeSpaceVisibility(visibilityInput) ? visibilityInput : undefined
  const role = input.role ?? undefined
  if (role !== undefined && !isKnowledgeSpaceRole(role)) {
    throw new Error('Knowledge space role is invalid.')
  }
  const id = options.id || `space:${randomUUID()}`
  if (byteLength(id) > 512) throw new Error('Knowledge space id is too large.')
  return {
    id,
    name,
    icon,
    hue,
    visibility: visibility ?? 'team',
    role: role ?? 'Maintainer',
  }
}

export function createKnowledgeSpace(
  workspaceIdInput: string,
  input: KnowledgeCreateSpaceInput,
  options: KnowledgeWriteOptions & KnowledgeStorageOptions = {},
): KnowledgeSpace {
  const workspaceId = workspaceIdFrom(workspaceIdInput)
  return withTransaction((db) => {
    ensureWorkspaceSeed(db, workspaceId)
    const space = normalizeKnowledgeSpaceInput(input, options)
    const existing = db.prepare('select id from knowledge_spaces where workspace_id = ? and id = ?').get(workspaceId, space.id) as DbRow | undefined
    if (existing) throw new Error('Knowledge space already exists.')
    const at = nowIso(options)
    db.prepare(`
      insert into knowledge_spaces (id, workspace_id, name, icon, hue, visibility, role, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(space.id, workspaceId, space.name, space.icon, space.hue, space.visibility, space.role, at, at)
    const created = getSpace(db, workspaceId, space.id)
    if (!created) throw new Error('Knowledge space was not created.')
    return created
  }, options)
}

/**
 * A {@link KnowledgeStore} backed by the desktop SQLite database. This is a thin
 * synchronous adapter that delegates to the existing free functions — the same
 * code the desktop IPC layer uses — so there is one source of truth for the
 * SQLite behavior. `options.storageDataDir` targets a specific on-disk DB (for
 * tests/isolation); omit it to use the app's default knowledge DB.
 */
export function createSqliteKnowledgeStore(storeOptions: KnowledgeStorageOptions = {}): KnowledgeStore {
  const dataDir = storeOptions.storageDataDir ?? null
  const storage: KnowledgeStorageOptions = dataDir ? { storageDataDir: dataDir } : {}
  return {
    listSnapshot(workspaceId, options = {}) {
      return listKnowledgeSnapshot({
        ...storage,
        workspaceId,
        spaceId: options.spaceId ?? null,
        limit: options.limit ?? null,
      })
    },
    listPageHistory(workspaceId, pageId, options = {}) {
      return listKnowledgePageHistory(pageId, {
        ...storage,
        workspaceId,
        limit: options.limit ?? null,
      })
    },
    createSpace(workspaceId, input, options = {}) {
      return createKnowledgeSpace(workspaceId, input, { ...storage, ...options })
    },
    getSpaceDetail(workspaceId, spaceId) {
      return getKnowledgeSpaceDetail(spaceId, workspaceId)
    },
    createProposal(workspaceId, input, options = {}) {
      return createKnowledgeProposal({ ...storage, ...input, workspaceId }, options)
    },
    acceptProposal(workspaceId, proposalId, input = {}, options = {}) {
      return acceptKnowledgeProposal(proposalId, { ...storage, ...input, ...options, workspaceId })
    },
    declineProposal(workspaceId, proposalId, input = {}, options = {}) {
      return declineKnowledgeProposal(proposalId, { ...storage, ...input, ...options, workspaceId })
    },
    restoreVersion(workspaceId, pageId, versionId, input = {}, options = {}) {
      return restoreKnowledgePageVersion(pageId, versionId, { ...storage, ...input, ...options, workspaceId })
    },
  }
}
