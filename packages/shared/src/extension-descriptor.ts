// Unified "extension" descriptor.
//
// A single typed shape that can represent any of Open Cowork's installable
// units — a skill bundle, a custom MCP server, a custom agent, or a provider —
// under one contract (id, kind, name, source, setup steps, secret
// requirements). It is the foundation for a future unified Extensions surface
// and the item shape carried by the shareable setup bundle
// (`setup-bundle.ts`).
//
// This module is pure and browser-safe: it performs no IO and imports no Node
// built-ins. Redaction (stripping API keys, tokens, OAuth secrets, and
// absolute local paths) happens here so the same logic runs on desktop, in the
// browser, and in tests.

import type {
  AgentColor,
  CustomAgentConfig,
  CustomAgentMode,
  CustomAgentPermissionOverride,
  CustomAgentSummary,
  CustomMcpConfig,
  CustomMcpPermissionMode,
  CustomSkillConfig,
} from './custom-content.js'

export const EXTENSION_DESCRIPTOR_SCHEMA_VERSION = 1 as const

// Placeholder written in place of any redacted secret value. Import machinery
// treats a payload field still equal to this placeholder as "unsatisfied" and
// will not install the extension until the operator supplies the real value.
export const EXTENSION_REDACTED_PLACEHOLDER = '__OPEN_COWORK_REDACTED__' as const

export type ExtensionKind = 'skill' | 'mcp' | 'agent' | 'provider'

// Where a redacted secret must be reapplied on the importing machine.
//   env        → a stdio MCP environment variable value
//   header     → a remote MCP HTTP header value
//   credential → a provider credential / API key
//   path       → an absolute local filesystem path (install-specific)
export type ExtensionSecretLocation = 'env' | 'header' | 'credential' | 'path'

export interface ExtensionSecretRequirement {
  // Namespaced key, e.g. `env:API_TOKEN`, `header:Authorization`,
  // `credential:apiKey`, or `path:0`. Import supplies values keyed by this
  // exact string.
  key: string
  location: ExtensionSecretLocation
  label: string
  required: boolean
}

export interface ExtensionSetupStep {
  kind: 'install' | 'configure-secret' | 'note'
  detail: string
}

export interface ExtensionSource {
  // How this descriptor was produced. `export` = emitted from a live
  // deployment's installed set; `external` = mapped in from a foreign plugin
  // bundle.
  origin: 'export' | 'builtin' | 'custom' | 'external'
  // The original scope of the exported item. Reset to machine on import unless
  // the operator picks a project scope.
  scope?: 'machine' | 'project'
  // Free-form reference back to where the item came from (a bundle name, a
  // vendor id, …). Advisory only.
  reference?: string
}

// Portable, redacted MCP shape. `scope`/`directory`/`workspaceId` are stripped
// (they are install-specific); secret values in `env`/`headers` and any
// absolute paths in `command`/`args` are replaced with the redaction
// placeholder and re-declared in the descriptor's `secrets`.
export interface McpExtensionPayload {
  name: string
  label?: string
  description?: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  googleAuth?: boolean
  allowPrivateNetwork?: boolean
  permissionMode?: CustomMcpPermissionMode
  traceLabel?: string
  tracePluralLabel?: string
}

export interface SkillExtensionPayload {
  name: string
  content: string
  files?: Array<{ path: string; content: string }>
  toolIds?: string[]
}

// Portable agent shape — the same field set as `AgentBundle`, minus the
// on-disk format tag. Agents reference skills/tools by id and carry no
// secrets, so no redaction is needed.
export interface AgentExtensionPayload {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  mode?: CustomAgentMode
  color: AgentColor
  avatar?: string | null
  enabled?: boolean
  permissionOverrides?: CustomAgentPermissionOverride[]
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

// Provider *shape* only — never secrets. `options` keeps non-secret knobs
// (baseURL host, etc.) but redacts anything credential-like.
export interface ProviderExtensionPayload {
  id: string
  runtime: 'builtin' | 'custom'
  name?: string
  defaultModel?: string
  models?: Record<string, unknown>
  options?: Record<string, unknown>
}

export type ExtensionPayload =
  | { kind: 'skill'; skill: SkillExtensionPayload }
  | { kind: 'mcp'; mcp: McpExtensionPayload }
  | { kind: 'agent'; agent: AgentExtensionPayload }
  | { kind: 'provider'; provider: ProviderExtensionPayload }

export interface ExtensionDescriptor {
  schemaVersion: typeof EXTENSION_DESCRIPTOR_SCHEMA_VERSION
  id: string
  kind: ExtensionKind
  name: string
  description?: string
  source: ExtensionSource
  secrets: ExtensionSecretRequirement[]
  setup: ExtensionSetupStep[]
  payload: ExtensionPayload
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

// Absolute filesystem path detection: POSIX (`/x`), Windows drive (`C:\x`),
// and UNC (`\\host`). Deliberately conservative — relative launchers such as
// `npx`/`node`/`uvx` stay intact.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

function isAbsolutePathToken(value: string): boolean {
  return ABSOLUTE_PATH.test(value.trim())
}

function nonEmptyRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// MCP <-> descriptor
// ---------------------------------------------------------------------------

export function mcpToExtensionDescriptor(
  mcp: CustomMcpConfig,
  source: Partial<ExtensionSource> = {},
): ExtensionDescriptor {
  const secrets: ExtensionSecretRequirement[] = []
  const setup: ExtensionSetupStep[] = [
    { kind: 'install', detail: `Register ${mcp.type === 'stdio' ? 'local' : 'remote'} MCP server "${mcp.name}".` },
  ]

  const payload: McpExtensionPayload = {
    name: mcp.name,
    type: mcp.type,
    ...(mcp.label ? { label: mcp.label } : {}),
    ...(mcp.description ? { description: mcp.description } : {}),
    ...(mcp.googleAuth ? { googleAuth: true } : {}),
    ...(mcp.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(mcp.permissionMode ? { permissionMode: mcp.permissionMode } : {}),
    ...(mcp.traceLabel ? { traceLabel: mcp.traceLabel } : {}),
    ...(mcp.tracePluralLabel ? { tracePluralLabel: mcp.tracePluralLabel } : {}),
  }

  if (mcp.type === 'stdio') {
    // Absolute command path is install-specific → redact + mark.
    if (mcp.command && isAbsolutePathToken(mcp.command)) {
      payload.command = EXTENSION_REDACTED_PLACEHOLDER
      secrets.push({ key: 'path:command', location: 'path', label: `Local path for "${mcp.name}" command`, required: true })
    } else if (mcp.command) {
      payload.command = mcp.command
    }
    const args = mcp.args || []
    payload.args = args.map((arg, index) => {
      if (isAbsolutePathToken(arg)) {
        secrets.push({ key: `path:arg:${index}`, location: 'path', label: `Local path for "${mcp.name}" argument ${index + 1}`, required: true })
        return EXTENSION_REDACTED_PLACEHOLDER
      }
      return arg
    })
    const env = nonEmptyRecord(mcp.env)
    if (env) {
      payload.env = Object.fromEntries(Object.keys(env).map((key) => {
        secrets.push({ key: `env:${key}`, location: 'env', label: `Environment secret ${key} for "${mcp.name}"`, required: true })
        return [key, EXTENSION_REDACTED_PLACEHOLDER]
      }))
    }
  } else {
    if (mcp.url) payload.url = mcp.url
    const headers = nonEmptyRecord(mcp.headers)
    if (headers) {
      payload.headers = Object.fromEntries(Object.keys(headers).map((key) => {
        secrets.push({ key: `header:${key}`, location: 'header', label: `Header secret ${key} for "${mcp.name}"`, required: true })
        return [key, EXTENSION_REDACTED_PLACEHOLDER]
      }))
    }
  }

  for (const secret of secrets) {
    setup.push({ kind: 'configure-secret', detail: `Provide ${secret.label}.` })
  }

  return {
    schemaVersion: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
    id: `mcp:${mcp.name}`,
    kind: 'mcp',
    name: mcp.name,
    ...(mcp.description ? { description: mcp.description } : {}),
    source: { origin: 'export', scope: mcp.scope, ...source },
    secrets,
    setup,
    payload: { kind: 'mcp', mcp: payload },
  }
}

export function extensionDescriptorToMcp(
  descriptor: ExtensionDescriptor,
  target: { scope: 'machine' | 'project'; directory?: string | null },
  secretValues: Record<string, string> = {},
): CustomMcpConfig {
  if (descriptor.payload.kind !== 'mcp') {
    throw new Error(`extensionDescriptorToMcp: descriptor ${descriptor.id} is not an MCP.`)
  }
  const payload = descriptor.payload.mcp
  const fill = (value: string | undefined, key: string): string | undefined => {
    if (value !== EXTENSION_REDACTED_PLACEHOLDER) return value
    return secretValues[key] ?? EXTENSION_REDACTED_PLACEHOLDER
  }

  const mcp: CustomMcpConfig = {
    scope: target.scope,
    directory: target.scope === 'project' ? target.directory ?? null : null,
    name: payload.name,
    type: payload.type,
    ...(payload.label ? { label: payload.label } : {}),
    ...(payload.description ? { description: payload.description } : {}),
    ...(payload.googleAuth ? { googleAuth: true } : {}),
    ...(payload.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
    ...(payload.traceLabel ? { traceLabel: payload.traceLabel } : {}),
    ...(payload.tracePluralLabel ? { tracePluralLabel: payload.tracePluralLabel } : {}),
  }

  if (payload.type === 'stdio') {
    mcp.command = fill(payload.command, 'path:command')
    mcp.args = (payload.args || []).map((arg, index) => fill(arg, `path:arg:${index}`) ?? arg)
    if (payload.env) {
      mcp.env = Object.fromEntries(Object.keys(payload.env).map((key) => [key, secretValues[`env:${key}`] ?? EXTENSION_REDACTED_PLACEHOLDER]))
    }
  } else {
    if (payload.url) mcp.url = payload.url
    if (payload.headers) {
      mcp.headers = Object.fromEntries(Object.keys(payload.headers).map((key) => [key, secretValues[`header:${key}`] ?? EXTENSION_REDACTED_PLACEHOLDER]))
    }
  }

  return mcp
}

// ---------------------------------------------------------------------------
// Skill <-> descriptor
// ---------------------------------------------------------------------------

export function skillToExtensionDescriptor(
  skill: CustomSkillConfig,
  source: Partial<ExtensionSource> = {},
): ExtensionDescriptor {
  return {
    schemaVersion: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
    id: `skill:${skill.name}`,
    kind: 'skill',
    name: skill.name,
    source: { origin: 'export', scope: skill.scope, ...source },
    secrets: [],
    setup: [{ kind: 'install', detail: `Install skill bundle "${skill.name}".` }],
    payload: {
      kind: 'skill',
      skill: {
        name: skill.name,
        content: skill.content,
        ...(skill.files && skill.files.length > 0 ? { files: skill.files } : {}),
        ...(skill.toolIds && skill.toolIds.length > 0 ? { toolIds: skill.toolIds } : {}),
      },
    },
  }
}

export function extensionDescriptorToSkill(
  descriptor: ExtensionDescriptor,
  target: { scope: 'machine' | 'project'; directory?: string | null },
): CustomSkillConfig {
  if (descriptor.payload.kind !== 'skill') {
    throw new Error(`extensionDescriptorToSkill: descriptor ${descriptor.id} is not a skill.`)
  }
  const payload = descriptor.payload.skill
  return {
    scope: target.scope,
    directory: target.scope === 'project' ? target.directory ?? null : null,
    name: payload.name,
    content: payload.content,
    ...(payload.files && payload.files.length > 0 ? { files: payload.files } : {}),
    ...(payload.toolIds && payload.toolIds.length > 0 ? { toolIds: payload.toolIds } : {}),
  }
}

// ---------------------------------------------------------------------------
// Agent <-> descriptor
// ---------------------------------------------------------------------------

export function agentToExtensionDescriptor(
  agent: CustomAgentConfig | CustomAgentSummary,
  source: Partial<ExtensionSource> = {},
): ExtensionDescriptor {
  const payload: AgentExtensionPayload = {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    skillNames: [...agent.skillNames],
    toolIds: [...agent.toolIds],
    ...(agent.mode ? { mode: agent.mode } : {}),
    color: agent.color,
    avatar: agent.avatar ?? null,
    enabled: agent.enabled ?? true,
    ...(agent.permissionOverrides ? { permissionOverrides: agent.permissionOverrides } : {}),
    model: agent.model ?? null,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.top_p ?? null,
    steps: agent.steps ?? null,
    options: agent.options ?? null,
  }
  return {
    schemaVersion: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
    id: `agent:${agent.name}`,
    kind: 'agent',
    name: agent.name,
    description: agent.description,
    source: { origin: 'export', scope: agent.scope, ...source },
    secrets: [],
    setup: [{ kind: 'install', detail: `Install agent "${agent.name}" (references skills/tools by id).` }],
    payload: { kind: 'agent', agent: payload },
  }
}

export function extensionDescriptorToAgent(
  descriptor: ExtensionDescriptor,
  target: { scope: 'machine' | 'project'; directory?: string | null },
): CustomAgentConfig {
  if (descriptor.payload.kind !== 'agent') {
    throw new Error(`extensionDescriptorToAgent: descriptor ${descriptor.id} is not an agent.`)
  }
  const payload = descriptor.payload.agent
  return {
    scope: target.scope,
    directory: target.scope === 'project' ? target.directory ?? null : null,
    name: payload.name,
    description: payload.description,
    instructions: payload.instructions,
    skillNames: [...payload.skillNames],
    toolIds: [...payload.toolIds],
    mode: payload.mode,
    enabled: payload.enabled ?? true,
    color: payload.color,
    avatar: payload.avatar ?? null,
    ...(payload.permissionOverrides ? { permissionOverrides: payload.permissionOverrides } : {}),
    model: payload.model ?? null,
    variant: payload.variant ?? null,
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    steps: payload.steps ?? null,
    options: payload.options ?? null,
  }
}

// ---------------------------------------------------------------------------
// Provider <-> descriptor (shape only — never secrets)
// ---------------------------------------------------------------------------

export interface ProviderExtensionInput {
  id: string
  runtime?: 'builtin' | 'custom'
  name?: string
  defaultModel?: string
  models?: Record<string, unknown>
  options?: Record<string, unknown>
}

// Option keys whose values are treated as credentials and stripped from any
// exported provider shape.
const PROVIDER_SECRET_OPTION_KEYS = new Set(['apikey', 'api_key', 'token', 'secret', 'password', 'authtoken'])

function isSecretOptionKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (PROVIDER_SECRET_OPTION_KEYS.has(lower)) return true
  return /key$|token$|secret$|password$/.test(lower)
}

export function providerToExtensionDescriptor(
  provider: ProviderExtensionInput,
  source: Partial<ExtensionSource> = {},
): ExtensionDescriptor {
  const secrets: ExtensionSecretRequirement[] = []
  const options: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(provider.options || {})) {
    if (isSecretOptionKey(key)) {
      options[key] = EXTENSION_REDACTED_PLACEHOLDER
      secrets.push({ key: `credential:${key}`, location: 'credential', label: `Provider credential ${key} for "${provider.id}"`, required: true })
    } else {
      options[key] = value
    }
  }
  return {
    schemaVersion: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
    id: `provider:${provider.id}`,
    kind: 'provider',
    name: provider.name || provider.id,
    source: { origin: 'export', ...source },
    secrets,
    setup: [
      { kind: 'install', detail: `Register provider "${provider.id}" (shape only; credentials never exported).` },
      ...secrets.map((secret) => ({ kind: 'configure-secret' as const, detail: `Provide ${secret.label}.` })),
    ],
    payload: {
      kind: 'provider',
      provider: {
        id: provider.id,
        runtime: provider.runtime || 'custom',
        ...(provider.name ? { name: provider.name } : {}),
        ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
        ...(provider.models ? { models: provider.models } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Required secrets whose value is still the redaction placeholder after
// applying `secretValues`. Import uses this to decide "needs-secret".
export function unsatisfiedSecrets(
  descriptor: ExtensionDescriptor,
  secretValues: Record<string, string> = {},
): ExtensionSecretRequirement[] {
  return descriptor.secrets.filter((secret) => {
    if (!secret.required) return false
    const supplied = secretValues[secret.key]
    return !supplied || supplied === EXTENSION_REDACTED_PLACEHOLDER
  })
}
