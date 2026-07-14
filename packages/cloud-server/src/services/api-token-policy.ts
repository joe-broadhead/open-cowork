import type { ApiTokenRecord, ApiTokenScope } from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const DEFAULT_API_TOKEN_TTL_MS = 90 * DAY_MS
const MAX_API_TOKEN_TTL_MS = 365 * DAY_MS
const DEFAULT_API_TOKEN_ALLOWED_SCOPES = new Set<ApiTokenScope>(['desktop', 'gateway', 'admin', 'operator'])

export type PublicApiTokenRecord = Omit<ApiTokenRecord, 'tokenHash'> & {
  channelBindingIds: string[]
}

export type CloudOrgMode = 'multi-org' | 'single-org'

export type CloudIdentityPolicy = {
  allowSelfServiceSignup: boolean
  signupMode?: 'disabled' | 'invite' | 'domain' | 'open'
  allowedEmailDomains?: readonly string[]
  apiTokenDefaultTtlMs?: number | null
  apiTokenMaxTtlMs?: number | null
  apiTokenAllowedScopes?: readonly string[] | null
  // Deployment topology. In `single-org` (self-host) mode every principal is
  // funneled into one auto-bootstrapped org and tenant-switching is skipped;
  // `multi-org` (default) preserves the multi-tenant behaviour.
  orgMode?: CloudOrgMode
  singleOrgId?: string
  singleOrgName?: string
}

export const DEFAULT_SINGLE_ORG_ID = 'default'
export const DEFAULT_SINGLE_ORG_NAME = 'Default Organization'

export function resolvedOrgMode(policy: CloudIdentityPolicy): CloudOrgMode {
  return policy.orgMode === 'single-org' ? 'single-org' : 'multi-org'
}

export function publicApiToken(token: ApiTokenRecord, channelBindingIds: readonly string[] = []): PublicApiTokenRecord {
  const { tokenHash: _tokenHash, ...publicToken } = token
  return {
    ...publicToken,
    channelBindingIds: [...new Set(channelBindingIds)].sort(),
  }
}

export function resolvedSignupMode(policy: CloudIdentityPolicy): 'disabled' | 'invite' | 'domain' | 'open' {
  if (policy.signupMode) return policy.signupMode
  if (!policy.allowSelfServiceSignup) return 'invite'
  return policy.allowedEmailDomains?.length ? 'domain' : 'open'
}

export function normalizeApiTokenScopes(scopes: ApiTokenScope[] | undefined | null): ApiTokenScope[] {
  const allowed = new Set<ApiTokenScope>(['desktop', 'gateway', 'admin', 'operator', 'worker-internal'])
  if ((scopes || []).some((scope) => !allowed.has(scope))) {
    throw new CloudServiceError(400, 'API token includes an unsupported scope.')
  }
  const normalized = [...new Set(scopes || [])]
  if (normalized.length === 0) throw new CloudServiceError(400, 'API token requires at least one valid scope.')
  return normalized
}

function positivePolicyMs(value: number | null | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

export function normalizeApiTokenExpiresAt(input: Date | null | undefined, policy: CloudIdentityPolicy, now = new Date()) {
  const defaultTtlMs = positivePolicyMs(policy.apiTokenDefaultTtlMs, DEFAULT_API_TOKEN_TTL_MS)
  const maxTtlMs = positivePolicyMs(policy.apiTokenMaxTtlMs, MAX_API_TOKEN_TTL_MS)
  if (defaultTtlMs > maxTtlMs) {
    throw new CloudServiceError(500, 'API token default TTL cannot exceed the max TTL policy.')
  }
  const expiresAt = input || new Date(now.getTime() + defaultTtlMs)
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    throw new CloudServiceError(400, 'API token expiration must be in the future.')
  }
  if (expiresAt.getTime() - now.getTime() > maxTtlMs) {
    throw new CloudServiceError(400, `API token expiration cannot be more than ${Math.floor(maxTtlMs / DAY_MS)} days in the future.`)
  }
  return expiresAt
}

function normalizeAllowedApiTokenScopePolicy(policy: CloudIdentityPolicy) {
  const configured = policy.apiTokenAllowedScopes?.length
    ? policy.apiTokenAllowedScopes
    : [...DEFAULT_API_TOKEN_ALLOWED_SCOPES]
  const normalized = normalizeApiTokenScopes(configured as ApiTokenScope[])
  return new Set<ApiTokenScope>(normalized)
}

export function enforceApiTokenScopePolicy(scopes: ApiTokenScope[], policy: CloudIdentityPolicy) {
  const allowed = normalizeAllowedApiTokenScopePolicy(policy)
  const denied = scopes.filter((scope) => !allowed.has(scope))
  if (denied.length > 0) {
    throw new CloudServiceError(403, `API token scope is disabled by cloud policy: ${denied.join(', ')}.`)
  }
  return scopes
}
