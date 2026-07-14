import { CAPABILITY_BUNDLE_FORMAT } from '@open-cowork/shared'
import { evaluateHttpMcpUrl } from './mcp-url-policy.js'
import type {
  CapabilityBundleCompatibilityTier,
  CapabilityBundleInstallPlan,
  CapabilityBundleInstallPlanAction,
  CapabilityBundleIssue,
  CapabilityBundleLifecycleAction,
  CapabilityBundleLifecycleApplyResult,
  CapabilityBundleLifecycleAuditEvent,
  CapabilityBundleLifecycleBundle,
  CapabilityBundleLifecycleOutcome,
  CapabilityBundleLifecycleOwner,
  CapabilityBundleLifecycleResource,
  CapabilityBundleLifecycleState,
  CapabilityBundleManifest,
  CapabilityBundlePermission,
  CapabilityBundlePermissionKind,
  CapabilityBundleProductMode,
  CapabilityBundleResource,
  CapabilityBundleResourceIdentity,
  CapabilityBundleResourceKind,
  CapabilityBundleResourceSelector,
  CapabilityBundleRuntimeBundleCheck,
  CapabilityBundleRuntimeResourceCheck,
  CapabilityBundleRuntimeSupportReport,
  CapabilityBundleRuntimeSupportStatus,
  CapabilityBundleUninstallPlan,
  CapabilityBundleUpdatePlan,
  CapabilityRiskLevel,
} from '@open-cowork/shared'

// The capability-bundle install/uninstall/update ENGINE — manifest normalization,
// runtime-support validation, and plan/apply lifecycle logic — extracted out of
// the (otherwise types-only) capabilities.ts so the runtime engine no longer
// lives mixed into the type contract. Pure logic; it imports the type vocabulary
// it operates on from ./capabilities.ts.

const PRODUCT_MODES = new Set<CapabilityBundleProductMode>([
  'desktop-local',
  'desktop-cloud',
  'cloud-web',
  'cloud-channel-gateway',
  'standalone-gateway',
  'paired-desktop',
  'headless-host',
])
const COMPATIBILITY_TIERS = new Set<CapabilityBundleCompatibilityTier>(['supported', 'experimental', 'blocked', 'unsupported'])
const RESOURCE_KINDS = new Set<CapabilityBundleResourceKind>(['opencode-plugin', 'skill', 'agent', 'mcp', 'provider', 'workflow', 'command', 'native-helper'])
const PERMISSION_KINDS = new Set<CapabilityBundlePermissionKind>(['provider', 'filesystem', 'mcp', 'shell', 'workflow', 'plugin', 'network', 'credential'])
const EXACT_BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const RISK_RANK: Record<CapabilityRiskLevel, number> = { low: 0, medium: 1, high: 2 }

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readExactId(value: unknown) {
  const id = readNonEmptyString(value)
  return id && EXACT_BUNDLE_ID_PATTERN.test(id) ? id : null
}

function resourceIdentityKey(identity: Pick<CapabilityBundleResourceIdentity, 'kind' | 'id'>) {
  return `${identity.kind}:${identity.id}`
}

function cloneResourceSelector(selector: CapabilityBundleResourceSelector): CapabilityBundleResourceSelector {
  return { ...selector }
}

function resourceIdentity(resource: CapabilityBundleResource | CapabilityBundleLifecycleResource): CapabilityBundleResourceIdentity {
  return { kind: resource.kind, id: resource.id }
}

function isResourceKind(value: unknown): value is CapabilityBundleResourceKind {
  return typeof value === 'string' && RESOURCE_KINDS.has(value as CapabilityBundleResourceKind)
}

type ResourceIdentitySet = {
  exact: Set<string>
}

function createResourceIdentitySet(identities: CapabilityBundleResourceSelector[] = []): ResourceIdentitySet {
  const exact = new Set<string>()
  for (const identity of identities) {
    if (!identity || typeof identity !== 'object') continue
    if (!isResourceKind(identity.kind) || !readExactId(identity.id)) continue
    exact.add(resourceIdentityKey(identity))
  }
  return { exact }
}

function resourceIdentitySetIsEmpty(set: ResourceIdentitySet) {
  return set.exact.size === 0
}

function resourceIdentitySetHasResource(set: ResourceIdentitySet, resource: Pick<CapabilityBundleResourceIdentity, 'kind' | 'id'>) {
  return set.exact.has(resourceIdentityKey(resource))
}

type CapabilityBundleResourceCandidate = {
  kind: CapabilityBundleResourceKind | 'bundle'
  id: string
  resource: CapabilityBundleResource | null
}

function candidateKey(candidate: CapabilityBundleResourceCandidate) {
  return `${candidate.kind}:${candidate.id}`
}

function resourceCandidateFromSelector(
  selector: CapabilityBundleResourceSelector,
  resources: CapabilityBundleResource[],
): CapabilityBundleResourceCandidate[] {
  const resource = resources.find((entry) => resourceIdentityKey(entry) === resourceIdentityKey(selector)) || null
  return [{ kind: resource?.kind || selector.kind, id: selector.id, resource }]
}

function resourceIdentitySetHasCandidate(set: ResourceIdentitySet, candidate: CapabilityBundleResourceCandidate) {
  if (candidate.resource) return resourceIdentitySetHasResource(set, candidate.resource)
  if (candidate.kind !== 'bundle' && set.exact.has(resourceIdentityKey({ kind: candidate.kind, id: candidate.id }))) return true
  return false
}

function installActionResourceKey(action: CapabilityBundleInstallPlanAction) {
  return isResourceKind(action.kind) ? resourceIdentityKey({ kind: action.kind, id: action.id }) : null
}

function maxRisk(left: CapabilityRiskLevel, right: CapabilityRiskLevel): CapabilityRiskLevel {
  return RISK_RANK[right] > RISK_RANK[left] ? right : left
}

function pushIssue(issues: CapabilityBundleIssue[], code: string, message: string, resourceId?: string) {
  issues.push({ code, message, ...(resourceId ? { resourceId } : {}) })
}

function normalizeResource(value: unknown, issues: CapabilityBundleIssue[], index: number): CapabilityBundleResource | null {
  const record = asRecord(value)
  const kind = readNonEmptyString(record.kind)
  const id = readExactId(record.id)
  const label = id || `resource[${index}]`
  if (!kind || !RESOURCE_KINDS.has(kind as CapabilityBundleResourceKind)) {
    pushIssue(issues, 'invalid_resource_kind', `Bundle resource ${label} has an unsupported kind.`, id || undefined)
    return null
  }
  if (!id) {
    pushIssue(issues, 'invalid_resource_id', `Bundle resource ${label} must use an exact canonical id.`, undefined)
    return null
  }
  const productModes = Array.isArray(record.productModes)
    ? record.productModes.filter((mode): mode is CapabilityBundleProductMode => typeof mode === 'string' && PRODUCT_MODES.has(mode as CapabilityBundleProductMode))
    : undefined
  const compatibilityTier = typeof record.compatibilityTier === 'string' && COMPATIBILITY_TIERS.has(record.compatibilityTier as CapabilityBundleCompatibilityTier)
    ? record.compatibilityTier as CapabilityBundleCompatibilityTier
    : undefined
  if (kind === 'opencode-plugin' && !compatibilityTier) {
    pushIssue(issues, 'plugin_compatibility_required', `OpenCode plugin ${id} must declare a compatibility tier.`, id)
  }
  return {
    kind: kind as CapabilityBundleResourceKind,
    id,
    ...(readNonEmptyString(record.title) ? { title: readNonEmptyString(record.title) || undefined } : {}),
    ...(readNonEmptyString(record.source) ? { source: readNonEmptyString(record.source) || undefined } : {}),
    ...(record.ownedByBundle === true ? { ownedByBundle: true } : {}),
    ...(productModes && productModes.length > 0 ? { productModes } : {}),
    ...(compatibilityTier ? { compatibilityTier } : {}),
    ...(readNonEmptyString(record.url) ? { url: readNonEmptyString(record.url) || undefined } : {}),
    ...(readNonEmptyString(record.command) ? { command: readNonEmptyString(record.command) || undefined } : {}),
  }
}

function normalizePermission(value: unknown, issues: CapabilityBundleIssue[], index: number): CapabilityBundlePermission | null {
  const record = asRecord(value)
  const kind = readNonEmptyString(record.kind)
  const id = readExactId(record.id)
  const label = id || `permission[${index}]`
  if (!kind || !PERMISSION_KINDS.has(kind as CapabilityBundlePermissionKind)) {
    pushIssue(issues, 'invalid_permission_kind', `Bundle permission ${label} has an unsupported kind.`, id || undefined)
    return null
  }
  if (!id) {
    pushIssue(issues, 'invalid_permission_id', `Bundle permission ${label} must use an exact canonical id.`, undefined)
    return null
  }
  const reason = readNonEmptyString(record.reason)
  if (!reason) pushIssue(issues, 'permission_reason_required', `Bundle permission ${id} must explain why it is needed.`, id)
  return {
    kind: kind as CapabilityBundlePermissionKind,
    id,
    reason: reason || '',
    ...(record.required === false ? { required: false } : { required: true }),
  }
}

function normalizeResourceSelector(value: unknown, issues: CapabilityBundleIssue[], field: string, index: number): CapabilityBundleResourceSelector | null {
  const record = asRecord(value)
  const kind = readNonEmptyString(record.kind)
  const id = readExactId(record.id)
  const label = id || `${field}[${index}]`
  if (!kind || !RESOURCE_KINDS.has(kind as CapabilityBundleResourceKind)) {
    pushIssue(issues, 'invalid_uninstall_resource_kind', `Bundle uninstall resource ${label} has an unsupported kind.`, id || undefined)
    return null
  }
  if (!id) {
    pushIssue(issues, 'invalid_uninstall_resource_id', `Bundle uninstall ${field}[${index}] must use an exact canonical id.`)
    return null
  }
  return { kind: kind as CapabilityBundleResourceKind, id }
}

function normalizeResourceSelectors(value: unknown, issues: CapabilityBundleIssue[], field: string) {
  return Array.isArray(value)
    ? value.map((entry, index) => normalizeResourceSelector(entry, issues, field, index)).filter((entry): entry is CapabilityBundleResourceSelector => Boolean(entry))
    : []
}

export function normalizeCapabilityBundleManifest(
  input: unknown,
): { ok: true; manifest: CapabilityBundleManifest } | { ok: false; issues: CapabilityBundleIssue[] } {
  const issues: CapabilityBundleIssue[] = []
  const record = asRecord(input)
  if (Object.keys(record).length === 0) {
    return { ok: false, issues: [{ code: 'invalid_manifest', message: 'Capability bundle manifest must be a JSON object.' }] }
  }
  if (record.format !== CAPABILITY_BUNDLE_FORMAT) {
    pushIssue(issues, 'invalid_format', `Capability bundle format must be ${CAPABILITY_BUNDLE_FORMAT}.`)
  }
  const name = readNonEmptyString(record.name)
  const version = readNonEmptyString(record.version)
  const owner = readNonEmptyString(record.owner)
  if (!name) pushIssue(issues, 'name_required', 'Capability bundle name is required.')
  if (!version) pushIssue(issues, 'version_required', 'Capability bundle version is required.')
  if (!owner) pushIssue(issues, 'owner_required', 'Capability bundle owner is required.')

  let resources: CapabilityBundleResource[] = []
  if (Array.isArray(record.resources)) {
    resources = record.resources.map((entry, index) => normalizeResource(entry, issues, index)).filter((entry): entry is CapabilityBundleResource => Boolean(entry))
  } else if (record.resources === undefined) {
    pushIssue(issues, 'resources_required', 'Capability bundle resources must be declared as an array.')
  } else {
    pushIssue(issues, 'invalid_resources', 'Capability bundle resources must be an array.')
  }

  let permissions: CapabilityBundlePermission[] = []
  if (Array.isArray(record.permissions)) {
    permissions = record.permissions.map((entry, index) => normalizePermission(entry, issues, index)).filter((entry): entry is CapabilityBundlePermission => Boolean(entry))
  } else if (record.permissions === undefined) {
    pushIssue(issues, 'permissions_required', 'Capability bundle permissions must be declared as an array.')
  } else {
    pushIssue(issues, 'invalid_permissions', 'Capability bundle permissions must be an array.')
  }
  const compatibilityRecord = asRecord(record.compatibility)
  const rawProductModes = asRecord(compatibilityRecord.productModes)
  const productModes = Object.fromEntries(Object.entries(rawProductModes).flatMap(([mode, tier]) => {
    if (!PRODUCT_MODES.has(mode as CapabilityBundleProductMode) || !COMPATIBILITY_TIERS.has(tier as CapabilityBundleCompatibilityTier)) return []
    return [[mode, tier]]
  })) as Partial<Record<CapabilityBundleProductMode, CapabilityBundleCompatibilityTier>>
  const uninstallRecord = asRecord(record.uninstall)
  const uninstallRemoves = normalizeResourceSelectors(uninstallRecord.removes, issues, 'removes')
  const uninstallPreserves = normalizeResourceSelectors(uninstallRecord.preserves, issues, 'preserves')

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    manifest: {
      format: CAPABILITY_BUNDLE_FORMAT,
      name: name || '',
      version: version || '',
      owner: owner || '',
      compatibility: {
        ...(readNonEmptyString(compatibilityRecord.opencode) ? { opencode: readNonEmptyString(compatibilityRecord.opencode) || undefined } : {}),
        ...(Object.keys(productModes).length > 0 ? { productModes } : {}),
      },
      resources,
      permissions,
      uninstall: {
        removes: uninstallRemoves,
        preserves: uninstallPreserves,
      },
    },
  }
}

function mcpUrlIsPrivateOrLocal(rawUrl: string) {
  // Delegate to the shared SSRF policy (audit P2-4) instead of a hand-rolled regex that classified
  // 169.254.169.254 (cloud metadata) and IPv6-mapped/NAT64 private addresses as public. Returns true
  // when the URL is local/private/metadata/unsupported (i.e. should be blocked).
  return !evaluateHttpMcpUrl(rawUrl).ok
}

function commandHasShellHazard(command: string) {
  return /(?:^|\s)(?:sudo|su)\s/.test(command) || /[;&|`$<>]/.test(command) || /\brm\s+-rf\b/.test(command)
}

function permissionRisk(permission: CapabilityBundlePermission): CapabilityRiskLevel {
  if (permission.kind === 'filesystem' || permission.kind === 'shell' || permission.kind === 'plugin' || permission.kind === 'credential') return 'high'
  if (permission.kind === 'provider' || permission.kind === 'mcp' || permission.kind === 'network') return 'medium'
  return 'low'
}

function isRemoteCapabilityBundleMode(productMode: CapabilityBundleProductMode) {
  return productMode !== 'desktop-local'
}

function addResourceRuntimeCheck(
  checks: CapabilityBundleRuntimeResourceCheck[],
  resource: CapabilityBundleResource,
  status: CapabilityBundleRuntimeSupportStatus,
  reason: string,
) {
  checks.push({
    kind: resource.kind,
    id: resource.id,
    status,
    reason,
    ...(resource.compatibilityTier ? { compatibilityTier: resource.compatibilityTier } : {}),
    ...(resource.productModes ? { productModes: [...resource.productModes] } : {}),
  })
}

function checkCapabilityBundleRuntimeSupport(
  manifest: CapabilityBundleManifest,
  productMode: CapabilityBundleProductMode,
): CapabilityBundleRuntimeBundleCheck {
  const blockers: CapabilityBundleIssue[] = []
  const warnings: CapabilityBundleIssue[] = []
  const resources: CapabilityBundleRuntimeResourceCheck[] = []
  const remoteMode = isRemoteCapabilityBundleMode(productMode)
  const modeTier = manifest.compatibility?.productModes?.[productMode] || 'unsupported'

  if (modeTier === 'unsupported' || modeTier === 'blocked') {
    pushIssue(blockers, 'product_mode_unsupported', `Bundle ${manifest.name} is ${modeTier} for ${productMode}.`)
  } else if (modeTier === 'experimental') {
    pushIssue(warnings, 'product_mode_experimental', `Bundle ${manifest.name} is experimental for ${productMode}.`)
  }

  for (const resource of [...manifest.resources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    if (resource.productModes && !resource.productModes.includes(productMode)) {
      pushIssue(blockers, 'resource_product_mode_unsupported', `Resource ${resource.id} is not available in ${productMode}.`, resource.id)
      addResourceRuntimeCheck(resources, resource, 'blocked', 'Resource does not support this product mode.')
      continue
    }

    if (
      remoteMode
      && (resource.kind === 'opencode-plugin' || resource.kind === 'native-helper')
      && !resource.productModes?.includes(productMode)
    ) {
      pushIssue(blockers, 'resource_product_mode_required', `Resource ${resource.id} must explicitly list ${productMode} before it can load in a remote or cloud runtime.`, resource.id)
      addResourceRuntimeCheck(resources, resource, 'blocked', 'Remote and cloud runtime modes require explicit resource product-mode support.')
      continue
    }

    if (resource.kind === 'opencode-plugin') {
      const tier = resource.compatibilityTier || 'unsupported'
      if (tier === 'blocked' || tier === 'unsupported') {
        pushIssue(blockers, 'plugin_compatibility_blocked', `Plugin ${resource.id} is ${tier} for ${productMode}.`, resource.id)
        addResourceRuntimeCheck(resources, resource, 'blocked', `Plugin compatibility tier is ${tier}.`)
        continue
      }
      if (remoteMode && tier !== 'supported') {
        pushIssue(blockers, 'plugin_remote_compatibility_required', `Plugin ${resource.id} must be supported before it can load in ${productMode}.`, resource.id)
        addResourceRuntimeCheck(resources, resource, 'blocked', 'Remote and cloud runtime modes require supported plugin compatibility.')
        continue
      }
      if (tier === 'experimental') {
        pushIssue(warnings, 'plugin_compatibility_experimental', `Plugin ${resource.id} is experimental.`, resource.id)
        addResourceRuntimeCheck(resources, resource, 'experimental', 'Plugin is experimental and requires review.')
        continue
      }
    }

    if (resource.kind === 'mcp') {
      if (resource.url && mcpUrlIsPrivateOrLocal(resource.url)) {
        pushIssue(blockers, 'mcp_url_blocked', `MCP ${resource.id} uses a local, private, or unsupported URL.`, resource.id)
        addResourceRuntimeCheck(resources, resource, 'blocked', 'MCP URL is local, private, or unsupported.')
        continue
      }
      if (resource.command) {
        if (remoteMode) {
          pushIssue(blockers, 'mcp_stdio_unsupported_product_mode', `MCP ${resource.id} uses stdio, which cannot be loaded in ${productMode}.`, resource.id)
          addResourceRuntimeCheck(resources, resource, 'blocked', 'Remote and cloud runtime modes cannot launch local stdio MCP commands.')
          continue
        }
        if (commandHasShellHazard(resource.command)) {
          pushIssue(blockers, 'mcp_stdio_blocked', `MCP ${resource.id} uses a hazardous stdio command.`, resource.id)
          addResourceRuntimeCheck(resources, resource, 'blocked', 'MCP stdio command requires manual review.')
          continue
        }
      }
    }

    if (resource.kind === 'native-helper') {
      pushIssue(warnings, 'native_helper_component_manifest_required', `Native helper ${resource.id} requires component manifest verification.`, resource.id)
      addResourceRuntimeCheck(resources, resource, 'experimental', 'Native helper requires component manifest verification.')
      continue
    }

    addResourceRuntimeCheck(resources, resource, 'supported', 'Resource can be loaded for this product mode.')
  }

  for (const permission of [...manifest.permissions].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    if (permission.required === false) continue
    const risk = permissionRisk(permission)
    if (risk === 'low') continue
    pushIssue(warnings, 'permission_review_required', `${permission.kind} permission ${permission.id} requires runtime policy review before use.`, permission.id)
  }

  return {
    bundleName: manifest.name,
    version: manifest.version,
    productMode,
    runtimeStartAllowed: blockers.length === 0,
    blockers,
    warnings,
    resources,
  }
}

export function validateCapabilityBundleRuntimeSupport(
  manifests: CapabilityBundleManifest[],
  options: {
    productMode: CapabilityBundleProductMode
  },
): CapabilityBundleRuntimeSupportReport {
  const bundles = manifests.map((manifest) => checkCapabilityBundleRuntimeSupport(manifest, options.productMode))
  const blockers = bundles.flatMap((bundle) => bundle.blockers.map((issue) => ({
    ...issue,
    resourceId: issue.resourceId ? `${bundle.bundleName}:${issue.resourceId}` : bundle.bundleName,
  })))
  const warnings = bundles.flatMap((bundle) => bundle.warnings.map((issue) => ({
    ...issue,
    resourceId: issue.resourceId ? `${bundle.bundleName}:${issue.resourceId}` : bundle.bundleName,
  })))

  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    productMode: options.productMode,
    runtimeStartAllowed: blockers.length === 0,
    blockers,
    warnings,
    bundles,
  }
}

export function planCapabilityBundleInstall(
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    existingResourceIds?: CapabilityBundleResourceSelector[]
  },
): CapabilityBundleInstallPlan {
  const blockers: CapabilityBundleIssue[] = []
  const actions: CapabilityBundleInstallPlanAction[] = []
  const reasons: string[] = []
  const existingResourceIds = createResourceIdentitySet(options.existingResourceIds)
  let level: CapabilityRiskLevel = 'low'
  const modeTier = manifest.compatibility?.productModes?.[options.productMode] || 'unsupported'
  if (modeTier === 'unsupported' || modeTier === 'blocked') {
    pushIssue(blockers, 'product_mode_unsupported', `Bundle ${manifest.name} is ${modeTier} for ${options.productMode}.`)
    actions.push({ action: 'block', kind: 'bundle', id: manifest.name, reason: `Product mode is ${modeTier}.` })
    level = 'high'
  } else if (modeTier === 'experimental') {
    reasons.push(`Bundle is experimental for ${options.productMode}.`)
    level = maxRisk(level, 'medium')
  }

  for (const resource of [...manifest.resources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    if (resource.productModes && !resource.productModes.includes(options.productMode)) {
      pushIssue(blockers, 'resource_product_mode_unsupported', `Resource ${resource.id} is not available in ${options.productMode}.`, resource.id)
      actions.push({ action: 'block', kind: resource.kind, id: resource.id, reason: 'Resource does not support this product mode.' })
      level = 'high'
      continue
    }
    if (resourceIdentitySetHasResource(existingResourceIds, resource)) {
      actions.push({ action: 'preserve_user_resource', kind: resource.kind, id: resource.id, reason: 'Existing resource is preserved; bundle cannot overwrite it during install.' })
      level = maxRisk(level, 'medium')
      continue
    }
    if (resource.kind === 'opencode-plugin') {
      const tier = resource.compatibilityTier || 'unsupported'
      if (tier === 'blocked' || tier === 'unsupported' || (options.productMode !== 'desktop-local' && tier !== 'supported')) {
        pushIssue(blockers, 'plugin_compatibility_blocked', `Plugin ${resource.id} is ${tier} for ${options.productMode}.`, resource.id)
        actions.push({ action: 'block', kind: resource.kind, id: resource.id, reason: `Plugin compatibility tier is ${tier}.` })
        level = 'high'
        continue
      }
      if (tier === 'experimental') {
        reasons.push(`Plugin ${resource.id} is experimental.`)
        level = maxRisk(level, 'medium')
      }
    }
    if (resource.kind === 'mcp') {
      if (resource.url && mcpUrlIsPrivateOrLocal(resource.url)) {
        pushIssue(blockers, 'mcp_url_blocked', `MCP ${resource.id} uses a local, private, or unsupported URL.`, resource.id)
        actions.push({ action: 'block', kind: resource.kind, id: resource.id, reason: 'MCP URL is local, private, or unsupported.' })
        level = 'high'
        continue
      }
      if (resource.command) {
        if (options.productMode !== 'desktop-local') {
          pushIssue(blockers, 'mcp_stdio_unsupported_product_mode', `MCP ${resource.id} uses stdio, which cannot be installed for ${options.productMode}.`, resource.id)
          actions.push({ action: 'block', kind: resource.kind, id: resource.id, reason: 'Remote and cloud runtime modes cannot launch local stdio MCP commands.' })
          level = 'high'
          continue
        }
        if (commandHasShellHazard(resource.command)) {
          pushIssue(blockers, 'mcp_stdio_blocked', `MCP ${resource.id} uses a hazardous stdio command.`, resource.id)
          actions.push({ action: 'block', kind: resource.kind, id: resource.id, reason: 'MCP stdio command requires manual review.' })
          level = 'high'
          continue
        }
      }
    }
    if (resource.kind === 'native-helper') {
      reasons.push(`Native helper ${resource.id} requires component manifest verification.`)
      level = maxRisk(level, 'high')
    }
    actions.push({ action: 'install', kind: resource.kind, id: resource.id, reason: resource.ownedByBundle ? 'Bundle-owned resource can be installed and removed by bundle lifecycle.' : 'Resource requires explicit review before install.' })
  }

  for (const permission of [...manifest.permissions].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    const risk = permissionRisk(permission)
    level = maxRisk(level, risk)
    if (risk !== 'low') reasons.push(`${permission.kind} permission ${permission.id} requires review.`)
    actions.push({ action: 'review_permission', kind: permission.kind, id: permission.id, reason: permission.reason })
  }

  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    bundleName: manifest.name,
    productMode: options.productMode,
    blocked: blockers.length > 0,
    blockers,
    actions,
    risk: {
      level,
      resourceCount: manifest.resources.length,
      permissionCount: manifest.permissions.length,
      reasons: Array.from(new Set(reasons)).sort(),
    },
  }
}

export function planCapabilityBundleUninstall(
  manifest: CapabilityBundleManifest,
  options: {
    installedResourceIds?: CapabilityBundleResourceSelector[]
    userOwnedResourceIds?: CapabilityBundleResourceSelector[]
  } = {},
): CapabilityBundleUninstallPlan {
  const installedResourceIds = createResourceIdentitySet(options.installedResourceIds)
  const userOwnedResourceIds = createResourceIdentitySet(options.userOwnedResourceIds)
  const explicitPreserves = createResourceIdentitySet(manifest.uninstall?.preserves)
  const candidates = new Map<string, CapabilityBundleResourceCandidate>()
  const addCandidate = (candidate: CapabilityBundleResourceCandidate) => {
    candidates.set(candidateKey(candidate), candidate)
  }
  for (const resource of manifest.resources.filter((entry) => entry.ownedByBundle)) {
    addCandidate({ kind: resource.kind, id: resource.id, resource })
  }
  for (const selector of [
    ...(manifest.uninstall?.removes || []),
    ...(manifest.uninstall?.preserves || []),
    ...(options.userOwnedResourceIds || []),
  ]) {
    for (const candidate of resourceCandidateFromSelector(selector, manifest.resources)) {
      addCandidate(candidate)
    }
  }
  const actions: CapabilityBundleInstallPlanAction[] = []
  const reasons: string[] = []
  let level: CapabilityRiskLevel = 'low'

  for (const candidate of Array.from(candidates.values()).sort((left, right) => `${left.id}:${left.kind}`.localeCompare(`${right.id}:${right.kind}`))) {
    const resource = candidate.resource
    const installed = resourceIdentitySetIsEmpty(installedResourceIds) || resourceIdentitySetHasCandidate(installedResourceIds, candidate)
    const explicitPreserve = resourceIdentitySetHasCandidate(explicitPreserves, candidate)
    const mustPreserve = explicitPreserve || resourceIdentitySetHasCandidate(userOwnedResourceIds, candidate) || (resource ? !resource.ownedByBundle : false)
    if (mustPreserve) {
      actions.push({
        action: 'preserve_user_resource',
        kind: candidate.kind,
        id: candidate.id,
        reason: explicitPreserve
          ? 'Manifest marks this resource as preserved during uninstall.'
          : 'User-owned resource is preserved during bundle uninstall.',
      })
      reasons.push(`Resource ${candidate.id} is preserved during uninstall.`)
      level = maxRisk(level, 'medium')
      continue
    }
    if (!installed) continue
    actions.push({
      action: 'remove_bundle_resource',
      kind: candidate.kind,
      id: candidate.id,
      reason: 'Bundle-owned resource can be removed by bundle uninstall.',
    })
  }

  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    bundleName: manifest.name,
    blocked: false,
    blockers: [],
    actions,
    risk: {
      level,
      resourceCount: manifest.resources.length,
      permissionCount: manifest.permissions.length,
      reasons: Array.from(new Set(reasons)).sort(),
    },
  }
}

export function planCapabilityBundleUpdate(
  previous: CapabilityBundleManifest,
  next: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    existingResourceIds?: CapabilityBundleResourceSelector[]
    installedResourceIds?: CapabilityBundleResourceSelector[]
    userOwnedResourceIds?: CapabilityBundleResourceSelector[]
  },
): CapabilityBundleUpdatePlan {
  const blockers: CapabilityBundleIssue[] = []
  const actions: CapabilityBundleInstallPlanAction[] = []
  const reasons: string[] = []
  let level: CapabilityRiskLevel = 'low'

  if (previous.name !== next.name) {
    pushIssue(blockers, 'bundle_name_mismatch', 'Capability bundle updates must keep the same bundle name.')
    actions.push({ action: 'block', kind: 'bundle', id: next.name, reason: 'Bundle update target does not match the installed bundle.' })
    level = 'high'
  }

  const nextResourceIds = new Set(next.resources.map((resource) => resourceIdentityKey(resource)))
  const installedResourceIds = createResourceIdentitySet(options.installedResourceIds)
  const userOwnedResourceIds = createResourceIdentitySet(options.userOwnedResourceIds)
  const previousResourceByKey = new Map(previous.resources.map((resource) => [resourceIdentityKey(resource), resource]))

  for (const resource of [...previous.resources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    if (nextResourceIds.has(resourceIdentityKey(resource))) continue
    const installed = resourceIdentitySetIsEmpty(installedResourceIds) || resourceIdentitySetHasResource(installedResourceIds, resource)
    if (!installed) continue
    if (!resource.ownedByBundle || resourceIdentitySetHasResource(userOwnedResourceIds, resource)) {
      actions.push({
        action: 'preserve_user_resource',
        kind: resource.kind,
        id: resource.id,
        reason: 'Resource is no longer declared by the bundle but is user-owned or not bundle-owned, so update preserves it.',
      })
      reasons.push(`Resource ${resource.id} is preserved during update.`)
      level = maxRisk(level, 'medium')
      continue
    }
    actions.push({
      action: 'remove_bundle_resource',
      kind: resource.kind,
      id: resource.id,
      reason: 'Bundle-owned resource is removed by the bundle update because it is no longer declared.',
    })
  }

  const installPlan = planCapabilityBundleInstall(next, {
    productMode: options.productMode,
    existingResourceIds: options.existingResourceIds,
  })
  blockers.push(...installPlan.blockers)
  reasons.push(...installPlan.risk.reasons)
  level = maxRisk(level, installPlan.risk.level)

  for (const action of installPlan.actions) {
    const actionResourceKey = installActionResourceKey(action)
    if (
      action.action === 'install'
      && actionResourceKey
      && previousResourceByKey.has(actionResourceKey)
      && !resourceIdentitySetHasResource(userOwnedResourceIds, { kind: action.kind as CapabilityBundleResourceKind, id: action.id })
    ) {
      actions.push({
        ...action,
        reason: 'Bundle-owned resource is updated according to the next bundle manifest.',
      })
      continue
    }
    actions.push(action)
  }

  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    bundleName: next.name,
    previousVersion: previous.version,
    nextVersion: next.version,
    productMode: options.productMode,
    blocked: blockers.length > 0,
    blockers,
    actions,
    risk: {
      level,
      resourceCount: next.resources.length,
      permissionCount: next.permissions.length,
      reasons: Array.from(new Set(reasons)).sort(),
    },
  }
}

function cloneCapabilityBundleLifecycleState(
  state: Partial<CapabilityBundleLifecycleState> | null | undefined,
): CapabilityBundleLifecycleState {
  return {
    bundles: Array.isArray(state?.bundles)
      ? state.bundles.map((bundle) => ({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          resources: [...bundle.manifest.resources],
          permissions: [...bundle.manifest.permissions],
          uninstall: {
            removes: (bundle.manifest.uninstall?.removes || []).map(cloneResourceSelector),
            preserves: (bundle.manifest.uninstall?.preserves || []).map(cloneResourceSelector),
          },
        },
        resources: [...bundle.resources],
      })).sort((left, right) => left.name.localeCompare(right.name))
      : [],
    resources: Array.isArray(state?.resources)
      ? state.resources.map((resource) => ({
        ...resource,
        manifestResource: { ...resource.manifestResource },
      })).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
      : [],
  }
}

function lifecycleAuditFromAction(
  lifecycleAction: CapabilityBundleLifecycleAction,
  bundleName: string,
  action: CapabilityBundleInstallPlanAction,
): CapabilityBundleLifecycleAuditEvent {
  const outcome: CapabilityBundleLifecycleOutcome =
    action.action === 'install'
      ? lifecycleAction === 'update' ? 'updated' : 'installed'
      : action.action === 'remove_bundle_resource'
        ? 'removed'
        : action.action === 'preserve_user_resource'
          ? 'preserved'
          : action.action === 'review_permission'
            ? 'reviewed'
            : 'blocked'
  return {
    action: lifecycleAction,
    outcome,
    bundleName,
    kind: action.kind,
    id: action.id,
    reason: action.reason,
  }
}

function blockedLifecycleAudit(
  lifecycleAction: CapabilityBundleLifecycleAction,
  bundleName: string,
  blockers: CapabilityBundleIssue[],
): CapabilityBundleLifecycleAuditEvent[] {
  return blockers.map((blocker) => ({
    action: lifecycleAction,
    outcome: 'blocked',
    bundleName,
    kind: 'bundle',
    id: blocker.resourceId || bundleName,
    reason: `${blocker.code}: ${blocker.message}`,
  }))
}

function sortedLifecycleResources(resources: CapabilityBundleLifecycleResource[]) {
  return resources.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

function sortedLifecycleBundles(bundles: CapabilityBundleLifecycleBundle[]) {
  return bundles.sort((left, right) => left.name.localeCompare(right.name))
}

function upsertLifecycleResource(
  resources: CapabilityBundleLifecycleResource[],
  resource: CapabilityBundleResource,
  options: {
    bundleName: string
    owner: CapabilityBundleLifecycleOwner
    now: string
  },
) {
  const key = resourceIdentityKey(resource)
  const next = resources.filter((entry) => resourceIdentityKey(entry) !== key)
  const previous = resources.find((entry) => resourceIdentityKey(entry) === key)
  next.push({
    kind: resource.kind,
    id: resource.id,
    owner: options.owner,
    bundleName: options.owner === 'bundle' ? options.bundleName : null,
    installedAt: previous?.installedAt || options.now,
    updatedAt: options.now,
    manifestResource: { ...resource },
  })
  return sortedLifecycleResources(next)
}

function removeBundleOwnedLifecycleResources(
  resources: CapabilityBundleLifecycleResource[],
  bundleName: string,
  ids: Set<string>,
) {
  return sortedLifecycleResources(resources.filter((resource) => {
    if (!ids.has(resourceIdentityKey(resource))) return true
    return resource.owner !== 'bundle' || resource.bundleName !== bundleName
  }))
}

function installActionsByResourceKey(actions: CapabilityBundleInstallPlanAction[]) {
  const map = new Map<string, CapabilityBundleInstallPlanAction>()
  for (const action of actions) {
    if (
      action.action === 'install'
      || action.action === 'preserve_user_resource'
      || action.action === 'remove_bundle_resource'
    ) {
      const key = installActionResourceKey(action)
      if (key) map.set(key, action)
    }
  }
  return map
}

function lifecycleResourceIdsExcludingBundle(state: CapabilityBundleLifecycleState, bundleName: string) {
  return state.resources
    .filter((resource) => resource.bundleName !== bundleName)
    .map(resourceIdentity)
}

function lifecycleUserOwnedResourceIds(state: CapabilityBundleLifecycleState) {
  return state.resources
    .filter((resource) => resource.owner === 'user')
    .map(resourceIdentity)
}

function lifecycleInstalledResourceIdsForBundle(state: CapabilityBundleLifecycleState, bundleName: string) {
  return state.resources
    .filter((resource) => resource.bundleName === bundleName || resource.owner === 'user')
    .map(resourceIdentity)
}

export function createEmptyCapabilityBundleLifecycleState(): CapabilityBundleLifecycleState {
  return { bundles: [], resources: [] }
}

export function applyCapabilityBundleInstall(
  state: Partial<CapabilityBundleLifecycleState> | null | undefined,
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    now?: string
  },
): CapabilityBundleLifecycleApplyResult<CapabilityBundleInstallPlan> {
  const current = cloneCapabilityBundleLifecycleState(state)
  const plan = planCapabilityBundleInstall(manifest, {
    productMode: options.productMode,
    existingResourceIds: current.resources.map(resourceIdentity),
  })

  if (current.bundles.some((bundle) => bundle.name === manifest.name)) {
    pushIssue(plan.blockers, 'bundle_already_installed', `Capability bundle ${manifest.name} is already installed.`)
    plan.actions.unshift({ action: 'block', kind: 'bundle', id: manifest.name, reason: 'Bundle is already installed; use update instead.' })
    plan.blocked = true
    plan.risk.level = maxRisk(plan.risk.level, 'high')
  }

  if (plan.blocked) {
    return {
      applied: false,
      plan,
      state: current,
      audit: [
        ...blockedLifecycleAudit('install', manifest.name, plan.blockers),
        ...plan.actions.filter((action) => action.action === 'block').map((action) => lifecycleAuditFromAction('install', manifest.name, action)),
      ],
    }
  }

  const now = options.now || new Date().toISOString()
  const actionByKey = installActionsByResourceKey(plan.actions)
  let resources = current.resources
  const bundleResources: CapabilityBundleLifecycleBundle['resources'] = []

  for (const resource of [...manifest.resources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    const action = actionByKey.get(resourceIdentityKey(resource))
    if (action?.action === 'preserve_user_resource') continue
    if (action?.action !== 'install') continue
    const owner: CapabilityBundleLifecycleOwner = resource.ownedByBundle ? 'bundle' : 'user'
    resources = upsertLifecycleResource(resources, resource, {
      bundleName: manifest.name,
      owner,
      now,
    })
    bundleResources.push({ kind: resource.kind, id: resource.id, owner })
  }

  const next: CapabilityBundleLifecycleState = {
    bundles: sortedLifecycleBundles([
      ...current.bundles,
      {
        name: manifest.name,
        version: manifest.version,
        owner: manifest.owner,
        productMode: options.productMode,
        manifest,
        installedAt: now,
        updatedAt: now,
        resources: bundleResources.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
      },
    ]),
    resources,
  }

  return {
    applied: true,
    plan,
    state: next,
    audit: plan.actions.map((action) => lifecycleAuditFromAction('install', manifest.name, action)),
  }
}

export function applyCapabilityBundleUninstall(
  state: Partial<CapabilityBundleLifecycleState> | null | undefined,
  bundleName: string,
): CapabilityBundleLifecycleApplyResult<CapabilityBundleUninstallPlan> {
  const current = cloneCapabilityBundleLifecycleState(state)
  const installed = current.bundles.find((bundle) => bundle.name === bundleName) || null
  if (!installed) {
    const plan: CapabilityBundleUninstallPlan = {
      format: CAPABILITY_BUNDLE_FORMAT,
      bundleName,
      blocked: true,
      blockers: [{ code: 'bundle_not_installed', message: `Capability bundle ${bundleName} is not installed.` }],
      actions: [{ action: 'block', kind: 'bundle', id: bundleName, reason: 'Bundle is not installed.' }],
      risk: {
        level: 'low',
        resourceCount: 0,
        permissionCount: 0,
        reasons: [],
      },
    }
    return {
      applied: false,
      plan,
      state: current,
      audit: [
        ...blockedLifecycleAudit('uninstall', bundleName, plan.blockers),
        ...plan.actions.map((action) => lifecycleAuditFromAction('uninstall', bundleName, action)),
      ],
    }
  }

  const plan = planCapabilityBundleUninstall(installed.manifest, {
    installedResourceIds: lifecycleInstalledResourceIdsForBundle(current, bundleName),
    userOwnedResourceIds: lifecycleUserOwnedResourceIds(current),
  })
  const removals = new Set(plan.actions
    .filter((action) => action.action === 'remove_bundle_resource')
    .map(installActionResourceKey)
    .filter((key): key is string => Boolean(key)))
  const preserves = new Set(plan.actions
    .filter((action) => action.action === 'preserve_user_resource')
    .map(installActionResourceKey)
    .filter((key): key is string => Boolean(key)))
  const resources = removeBundleOwnedLifecycleResources(current.resources, bundleName, removals)
  const next: CapabilityBundleLifecycleState = {
    bundles: sortedLifecycleBundles(current.bundles.filter((bundle) => bundle.name !== bundleName)),
    resources: sortedLifecycleResources(resources.map((resource) => {
      if (preserves.has(resourceIdentityKey(resource)) && resource.owner === 'bundle' && resource.bundleName === bundleName) {
        return {
          ...resource,
          owner: 'user',
          bundleName: null,
        }
      }
      return resource
    })),
  }

  return {
    applied: true,
    plan,
    state: next,
    audit: plan.actions.map((action) => lifecycleAuditFromAction('uninstall', bundleName, action)),
  }
}

export function applyCapabilityBundleUpdate(
  state: Partial<CapabilityBundleLifecycleState> | null | undefined,
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    now?: string
  },
): CapabilityBundleLifecycleApplyResult<CapabilityBundleUpdatePlan> {
  const current = cloneCapabilityBundleLifecycleState(state)
  const previous = current.bundles.find((bundle) => bundle.name === manifest.name) || null
  if (!previous) {
    const installResult = applyCapabilityBundleInstall(current, manifest, options)
    const plan: CapabilityBundleUpdatePlan = {
      format: CAPABILITY_BUNDLE_FORMAT,
      bundleName: manifest.name,
      previousVersion: '',
      nextVersion: manifest.version,
      productMode: options.productMode,
      blocked: installResult.plan.blocked,
      blockers: installResult.plan.blockers,
      actions: installResult.plan.actions,
      risk: installResult.plan.risk,
    }
    return {
      applied: installResult.applied,
      plan,
      state: installResult.state,
      audit: installResult.audit.map((event) => ({ ...event, action: 'update' })),
    }
  }

  const plan = planCapabilityBundleUpdate(previous.manifest, manifest, {
    productMode: options.productMode,
    existingResourceIds: lifecycleResourceIdsExcludingBundle(current, manifest.name),
    installedResourceIds: lifecycleInstalledResourceIdsForBundle(current, manifest.name),
    userOwnedResourceIds: lifecycleUserOwnedResourceIds(current),
  })

  if (plan.blocked) {
    return {
      applied: false,
      plan,
      state: current,
      audit: [
        ...blockedLifecycleAudit('update', manifest.name, plan.blockers),
        ...plan.actions.filter((action) => action.action === 'block').map((action) => lifecycleAuditFromAction('update', manifest.name, action)),
      ],
    }
  }

  const now = options.now || new Date().toISOString()
  const removals = new Set(plan.actions
    .filter((action) => action.action === 'remove_bundle_resource')
    .map(installActionResourceKey)
    .filter((key): key is string => Boolean(key)))
  const actionByKey = installActionsByResourceKey(plan.actions)
  let resources = removeBundleOwnedLifecycleResources(current.resources, manifest.name, removals)
  const bundleResources: CapabilityBundleLifecycleBundle['resources'] = []

  for (const resource of [...manifest.resources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))) {
    const action = actionByKey.get(resourceIdentityKey(resource))
    if (action?.action === 'preserve_user_resource') continue
    if (action?.action !== 'install') continue
    const owner: CapabilityBundleLifecycleOwner = resource.ownedByBundle ? 'bundle' : 'user'
    resources = upsertLifecycleResource(resources, resource, {
      bundleName: manifest.name,
      owner,
      now,
    })
    bundleResources.push({ kind: resource.kind, id: resource.id, owner })
  }

  const next: CapabilityBundleLifecycleState = {
    bundles: sortedLifecycleBundles([
      ...current.bundles.filter((bundle) => bundle.name !== manifest.name),
      {
        name: manifest.name,
        version: manifest.version,
        owner: manifest.owner,
        productMode: options.productMode,
        manifest,
        installedAt: previous.installedAt,
        updatedAt: now,
        resources: bundleResources.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)),
      },
    ]),
    resources,
  }

  return {
    applied: true,
    plan,
    state: next,
    audit: plan.actions.map((action) => lifecycleAuditFromAction('update', manifest.name, action)),
  }
}
