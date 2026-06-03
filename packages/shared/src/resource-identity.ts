export const RESOURCE_IDENTITY_FORMAT = 'open-cowork-resource-identity-v1'
export const RESOURCE_DEEP_LINK_PROTOCOL = 'open-cowork:'
export const RESOURCE_DEEP_LINK_HOST = 'resource'

export type ResourceAuthority =
  | 'desktop-local'
  | 'desktop-cloud'
  | 'cloud-web'
  | 'cloud-channel-gateway'
  | 'standalone-gateway'
  | 'paired-desktop'

export type ResourceKind =
  | 'workspace'
  | 'session'
  | 'task'
  | 'workflow'
  | 'workflow-run'
  | 'artifact'
  | 'settings'
  | 'diagnostics'
  | 'capability'

export type CapabilityResourceKind =
  | 'provider'
  | 'model'
  | 'mcp'
  | 'skill'
  | 'agent'
  | 'tool'
  | 'workflow'
  | 'opencode-plugin'

export interface CanonicalResourceIdentity {
  format: typeof RESOURCE_IDENTITY_FORMAT
  authority: ResourceAuthority
  kind: ResourceKind
  workspaceId?: string
  sessionId?: string
  taskId?: string
  workflowId?: string
  runId?: string
  artifactId?: string
  settingsSurface?: string
  diagnosticsId?: string
  capabilityKind?: CapabilityResourceKind
  capabilityId?: string
}

export interface ResourceIdentityLookupResult<T> {
  identity: CanonicalResourceIdentity
  found: boolean
  value: T | null
  errorCode?: 'resource-not-found' | 'resource-unavailable' | 'unsupported-authority'
  message?: string
}

export type ResourceRouteKey =
  | 'workspace'
  | 'session'
  | 'task'
  | 'workflow'
  | 'workflow-run'
  | 'artifact'
  | 'settings'
  | 'diagnostics'
  | 'capability'

export type ResourceOpenActionStatus =
  | 'open'
  | 'not-found'
  | 'unavailable'
  | 'unsupported-authority'

export interface ResourceOpenAction<T = unknown> {
  identity: CanonicalResourceIdentity
  status: ResourceOpenActionStatus
  routeKey: ResourceRouteKey
  routeParams: Record<string, string>
  value: T | null
  errorCode?: ResourceIdentityLookupResult<T>['errorCode']
  message?: string
}

export type ResourceAuthorityTransitionStatus =
  | 'same-authority'
  | 'supported'
  | 'unsupported'

export interface ResourceAuthorityTransitionResult {
  from: ResourceAuthority
  to: ResourceAuthority
  status: ResourceAuthorityTransitionStatus
  allowed: boolean
  message: string
}

const AUTHORITIES = new Set<ResourceAuthority>([
  'desktop-local',
  'desktop-cloud',
  'cloud-web',
  'cloud-channel-gateway',
  'standalone-gateway',
  'paired-desktop',
])

const KINDS = new Set<ResourceKind>([
  'workspace',
  'session',
  'task',
  'workflow',
  'workflow-run',
  'artifact',
  'settings',
  'diagnostics',
  'capability',
])

const CAPABILITY_KINDS = new Set<CapabilityResourceKind>([
  'provider',
  'model',
  'mcp',
  'skill',
  'agent',
  'tool',
  'workflow',
  'opencode-plugin',
])

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/

function assertKnownAuthority(authority: string): asserts authority is ResourceAuthority {
  if (!AUTHORITIES.has(authority as ResourceAuthority)) {
    throw new Error(`Unsupported resource authority: ${authority || '(empty)'}`)
  }
}

function assertKnownKind(kind: string): asserts kind is ResourceKind {
  if (!KINDS.has(kind as ResourceKind)) {
    throw new Error(`Unsupported resource kind: ${kind || '(empty)'}`)
  }
}

function assertKnownCapabilityKind(kind: string): asserts kind is CapabilityResourceKind {
  if (!CAPABILITY_KINDS.has(kind as CapabilityResourceKind)) {
    throw new Error(`Unsupported capability resource kind: ${kind || '(empty)'}`)
  }
}

function assertExactResourceId(value: string | undefined, field: string): string {
  if (!value || !RESOURCE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be an exact Open Cowork resource id`)
  }
  if (value.includes('/') || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error(`${field} must not contain path or URL separators`)
  }
  if (value === '..' || value.includes('*')) {
    throw new Error(`${field} must not be fuzzy or wildcarded`)
  }
  return value
}

function optionalExactResourceId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  return assertExactResourceId(value, field)
}

function requireFields(identity: CanonicalResourceIdentity, fields: Array<keyof CanonicalResourceIdentity>) {
  for (const field of fields) {
    assertExactResourceId(identity[field] as string | undefined, field)
  }
}

function validateResourceIdentity(input: Omit<CanonicalResourceIdentity, 'format'> | CanonicalResourceIdentity): CanonicalResourceIdentity {
  assertKnownAuthority(input.authority)
  assertKnownKind(input.kind)

  const identity: CanonicalResourceIdentity = {
    format: RESOURCE_IDENTITY_FORMAT,
    authority: input.authority,
    kind: input.kind,
    workspaceId: optionalExactResourceId(input.workspaceId, 'workspaceId'),
    sessionId: optionalExactResourceId(input.sessionId, 'sessionId'),
    taskId: optionalExactResourceId(input.taskId, 'taskId'),
    workflowId: optionalExactResourceId(input.workflowId, 'workflowId'),
    runId: optionalExactResourceId(input.runId, 'runId'),
    artifactId: optionalExactResourceId(input.artifactId, 'artifactId'),
    settingsSurface: optionalExactResourceId(input.settingsSurface, 'settingsSurface'),
    diagnosticsId: optionalExactResourceId(input.diagnosticsId, 'diagnosticsId'),
    capabilityId: optionalExactResourceId(input.capabilityId, 'capabilityId'),
  }

  if (input.capabilityKind !== undefined) {
    assertKnownCapabilityKind(input.capabilityKind)
    identity.capabilityKind = input.capabilityKind
  }

  switch (identity.kind) {
    case 'workspace':
      requireFields(identity, ['workspaceId'])
      break
    case 'session':
      requireFields(identity, ['workspaceId', 'sessionId'])
      break
    case 'task':
      requireFields(identity, ['workspaceId', 'sessionId', 'taskId'])
      break
    case 'workflow':
      requireFields(identity, ['workspaceId', 'workflowId'])
      break
    case 'workflow-run':
      requireFields(identity, ['workspaceId', 'workflowId', 'runId'])
      break
    case 'artifact':
      requireFields(identity, ['workspaceId', 'sessionId', 'artifactId'])
      break
    case 'settings':
      requireFields(identity, ['workspaceId', 'settingsSurface'])
      break
    case 'diagnostics':
      requireFields(identity, ['workspaceId'])
      break
    case 'capability':
      requireFields(identity, ['workspaceId', 'capabilityId'])
      if (!identity.capabilityKind) throw new Error('capabilityKind is required for capability resources')
      break
  }

  return Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)) as CanonicalResourceIdentity
}

export function createResourceIdentity(input: Omit<CanonicalResourceIdentity, 'format'>): CanonicalResourceIdentity {
  return validateResourceIdentity(input)
}

function encode(value: string) {
  return encodeURIComponent(value)
}

function decode(value: string, field: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`${field} is not valid URI encoding`)
  }
}

export function serializeResourceIdentity(input: CanonicalResourceIdentity): string {
  const identity = validateResourceIdentity(input)
  const params = Object.entries(identity)
    .filter(([key]) => !['format', 'authority', 'kind'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encode(key)}=${encode(String(value))}`)
    .join('&')
  return `open-cowork-resource/v1/${encode(identity.authority)}/${encode(identity.kind)}${params ? `?${params}` : ''}`
}

export function parseResourceIdentity(value: string): CanonicalResourceIdentity {
  const match = /^open-cowork-resource\/v1\/([^/?#]+)\/([^/?#]+)(?:\?([^#]*))?$/.exec(value)
  if (!match) throw new Error('Resource identity must use open-cowork-resource/v1 serialization')
  const [, rawAuthority, rawKind, rawQuery] = match
  const authority = decode(rawAuthority, 'authority')
  const kind = decode(rawKind, 'kind')
  const fields: Record<string, string> = {}
  if (rawQuery) {
    for (const part of rawQuery.split('&')) {
      if (!part) continue
      const [rawKey, rawValue = ''] = part.split('=')
      fields[decode(rawKey, 'query key')] = decode(rawValue, rawKey)
    }
  }
  return validateResourceIdentity({
    authority,
    kind,
    ...fields,
  } as Omit<CanonicalResourceIdentity, 'format'>)
}

export function resourceIdentityKey(input: CanonicalResourceIdentity): string {
  return serializeResourceIdentity(input)
}

export function resourceIdentitiesEqual(left: CanonicalResourceIdentity, right: CanonicalResourceIdentity): boolean {
  return resourceIdentityKey(left) === resourceIdentityKey(right)
}

export function createResourceDeepLink(input: CanonicalResourceIdentity): string {
  return `${RESOURCE_DEEP_LINK_PROTOCOL}//${RESOURCE_DEEP_LINK_HOST}/${encode(serializeResourceIdentity(input))}`
}

export function parseResourceDeepLink(value: string): CanonicalResourceIdentity {
  const prefix = `${RESOURCE_DEEP_LINK_PROTOCOL}//${RESOURCE_DEEP_LINK_HOST}/`
  if (!value.startsWith(prefix)) {
    throw new Error('Resource deep link must use open-cowork://resource/')
  }
  const encodedIdentity = value.slice(prefix.length)
  if (encodedIdentity.includes('?') || encodedIdentity.includes('#')) {
    throw new Error('Resource deep link must not include search or hash state')
  }
  if (!encodedIdentity) throw new Error('Resource deep link is missing a resource identity')
  return parseResourceIdentity(decode(encodedIdentity, 'resource identity'))
}

export function createResourceLookupResult<T>(
  identity: CanonicalResourceIdentity,
  value: T | null,
  options: {
    available?: boolean
    unsupportedAuthority?: boolean
    message?: string
  } = {},
): ResourceIdentityLookupResult<T> {
  const exactIdentity = validateResourceIdentity(identity)
  if (options.unsupportedAuthority) {
    return {
      identity: exactIdentity,
      found: false,
      value: null,
      errorCode: 'unsupported-authority',
      message: options.message || 'Resource authority is not supported in this product mode.',
    }
  }
  if (value === null || options.available === false) {
    return {
      identity: exactIdentity,
      found: false,
      value: null,
      errorCode: options.available === false ? 'resource-unavailable' : 'resource-not-found',
      message: options.message || 'Resource was not found by exact identity.',
    }
  }
  return {
    identity: exactIdentity,
    found: true,
    value,
  }
}

function routeParamsForIdentity(identity: CanonicalResourceIdentity): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      workflowId: identity.workflowId,
      runId: identity.runId,
      artifactId: identity.artifactId,
      settingsSurface: identity.settingsSurface,
      diagnosticsId: identity.diagnosticsId,
      capabilityKind: identity.capabilityKind,
      capabilityId: identity.capabilityId,
    }).filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>
}

function openStatusForLookup<T>(lookup: ResourceIdentityLookupResult<T>): ResourceOpenActionStatus {
  if (lookup.found) return 'open'
  if (lookup.errorCode === 'unsupported-authority') return 'unsupported-authority'
  if (lookup.errorCode === 'resource-unavailable') return 'unavailable'
  return 'not-found'
}

export function createResourceOpenAction<T>(
  lookup: ResourceIdentityLookupResult<T>,
): ResourceOpenAction<T> {
  const identity = validateResourceIdentity(lookup.identity)
  return {
    identity,
    status: openStatusForLookup(lookup),
    routeKey: identity.kind,
    routeParams: routeParamsForIdentity(identity),
    value: lookup.value,
    errorCode: lookup.errorCode,
    message: lookup.message,
  }
}

export function resolveResourceDeepLinkOpenAction<T>(
  deepLink: string,
  lookup: (identity: CanonicalResourceIdentity) => ResourceIdentityLookupResult<T>,
): ResourceOpenAction<T> {
  const identity = parseResourceDeepLink(deepLink)
  return createResourceOpenAction(lookup(identity))
}

export function evaluateResourceAuthorityTransition(input: {
  from: ResourceAuthority
  to: ResourceAuthority
  supported?: ReadonlyArray<readonly [ResourceAuthority, ResourceAuthority]>
}): ResourceAuthorityTransitionResult {
  assertKnownAuthority(input.from)
  assertKnownAuthority(input.to)
  if (input.from === input.to) {
    return {
      from: input.from,
      to: input.to,
      status: 'same-authority',
      allowed: true,
      message: 'Resource authority is unchanged.',
    }
  }

  const transition = `${input.from}->${input.to}`
  const supported = new Set((input.supported || []).map(([from, to]) => `${from}->${to}`))
  if (supported.has(transition)) {
    return {
      from: input.from,
      to: input.to,
      status: 'supported',
      allowed: true,
      message: 'Resource authority transition is explicitly supported.',
    }
  }

  return {
    from: input.from,
    to: input.to,
    status: 'unsupported',
    allowed: false,
    message: 'Resource authority transition is unsupported and must not fall back to Desktop Local.',
  }
}
