/// <reference types="node" />
// Storage-agnostic knowledge-store core: validation, normalization, row→domain
// mappers, the deterministic workspace seed, and diff/graph derivation. These are
// byte-identical for the desktop SQLite store and the cloud Postgres store (the
// Postgres DDL mirrors the SQLite schema), so both backends import them from here
// — divergence would be a contract hole, not a feature, and the pglite contract
// test pins the equivalence. Node-only because the revision hash + space id use
// node:crypto; everything else is pure.
import { createHash, randomUUID } from 'node:crypto'
import type {
  KnowledgeGraph,
  KnowledgePage,
  KnowledgePageBlock,
  KnowledgePageLink,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeSpace,
  KnowledgeSpaceRole,
  KnowledgeSpaceVisibility,
} from '../knowledge.js'
import {
  isKnowledgeLinkKind,
  isKnowledgeProposalStatus,
  isKnowledgeSpaceRole,
  isKnowledgeSpaceVisibility,
  knowledgeRoleCanPropose,
  knowledgeRoleCanRead,
  knowledgeRoleCanReview,
} from '../knowledge.js'
import type { KnowledgeCreateSpaceInput } from '../knowledge-store-contract.js'

export const LOCAL_WORKSPACE_ID = 'local'

// Byte/size limits and the snapshot ceiling are storage-agnostic (validation is
// identical for SQLite + Postgres), so they are exported for both store impls to
// reuse instead of re-deriving their own — divergence here would be a contract
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

export type KnowledgeWriteOptions = {
  id?: string
  now?: Date
}

export type NormalizedKnowledgeSpace = {
  id: string
  name: string
  icon: string | null
  hue: string | null
  visibility: KnowledgeSpaceVisibility
  role: KnowledgeSpaceRole
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

export function knowledgeDefaultSpaceId(workspaceId: string) {
  return `space:${workspaceId}:company-os`
}

export function knowledgeDefaultPageId(workspaceId: string) {
  return `page:${workspaceId}:operating-model`
}

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
  const spaceId = knowledgeDefaultSpaceId(workspaceId)
  const pageId = knowledgeDefaultPageId(workspaceId)
  const body: KnowledgePageBlock[] = [
    { id: 'scope', type: 'callout', text: 'Knowledge captures accepted project decisions, task outcomes, and artifact context after human review.' },
    { id: 'workflow-heading', type: 'h', text: 'Review workflow' },
    { id: 'workflow-body', type: 'p', text: 'Coworkers and humans can propose updates. Maintainers review proposals before a page version is published.' },
    { id: 'workflow-list', type: 'list', items: ['Capture context from a conversation', 'Review the proposal diff stats', 'Accept to publish a new audited version'] },
  ]
  const links: KnowledgePageLink[] = []
  const revision = knowledgeRevisionFor({ pageId, version: 1, body, links })
  return {
    at,
    spaceId,
    pageId,
    versionId: `version:${pageId}:1`,
    space: { name: 'Company OS', icon: 'book-open', hue: 'azure', visibility: 'company' as const, role: 'Maintainer' as const },
    page: { title: 'Operating model', updatedBy: 'Open Cowork', version: 1, revision, body, links },
  }
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
