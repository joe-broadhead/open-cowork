import type { AgentBundle, AgentColor, CustomAgentConfig, CustomAgentSummary } from '@open-cowork/shared'

// Canonical on-disk format version for agent bundles. Written by every
// export, expected by every import. Incrementing this string is a breaking
// change and should only happen when the schema can't be migrated in place.
export const AGENT_BUNDLE_FORMAT = 'cowork-agent-v1' as const

const AGENT_COLORS: AgentColor[] = ['primary', 'warning', 'accent', 'success', 'info', 'secondary']

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
  return {
    format: AGENT_BUNDLE_FORMAT,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    color: agent.color,
    avatar: agent.avatar || null,
    enabled: agent.enabled ?? true,
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
    color,
    avatar: typeof record.avatar === 'string' ? record.avatar : null,
    enabled: record.enabled === false ? false : true,
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
    enabled: bundle.enabled ?? true,
    color: bundle.color,
    avatar: bundle.avatar ?? null,
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
