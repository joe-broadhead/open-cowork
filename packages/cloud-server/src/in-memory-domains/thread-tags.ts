import { clone, key, normalizeOptionalText, normalizeText, nowIso } from './store-helpers.ts'
import type {
  CreateThreadTagInput,
  ThreadTagLinkInput,
  ThreadTagRecord,
  UpdateThreadTagInput,
} from '../control-plane-store.ts'

// Thread-tag domain extracted from in-memory-control-plane-store.ts. Owns the tag
// records + the session→tags link index, and the tag CRUD + apply/remove-to-session
// lifecycle. Tenant + session validation arrive via the injected host. The two
// public accessors (tagsForSession / sessionTagLinkIds) are how the session-listing
// method reads tag state without touching these maps directly. Behaviour-preserving;
// covered by the cloud-control-plane-store thread suite.

const THREAD_TAG_NAME_MAX_LENGTH = 48
const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const THREAD_DEFAULT_TAG_COLOR = '#64748b'

type InMemoryThreadTagsHost = {
  requireTenant(tenantId: string): void
  requireSession(tenantId: string, sessionId: string): void
}

export class InMemoryThreadTagsDomain {
  private readonly threadTags = new Map<string, ThreadTagRecord>()
  private readonly threadTagLinks = new Map<string, Set<string>>()
  private readonly host: InMemoryThreadTagsHost

  constructor(host: InMemoryThreadTagsHost) {
    this.host = host
  }

  listThreadTags(tenantId: string): ThreadTagRecord[] {
    this.host.requireTenant(tenantId)
    return Array.from(this.threadTags.values())
      .filter((tag) => tag.tenantId === tenantId)
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }

  createThreadTag(input: CreateThreadTagInput): ThreadTagRecord {
    this.host.requireTenant(input.tenantId)
    const tagKey = key(input.tenantId, input.tagId)
    const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = normalizeTagColor(input.color)
    const existing = this.threadTags.get(tagKey)
    if (existing) {
      if (existing.name !== name || existing.color !== color) {
        throw new Error(`Tag id ${input.tagId} was reused with different content.`)
      }
      return clone(existing)
    }
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    const createdAt = nowIso(input.createdAt)
    const record: ThreadTagRecord = {
      tenantId: input.tenantId,
      tagId: input.tagId,
      name,
      color,
      createdAt,
      updatedAt: createdAt,
    }
    this.threadTags.set(tagKey, record)
    return clone(record)
  }

  updateThreadTag(input: UpdateThreadTagInput): ThreadTagRecord | null {
    this.host.requireTenant(input.tenantId)
    const tag = this.threadTags.get(key(input.tenantId, input.tagId))
    if (!tag) return null
    const name = normalizeOptionalText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name') ?? tag.name
    this.assertUniqueThreadTagName(input.tenantId, input.tagId, name)
    tag.name = name
    if (input.color !== undefined) tag.color = normalizeTagColor(input.color)
    tag.updatedAt = nowIso(input.updatedAt)
    return clone(tag)
  }

  deleteThreadTag(tenantId: string, tagId: string): boolean {
    this.host.requireTenant(tenantId)
    const deleted = this.threadTags.delete(key(tenantId, tagId))
    for (const [linkKey, tags] of this.threadTagLinks.entries()) {
      if (!linkKey.startsWith(`${tenantId}\0`)) continue
      tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
    return deleted
  }

  applyThreadTags(input: ThreadTagLinkInput): void {
    this.host.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.host.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey) || new Set<string>()
      for (const tagId of tagIds) tags.add(tagId)
      this.threadTagLinks.set(linkKey, tags)
    }
  }

  removeThreadTags(input: ThreadTagLinkInput): void {
    this.host.requireTenant(input.tenantId)
    const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
    const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    for (const sessionId of sessionIds) this.host.requireSession(input.tenantId, sessionId)
    for (const tagId of tagIds) this.requireThreadTag(input.tenantId, tagId)
    for (const sessionId of sessionIds) {
      const linkKey = key(input.tenantId, sessionId)
      const tags = this.threadTagLinks.get(linkKey)
      if (!tags) continue
      for (const tagId of tagIds) tags.delete(tagId)
      if (tags.size === 0) this.threadTagLinks.delete(linkKey)
    }
  }

  private requireThreadTag(tenantId: string, tagId: string) {
    const tag = this.threadTags.get(key(tenantId, tagId))
    if (!tag) throw new Error(`Unknown thread tag ${tagId}.`)
    return tag
  }

  private assertUniqueThreadTagName(tenantId: string, tagId: string, name: string) {
    const normalized = name.toLocaleLowerCase()
    const duplicate = Array.from(this.threadTags.values()).find((tag) => (
      tag.tenantId === tenantId
      && tag.tagId !== tagId
      && tag.name.toLocaleLowerCase() === normalized
    ))
    if (duplicate) throw new Error(`Thread tag "${name}" already exists.`)
  }

  sessionTagLinkIds(tenantId: string, sessionId: string): ReadonlySet<string> | undefined {
    return this.threadTagLinks.get(key(tenantId, sessionId))
  }

  tagsForSession(tenantId: string, sessionId: string) {
    const tagIds = this.threadTagLinks.get(key(tenantId, sessionId))
    if (!tagIds) return []
    return Array.from(tagIds)
      .map((tagId) => this.threadTags.get(key(tenantId, tagId)))
      .filter((tag): tag is ThreadTagRecord => Boolean(tag))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .map((tag) => clone(tag))
  }
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function normalizeTagColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : THREAD_DEFAULT_TAG_COLOR
}
