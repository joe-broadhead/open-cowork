import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type {
  ManagedDesktopPolicy,
  ManagedPolicyExtensionClasses,
  ManagedPolicyPermissionCeiling,
  ManagedPolicyPermissionCeilings,
  ManagedPolicyPermissionDimension,
} from '@open-cowork/shared'
import { MANAGED_POLICY_PERMISSION_DIMENSIONS } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader-core.js'

// Runtime-host enforcement of the org-managed workspace & desktop policy (#898). This
// is the "tighten never loosen" seam: the desktop delivers the effective policy (from
// the cloud config path) and the runtime clamps its permission maxima STRICTER, scopes
// providers/models, and gates extension classes — it can never make a permission more
// permissive than the app-config ceiling already allows. Enforcement is offline-safe:
// the last-known policy is persisted to disk, so a set survives a restart and keeps
// enforcing even when the cloud is unreachable (the desktop simply does not clear it on
// a fetch failure). An org with no policy — and any individual with no org — resolves
// to EMPTY_MANAGED_POLICY, which is a no-op, so behaviour is unchanged for them.

export type ManagedPolicyLevel = ManagedPolicyPermissionCeiling

// The unrestricted baseline: no clamping, no allow/deny lists, every extension class on.
export const EMPTY_MANAGED_POLICY: ManagedDesktopPolicy = {
  allowedProviders: null,
  deniedProviders: [],
  allowedModels: null,
  deniedModels: [],
  keyManagement: 'any',
  extensions: { customProviders: true, customMcps: true, customSkills: true },
  features: {},
  permissionCeilings: {
    bash: 'allow',
    fileWrite: 'allow',
    web: 'allow',
    webSearch: 'allow',
    task: 'allow',
    mcp: 'allow',
    externalDirectory: 'allow',
  },
  updateChannel: null,
}

const LEVEL_RANK: Record<ManagedPolicyLevel, number> = { deny: 0, ask: 1, allow: 2 }

function isLevel(value: unknown): value is ManagedPolicyLevel {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

// Take the MORE RESTRICTIVE of the two levels — the whole contract of the org layer.
// An unknown/absent ceiling defaults to 'allow' (no clamp) so a partial policy is safe.
export function clampLevelToCeiling(level: ManagedPolicyLevel, ceiling: ManagedPolicyLevel | undefined): ManagedPolicyLevel {
  const bound = isLevel(ceiling) ? ceiling : 'allow'
  return LEVEL_RANK[level] <= LEVEL_RANK[bound] ? level : bound
}

// Clamp a single runtime permission dimension against the policy ceiling.
export function clampManagedPolicyDimension(
  level: ManagedPolicyLevel,
  dimension: ManagedPolicyPermissionDimension,
  policy: ManagedDesktopPolicy | null | undefined,
): ManagedPolicyLevel {
  if (!policy) return level
  return clampLevelToCeiling(level, policy.permissionCeilings?.[dimension])
}

// Clamp every runtime permission dimension against the policy in one pass.
export function clampManagedPolicyPermissions(
  base: ManagedPolicyPermissionCeilings,
  policy: ManagedDesktopPolicy | null | undefined,
): ManagedPolicyPermissionCeilings {
  if (!policy) return { ...base }
  const clamped = {} as ManagedPolicyPermissionCeilings
  for (const dimension of MANAGED_POLICY_PERMISSION_DIMENSIONS) {
    clamped[dimension] = clampLevelToCeiling(base[dimension], policy.permissionCeilings?.[dimension])
  }
  return clamped
}

export function isProviderAllowedByManagedPolicy(providerId: string, policy: ManagedDesktopPolicy | null | undefined): boolean {
  if (!policy) return true
  if (policy.deniedProviders.includes(providerId)) return false
  if (policy.allowedProviders !== null && !policy.allowedProviders.includes(providerId)) return false
  return true
}

// Scope an available-provider list to the policy: drop denied ids, and intersect with
// the allow-list when one is set. Never widens the list.
export function filterProvidersByManagedPolicy(available: readonly string[], policy: ManagedDesktopPolicy | null | undefined): string[] {
  if (!policy) return [...available]
  return available.filter((providerId) => isProviderAllowedByManagedPolicy(providerId, policy))
}

export function isModelAllowedByManagedPolicy(modelId: string, policy: ManagedDesktopPolicy | null | undefined): boolean {
  if (!policy) return true
  if (policy.deniedModels.includes(modelId)) return false
  if (policy.allowedModels !== null && !policy.allowedModels.includes(modelId)) return false
  return true
}

export function isManagedPolicyExtensionClassEnabled(
  policy: ManagedDesktopPolicy | null | undefined,
  extensionClass: keyof ManagedPolicyExtensionClasses,
): boolean {
  if (!policy) return true
  return policy.extensions[extensionClass] !== false
}

// --- Active policy singleton + offline-safe persistence ---------------------------

let activePolicy: ManagedDesktopPolicy | null = null
let loadedFromDisk = false

function policyCachePath(): string {
  return join(getAppDataDir(), 'managed-policy.json')
}

function readPersistedManagedPolicy(): ManagedDesktopPolicy | null {
  try {
    const path = policyCachePath()
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ManagedDesktopPolicy
    return parsed && typeof parsed === 'object' && parsed.permissionCeilings ? parsed : null
  } catch {
    return null
  }
}

// The policy the runtime currently enforces: the in-memory value, else the last-known
// persisted value (offline-safe), else the unrestricted baseline.
export function getActiveManagedPolicy(): ManagedDesktopPolicy {
  if (activePolicy) return activePolicy
  if (!loadedFromDisk) {
    loadedFromDisk = true
    activePolicy = readPersistedManagedPolicy()
    if (activePolicy) return activePolicy
  }
  return EMPTY_MANAGED_POLICY
}

// Set the enforced policy and persist it for offline-safety. Passing null CLEARS the
// policy (explicit sign-out / org removal) and deletes the cache; callers must NOT pass
// null on a mere fetch failure — leaving the last policy in place is what keeps offline
// enforcement working.
export function setActiveManagedPolicy(policy: ManagedDesktopPolicy | null): void {
  activePolicy = policy
  loadedFromDisk = true
  try {
    const path = policyCachePath()
    if (policy) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(policy), 'utf8')
    } else if (existsSync(path)) {
      rmSync(path, { force: true })
    }
  } catch {
    // Best-effort persistence; in-memory enforcement still applies this process.
  }
}

// Reset only the in-memory state (re-reads disk on next access). For tests.
export function resetActiveManagedPolicyCache(): void {
  activePolicy = null
  loadedFromDisk = false
}
