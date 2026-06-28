import type {
  AgentBundle,
  AgentColor,
  CustomAgentConfig,
  CustomAgentMode,
  CustomAgentPermissionAction,
  CustomAgentPermissionKey,
  CustomAgentPermissionOverride,
  CustomAgentPermissionRule,
  CustomAgentSummary,
} from '@open-cowork/shared'

// Canonical on-disk format version for agent bundles. Written by every
// export, expected by every import. Incrementing this string is a breaking
// change and should only happen when the schema can't be migrated in place.
export const AGENT_BUNDLE_FORMAT = 'cowork-agent-v1' as const

const AGENT_COLORS: AgentColor[] = ['primary', 'warning', 'accent', 'success', 'info', 'secondary']
const PORTABLE_PERMISSION_KEYS: CustomAgentPermissionKey[] = ['web', 'edit', 'bash', 'task', 'mcp']

export interface AgentBundleDecodeResult {
  ok: true
  bundle: AgentBundle
}
export interface AgentBundleDecodeFailure {
  ok: false
  error: string
}

// Serialize a custom agent into a portable bundle. Strips anything that
// only makes sense inside this install (scope / directory / issues) so the
// file is clean for sharing.
export function encodeAgentBundle(agent: CustomAgentSummary | CustomAgentConfig): AgentBundle {
  const permissionOverrides = portablePermissionOverrides(agent.permissionOverrides)
  return {
    format: AGENT_BUNDLE_FORMAT,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    ...(agent.mode ? { mode: agent.mode } : {}),
    color: agent.color,
    avatar: agent.avatar || null,
    enabled: agent.enabled ?? true,
    ...(permissionOverrides ? { permissionOverrides } : {}),
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
    exportedAt: new Date().toISOString(),
  }
}

// Pretty-print a bundle for saving to disk. Stable field order + 2-space
// indent so diffs are readable.
export function stringifyAgentBundle(bundle: AgentBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

function decodeMode(value: unknown): CustomAgentMode | undefined {
  return value === 'primary' || value === 'subagent' ? value : undefined
}

function decodePermissionAction(value: unknown): CustomAgentPermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'deny'
}

function decodePermissionRule(value: unknown): CustomAgentPermissionRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const pattern = typeof record.pattern === 'string' ? record.pattern.trim() : ''
  if (!pattern || /[\r\n\0]/.test(pattern)) return null
  return {
    pattern,
    action: decodePermissionAction(record.action),
  }
}

function decodePermissionOverrides(value: unknown): CustomAgentPermissionOverride[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byKey = new Map<CustomAgentPermissionKey, CustomAgentPermissionOverride>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (typeof record.key !== 'string' || !PORTABLE_PERMISSION_KEYS.includes(record.key as CustomAgentPermissionKey)) continue
    const rules = Array.isArray(record.rules)
      ? record.rules.map(decodePermissionRule).filter((rule): rule is CustomAgentPermissionRule => Boolean(rule))
      : []
    byKey.set(record.key as CustomAgentPermissionKey, {
      key: record.key as CustomAgentPermissionKey,
      action: decodePermissionAction(record.action),
      ...(rules.length > 0 ? { rules } : {}),
    })
  }
  const overrides = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key))
  return overrides.length > 0 ? overrides : undefined
}

function portablePermissionOverrides(overrides?: CustomAgentPermissionOverride[] | null): CustomAgentPermissionOverride[] | undefined {
  if (!overrides?.length) return undefined
  const portable = overrides
    .filter((override) => PORTABLE_PERMISSION_KEYS.includes(override.key))
    .map((override) => ({
      ...override,
      ...(override.rules ? { rules: override.rules.map((rule) => ({ ...rule })) } : {}),
    }))
  return portable.length > 0 ? portable : undefined
}

// Parse + validate an untrusted bundle read from disk. Returns a tagged
// union so call sites can surface a human-readable failure reason.
export function decodeAgentBundle(raw: unknown): AgentBundleDecodeResult | AgentBundleDecodeFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'File is not a valid agent bundle (expected a JSON object).' }
  }
  const record = raw as Record<string, unknown>
  if (record.format !== AGENT_BUNDLE_FORMAT) {
    return {
      ok: false,
      error: `Unsupported bundle format "${String(record.format)}". Expected "${AGENT_BUNDLE_FORMAT}".`,
    }
  }
  if (typeof record.name !== 'string' || !record.name.trim()) {
    return { ok: false, error: 'Bundle is missing a valid "name".' }
  }
  if (typeof record.description !== 'string') {
    return { ok: false, error: 'Bundle is missing a "description".' }
  }
  if (typeof record.instructions !== 'string') {
    return { ok: false, error: 'Bundle is missing "instructions".' }
  }
  const skillNames = Array.isArray(record.skillNames)
    ? record.skillNames.filter((entry): entry is string => typeof entry === 'string')
    : []
  const toolIds = Array.isArray(record.toolIds)
    ? record.toolIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  const color: AgentColor = typeof record.color === 'string' && (AGENT_COLORS as string[]).includes(record.color)
    ? record.color as AgentColor
    : 'accent'

  const bundle: AgentBundle = {
    format: AGENT_BUNDLE_FORMAT,
    name: record.name.trim(),
    description: record.description,
    instructions: record.instructions,
    skillNames,
    toolIds,
    mode: decodeMode(record.mode),
    color,
    avatar: typeof record.avatar === 'string' ? record.avatar : null,
    enabled: record.enabled === false ? false : true,
    permissionOverrides: decodePermissionOverrides(record.permissionOverrides),
    model: typeof record.model === 'string' ? record.model : null,
    variant: typeof record.variant === 'string' ? record.variant : null,
    temperature: typeof record.temperature === 'number' ? record.temperature : null,
    top_p: typeof record.top_p === 'number' ? record.top_p : null,
    steps: typeof record.steps === 'number' ? record.steps : null,
    options: (record.options && typeof record.options === 'object' && !Array.isArray(record.options))
      ? record.options as Record<string, unknown>
      : null,
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : undefined,
    exportedBy: typeof record.exportedBy === 'string' ? record.exportedBy : undefined,
  }
  return { ok: true, bundle }
}

// Turn a validated bundle into a `CustomAgentConfig` ready to pass to
// `agents:create`. Scope + directory are decided by the import UI, not
// baked into the bundle itself.
export function bundleToAgentConfig(
  bundle: AgentBundle,
  target: { scope: 'machine' | 'project'; directory?: string | null },
): CustomAgentConfig {
  return {
    scope: target.scope,
    directory: target.scope === 'project' ? target.directory || null : null,
    name: bundle.name,
    description: bundle.description,
    instructions: bundle.instructions,
    skillNames: [...bundle.skillNames],
    toolIds: [...bundle.toolIds],
    mode: bundle.mode,
    enabled: bundle.enabled ?? true,
    color: bundle.color,
    avatar: bundle.avatar ?? null,
    permissionOverrides: portablePermissionOverrides(bundle.permissionOverrides),
    model: bundle.model ?? null,
    variant: bundle.variant ?? null,
    temperature: bundle.temperature ?? null,
    top_p: bundle.top_p ?? null,
    steps: bundle.steps ?? null,
    options: bundle.options ?? null,
  }
}

export function defaultBundleFilename(name: string): string {
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safeName || 'agent'}.cowork-agent.json`
}
