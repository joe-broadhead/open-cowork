import type { OrgMemberRecord } from './control-plane-records.ts'

// Pure SCIM 2.0 resource mappers (issue #895): parse inbound SCIM User/Group JSON into
// the normalized shapes the SCIM service acts on, and render outbound SCIM resources.
// Kept dependency-light + pure so the mapping is fully unit-tested without a live IdP.
// RFC 7643 (schema) + RFC 7644 (protocol / PATCH).

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

// Linear-time email shape check. The domain is matched as dot-separated labels
// where each label excludes '.', so there is exactly one way to place the dots —
// no ambiguous overlap between the character classes and the literal '.', which
// is what makes the naive `[^@\s]+\.[^@\s]+` form quadratic (polynomial ReDoS).
const EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export type ScimUserInput = {
  externalId: string | null
  userName: string
  email: string
  displayName: string | null
  active: boolean
}

export class ScimParseError extends Error {
  readonly status: number
  readonly scimType: string | null
  constructor(status: number, message: string, scimType: string | null = null) {
    super(message)
    this.name = 'ScimParseError'
    this.status = status
    this.scimType = scimType
  }
}

// Extract the primary email from a SCIM `emails` array (primary first, else the first),
// falling back to a `userName` that already looks like an email.
function primaryEmail(body: Record<string, unknown>): string | null {
  const emails = Array.isArray(body.emails) ? body.emails : []
  const entries = emails.map(asRecord)
  const primary = entries.find((entry) => entry.primary === true) || entries[0]
  const value = trimmedString(primary?.value)?.toLowerCase()
  if (value && EMAIL_PATTERN.test(value)) return value
  const userName = trimmedString(body.userName)?.toLowerCase()
  return userName && EMAIL_PATTERN.test(userName) ? userName : null
}

function displayNameOf(body: Record<string, unknown>): string | null {
  const direct = trimmedString(body.displayName)
  if (direct) return direct
  const name = asRecord(body.name)
  const formatted = trimmedString(name.formatted)
  if (formatted) return formatted
  const given = trimmedString(name.givenName)
  const family = trimmedString(name.familyName)
  return [given, family].filter(Boolean).join(' ') || null
}

export function parseScimUser(body: unknown): ScimUserInput {
  const record = asRecord(body)
  const userName = trimmedString(record.userName)
  if (!userName) throw new ScimParseError(400, 'SCIM User requires a userName.', 'invalidValue')
  const email = primaryEmail(record)
  if (!email) throw new ScimParseError(400, 'SCIM User requires a valid primary email.', 'invalidValue')
  return {
    externalId: trimmedString(record.externalId),
    userName,
    email,
    displayName: displayNameOf(record),
    active: record.active === undefined ? true : record.active === true,
  }
}

export type ScimUserPatch = {
  active?: boolean
  displayName?: string | null
}

// Apply a SCIM PATCH (RFC 7644 §3.5.2) to the mutable fields we support: `active`
// (activate / deactivate) and `displayName`. Unknown paths are ignored (not an error)
// so an IdP sending extra attributes does not fail the sync.
export function parseScimPatch(body: unknown): ScimUserPatch {
  const record = asRecord(body)
  const operations = Array.isArray(record.Operations) ? record.Operations : []
  if (operations.length === 0) throw new ScimParseError(400, 'SCIM PATCH requires at least one operation.', 'invalidValue')
  const patch: ScimUserPatch = {}
  for (const raw of operations) {
    const op = asRecord(raw)
    const verb = trimmedString(op.op)?.toLowerCase()
    if (verb !== 'replace' && verb !== 'add') continue
    const path = trimmedString(op.path)?.toLowerCase()
    if (path === 'active') {
      patch.active = op.value === true || op.value === 'true'
    } else if (path === 'displayname') {
      patch.displayName = trimmedString(op.value)
    } else if (!path) {
      // Path-less replace: the value is a partial resource object.
      const value = asRecord(op.value)
      if (value.active !== undefined) patch.active = value.active === true
      if (value.displayName !== undefined) patch.displayName = trimmedString(value.displayName)
    }
  }
  return patch
}

export type ScimGroupInput = {
  externalId: string | null
  displayName: string
  memberExternalIds: string[]
}

export function parseScimGroup(body: unknown): ScimGroupInput {
  const record = asRecord(body)
  const displayName = trimmedString(record.displayName)
  if (!displayName) throw new ScimParseError(400, 'SCIM Group requires a displayName.', 'invalidValue')
  const members = Array.isArray(record.members) ? record.members : []
  const memberExternalIds = members
    .map((member) => trimmedString(asRecord(member).value))
    .filter((value): value is string => Boolean(value))
  return { externalId: trimmedString(record.externalId), displayName, memberExternalIds }
}

// Render an org member as a SCIM User resource (RFC 7643 §4.1). `active` mirrors the
// membership status: a disabled membership is `active: false` (deprovisioned).
export function scimUserResource(member: OrgMemberRecord, baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: member.accountId,
    externalId: member.accountId,
    userName: member.email,
    name: { formatted: member.displayName || member.email },
    displayName: member.displayName || member.email,
    emails: [{ value: member.email, primary: true }],
    active: member.status === 'active',
    meta: {
      resourceType: 'User',
      location: `${baseUrl}/Users/${encodeURIComponent(member.accountId)}`,
      lastModified: member.updatedAt,
      created: member.createdAt,
    },
  }
}

export function scimListResponse(resources: Record<string, unknown>[], totalResults: number): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  }
}

export function scimErrorResponse(status: number, detail: string, scimType: string | null = null): Record<string, unknown> {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  }
}
