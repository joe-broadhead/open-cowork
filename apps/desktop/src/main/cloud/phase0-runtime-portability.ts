import { join, resolve } from 'node:path'

export type Phase0PortableRuntimeEntryKind =
  | 'opencode-config'
  | 'opencode-data'
  | 'opencode-state'
  | 'opencode-cache'
  | 'cowork-runtime-content'
  | 'workspace'
  | 'artifact'
  | 'metadata'

export type Phase0PortableRuntimeEntry = {
  kind: Phase0PortableRuntimeEntryKind
  path: string
  required: boolean
  secretBearing: boolean
  reason: string
}

type RuntimePathSet = {
  home: string
  configHome: string
  dataHome: string
  cacheHome: string
  stateHome: string
}

type Phase0PortableRuntimeManifestInput = {
  runtimePaths: RuntimePathSet
  workspaceDirs?: string[]
  artifactDirs?: string[]
  metadataPaths?: string[]
}

const SECRET_PATH_PATTERNS = [
  /(^|[/\\])auth\.json$/i,
  /(^|[/\\])settings\.enc$/i,
  /(^|[/\\])tokens?\.json$/i,
  /(^|[/\\])credentials?(\.[^.]+)?$/i,
  /(^|[/\\])\.?env(\.[^.]+)?$/i,
  /(^|[/\\])adc\.json$/i,
]

function entry(input: Phase0PortableRuntimeEntry): Phase0PortableRuntimeEntry {
  return {
    ...input,
    path: resolve(input.path),
  }
}

export function isPhase0SecretBearingPath(path: string) {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

export function buildPhase0PortableRuntimeManifest(input: Phase0PortableRuntimeManifestInput) {
  const { runtimePaths } = input
  const entries: Phase0PortableRuntimeEntry[] = [
    entry({
      kind: 'opencode-config',
      path: join(runtimePaths.configHome, 'opencode'),
      required: true,
      secretBearing: true,
      reason: 'OpenCode config, generated agents, generated skills, MCP config, and auth-adjacent settings can affect session reopen fidelity.',
    }),
    entry({
      kind: 'opencode-data',
      path: join(runtimePaths.dataHome, 'opencode'),
      required: true,
      secretBearing: true,
      reason: 'OpenCode-owned durable session data and provider auth live under the runtime data home.',
    }),
    entry({
      kind: 'opencode-state',
      path: join(runtimePaths.stateHome, 'opencode'),
      required: true,
      secretBearing: true,
      reason: 'OpenCode state can contain resumable runtime state and must be measured during Phase 0.',
    }),
    entry({
      kind: 'opencode-cache',
      path: join(runtimePaths.cacheHome, 'opencode'),
      required: false,
      secretBearing: false,
      reason: 'Cache is expected to be rebuildable, but Phase 0 records whether omit/restore changes reopen behavior.',
    }),
    entry({
      kind: 'cowork-runtime-content',
      path: join(runtimePaths.home, 'runtime-skill-catalog'),
      required: true,
      secretBearing: false,
      reason: 'Managed skill catalog is part of the generated runtime context used by OpenCode-native skills.',
    }),
    entry({
      kind: 'cowork-runtime-content',
      path: join(runtimePaths.home, 'managed-skills'),
      required: true,
      secretBearing: false,
      reason: 'Managed skill mirror is needed for diagnostics and reproducible runtime content.',
    }),
  ]

  for (const path of input.workspaceDirs || []) {
    entries.push(entry({
      kind: 'workspace',
      path,
      required: true,
      secretBearing: isPhase0SecretBearingPath(path),
      reason: 'Workspace or sandbox files are needed for tool outputs, diffs, artifacts, and follow-up prompts.',
    }))
  }
  for (const path of input.artifactDirs || []) {
    entries.push(entry({
      kind: 'artifact',
      path,
      required: true,
      secretBearing: isPhase0SecretBearingPath(path),
      reason: 'Generated artifacts and chart metadata must survive worker reassignment and browser reconnects.',
    }))
  }
  for (const path of input.metadataPaths || []) {
    entries.push(entry({
      kind: 'metadata',
      path,
      required: true,
      secretBearing: isPhase0SecretBearingPath(path),
      reason: 'Cowork session metadata links OpenCode sessions to cloud ownership, projections, and artifacts.',
    }))
  }

  return entries
}

// Kept as an explicit structural assertion so changes to runtime path shape
// surface in Phase 0 tests instead of silently weakening the manifest.
export function runtimePathsForPhase0(input: RuntimePathSet): RuntimePathSet {
  return {
    home: input.home,
    configHome: input.configHome,
    dataHome: input.dataHome,
    cacheHome: input.cacheHome,
    stateHome: input.stateHome,
  }
}
