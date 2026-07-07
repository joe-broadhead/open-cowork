import { randomBytes } from 'node:crypto'
import type { AuditActorInput } from './control-plane-account-inputs.ts'

// The per-org enterprise SSO configuration model (issue #895). A single record per
// org describes how that org's members authenticate — SAML 2.0 OR OIDC — plus the
// domains it owns, whether login is SSO-enforced (SSO-only), and whether SCIM
// provisioning is enabled. IdP secrets (the SAML IdP signing certificate, the OIDC
// client secret) and the SCIM bearer token are NEVER stored in plaintext: the
// service layer seals them with the existing versioned envelope encryption
// (`enc:vN:` AES-256-GCM) and the store persists only the ciphertext / token hash.
// This module is dependency-light (pure types + pure normalizers) so the store
// contract, both store implementations, the SSO/SCIM services, and the route layer
// can all share one authoritative model, exactly like control-plane-permissions.ts.

export type SsoProtocol = 'saml' | 'oidc'

// The full internal record the store persists and returns. `*Ciphertext` fields hold
// the sealed envelope produced by the secret adapter; `scimTokenHash` is a salted hash
// of the SCIM bearer token. The service maps this to a public record that exposes only
// `has*` booleans, never the sealed material — mirroring the BYOK secret store.
export type OrgSsoConfigRecord = {
  orgId: string
  protocol: SsoProtocol
  enabled: boolean
  // SSO-only: when true, non-SSO (local/OIDC-end-user) logins for a member whose email
  // domain is verified for this org are rejected — the org's members MUST come through SSO.
  enforced: boolean
  displayName: string | null
  verifiedDomains: string[]
  domainVerificationToken: string
  // OIDC provider config.
  oidcIssuer: string | null
  oidcClientId: string | null
  oidcClientSecretCiphertext: string | null
  // SAML 2.0 provider config.
  samlEntityId: string | null
  samlAcsUrl: string | null
  samlSloUrl: string | null
  samlIdpEntityId: string | null
  samlIdpSsoUrl: string | null
  samlIdpMetadataUrl: string | null
  samlIdpCertificateCiphertext: string | null
  // SCIM 2.0 provisioning.
  scimEnabled: boolean
  scimTokenHash: string | null
  createdAt: string
  updatedAt: string
}

// A partial upsert: every field is optional and MERGES onto the current record (or the
// defaults for a new record). `undefined` preserves; an explicit `null` clears a
// nullable field. This mirrors the managed-policy upsert semantics so config CRUD can
// patch one field without wiping the rest.
export type UpsertOrgSsoConfigInput = {
  orgId: string
  protocol?: SsoProtocol
  enabled?: boolean | null
  enforced?: boolean | null
  displayName?: string | null
  verifiedDomains?: readonly string[] | null
  domainVerificationToken?: string | null
  oidcIssuer?: string | null
  oidcClientId?: string | null
  oidcClientSecretCiphertext?: string | null
  samlEntityId?: string | null
  samlAcsUrl?: string | null
  samlSloUrl?: string | null
  samlIdpEntityId?: string | null
  samlIdpSsoUrl?: string | null
  samlIdpMetadataUrl?: string | null
  samlIdpCertificateCiphertext?: string | null
  scimEnabled?: boolean | null
  scimTokenHash?: string | null
  updatedAt?: Date
  actor?: AuditActorInput
}

// The public projection returned by the service: sealed material is reduced to booleans.
export type PublicOrgSsoConfig = Omit<
  OrgSsoConfigRecord,
  'oidcClientSecretCiphertext' | 'samlIdpCertificateCiphertext' | 'scimTokenHash'
> & {
  hasOidcClientSecret: boolean
  hasSamlIdpCertificate: boolean
  hasScimToken: boolean
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const HTTPS_URL_MAX_LENGTH = 2048
const MAX_VERIFIED_DOMAINS = 64

export function isSsoProtocol(value: unknown): value is SsoProtocol {
  return value === 'saml' || value === 'oidc'
}

export function normalizeSsoProtocol(value: unknown): SsoProtocol {
  if (!isSsoProtocol(value)) throw new Error('SSO protocol must be "saml" or "oidc".')
  return value
}

// A verified domain is a lowercase DNS name the org has proven ownership of. The
// enforcement + email→org resolution keys off this list, so it is validated strictly
// (no wildcards, no schemes) and deduped/sorted for a stable record.
export function normalizeVerifiedDomains(values: readonly unknown[] | null | undefined): string[] {
  if (values === null || values === undefined) return []
  if (!Array.isArray(values)) throw new Error('SSO verified domains must be an array.')
  const seen = new Set<string>()
  for (const value of values) {
    const domain = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!DOMAIN_PATTERN.test(domain)) throw new Error(`SSO verified domain "${String(value)}" is not a valid domain name.`)
    seen.add(domain)
  }
  if (seen.size > MAX_VERIFIED_DOMAINS) throw new Error(`SSO configuration allows at most ${MAX_VERIFIED_DOMAINS} verified domains.`)
  return [...seen].sort()
}

export function normalizeHttpsUrl(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  if (text.length > HTTPS_URL_MAX_LENGTH) throw new Error(`${label} exceeds ${HTTPS_URL_MAX_LENGTH} characters.`)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https.`)
  return parsed.toString()
}

export function generateDomainVerificationToken(): string {
  return `ocw-sso-verify-${randomBytes(24).toString('base64url')}`
}

// The email domain used to route a login to its org SSO config (the substring after @).
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain || null
}

// The neutral defaults for a brand-new org SSO record before any field is patched in.
export function defaultOrgSsoConfig(orgId: string, protocol: SsoProtocol, now: string): OrgSsoConfigRecord {
  return {
    orgId,
    protocol,
    enabled: false,
    enforced: false,
    displayName: null,
    verifiedDomains: [],
    domainVerificationToken: generateDomainVerificationToken(),
    oidcIssuer: null,
    oidcClientId: null,
    oidcClientSecretCiphertext: null,
    samlEntityId: null,
    samlAcsUrl: null,
    samlSloUrl: null,
    samlIdpEntityId: null,
    samlIdpSsoUrl: null,
    samlIdpMetadataUrl: null,
    samlIdpCertificateCiphertext: null,
    scimEnabled: false,
    scimTokenHash: null,
    createdAt: now,
    updatedAt: now,
  }
}

const DISPLAY_NAME_MAX_LENGTH = 128
const CLIENT_ID_MAX_LENGTH = 512
const ENTITY_ID_MAX_LENGTH = 1024

function normalizeNullableText(value: string | null | undefined, maxLength: number, label: string): string | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (!text) return null
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return text
}

// The single, store-agnostic merge: apply a partial upsert onto the current record (or
// the defaults for a new org). `undefined` preserves a field; an explicit `null` clears
// a nullable one. Both the in-memory and Postgres stores call this so their merge
// semantics can never drift (parity-tested). Pure: it validates + shapes only, never
// seals secrets (the service does that before the ciphertext reaches the store).
export function mergeOrgSsoConfig(
  existing: OrgSsoConfigRecord | null,
  input: UpsertOrgSsoConfigInput,
  now: string,
): OrgSsoConfigRecord {
  const protocol = input.protocol ? normalizeSsoProtocol(input.protocol) : existing?.protocol ?? 'oidc'
  const base = existing ?? defaultOrgSsoConfig(input.orgId, protocol, now)
  const passthrough = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next)
  return {
    orgId: input.orgId,
    protocol,
    enabled: input.enabled ?? base.enabled,
    enforced: input.enforced ?? base.enforced,
    displayName: input.displayName === undefined
      ? base.displayName
      : normalizeNullableText(input.displayName, DISPLAY_NAME_MAX_LENGTH, 'SSO display name'),
    verifiedDomains: input.verifiedDomains === undefined ? base.verifiedDomains : normalizeVerifiedDomains(input.verifiedDomains),
    domainVerificationToken: input.domainVerificationToken?.trim() || base.domainVerificationToken,
    oidcIssuer: input.oidcIssuer === undefined ? base.oidcIssuer : normalizeHttpsUrl(input.oidcIssuer, 'OIDC issuer'),
    oidcClientId: input.oidcClientId === undefined ? base.oidcClientId : normalizeNullableText(input.oidcClientId, CLIENT_ID_MAX_LENGTH, 'OIDC client id'),
    oidcClientSecretCiphertext: passthrough(input.oidcClientSecretCiphertext, base.oidcClientSecretCiphertext),
    samlEntityId: input.samlEntityId === undefined ? base.samlEntityId : normalizeNullableText(input.samlEntityId, ENTITY_ID_MAX_LENGTH, 'SAML entity id'),
    samlAcsUrl: input.samlAcsUrl === undefined ? base.samlAcsUrl : normalizeHttpsUrl(input.samlAcsUrl, 'SAML ACS URL'),
    samlSloUrl: input.samlSloUrl === undefined ? base.samlSloUrl : normalizeHttpsUrl(input.samlSloUrl, 'SAML SLO URL'),
    samlIdpEntityId: input.samlIdpEntityId === undefined ? base.samlIdpEntityId : normalizeNullableText(input.samlIdpEntityId, ENTITY_ID_MAX_LENGTH, 'SAML IdP entity id'),
    samlIdpSsoUrl: input.samlIdpSsoUrl === undefined ? base.samlIdpSsoUrl : normalizeHttpsUrl(input.samlIdpSsoUrl, 'SAML IdP SSO URL'),
    samlIdpMetadataUrl: input.samlIdpMetadataUrl === undefined ? base.samlIdpMetadataUrl : normalizeHttpsUrl(input.samlIdpMetadataUrl, 'SAML IdP metadata URL'),
    samlIdpCertificateCiphertext: passthrough(input.samlIdpCertificateCiphertext, base.samlIdpCertificateCiphertext),
    scimEnabled: input.scimEnabled ?? base.scimEnabled,
    scimTokenHash: passthrough(input.scimTokenHash, base.scimTokenHash),
    createdAt: base.createdAt,
    updatedAt: now,
  }
}

// Reduce the internal record to its public projection (sealed material → booleans).
export function toPublicOrgSsoConfig(record: OrgSsoConfigRecord): PublicOrgSsoConfig {
  const {
    oidcClientSecretCiphertext,
    samlIdpCertificateCiphertext,
    scimTokenHash,
    ...rest
  } = record
  return {
    ...rest,
    hasOidcClientSecret: oidcClientSecretCiphertext !== null,
    hasSamlIdpCertificate: samlIdpCertificateCiphertext !== null,
    hasScimToken: scimTokenHash !== null,
  }
}
