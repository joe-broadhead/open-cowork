import { buildManagedRuntimeEnvironment } from '@open-cowork/runtime-host/runtime-environment'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import {
  CloudExecutionIsolationError,
  type CloudExecutionProvisionInput,
} from './execution-isolation.ts'
import type { SandboxMountPolicy } from './runtime-portability.ts'

export const SANDBOX_CONTAINER_WORKSPACE = '/workspace'

const CONTAINER_RUNTIME_ROOT = '/runtime-home'
const CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const WORKSPACE_CONFIG_MASK_ROOT = '.open-cowork-workspace-config-mask'

function privateRuntimePaths(input: CloudExecutionProvisionInput) {
  const xdg = input.paths.getRuntimeXdgRoots()
  return Array.from(new Set([
    input.paths.getRuntimeHomeDir(),
    xdg.configHome,
    xdg.dataHome,
    xdg.stateHome,
    xdg.cacheHome,
  ].map((path) => resolve(path))))
}

function pathInside(root: string, candidate: string) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function canonicalPrivateRuntimePaths(
  input: CloudExecutionProvisionInput,
  runtimeRootPath: string,
) {
  const configuredRoot = resolve(runtimeRootPath)
  const canonicalRoot = realpathSync(configuredRoot)
  const rootStat = lstatSync(canonicalRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CloudExecutionIsolationError('private_runtime_root_invalid')
  }

  const paths = privateRuntimePaths(input).map((rawPath) => {
    const rel = relative(configuredRoot, rawPath)
    if (
      !rel
      || rel.startsWith('..')
      || isAbsolute(rel)
      || rel.split(/[\\/]+/).includes('..')
    ) {
      throw new CloudExecutionIsolationError('private_runtime_path_invalid')
    }
    const path = resolve(canonicalRoot, rel)
    if (!pathInside(canonicalRoot, path) || path === canonicalRoot) {
      throw new CloudExecutionIsolationError('private_runtime_path_invalid')
    }
    return path
  })
  return {
    canonicalRoot,
    paths: Array.from(new Set(paths)),
  }
}

function ensureCanonicalDirectoryChain(canonicalRoot: string, target: string) {
  const rel = relative(canonicalRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CloudExecutionIsolationError('private_runtime_path_invalid')
  }
  let current = canonicalRoot
  for (const segment of rel.split(/[\\/]+/)) {
    current = join(current, segment)
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(current)
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || realpathSync(current) !== current
      || !pathInside(canonicalRoot, current)
    ) {
      throw new CloudExecutionIsolationError('private_runtime_path_invalid')
    }
  }
}

function removePrivateRuntimePath(canonicalRoot: string, path: string) {
  ensureCanonicalDirectoryChain(canonicalRoot, dirname(path))
  try {
    const stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const canonicalPath = realpathSync(path)
      if (canonicalPath !== path || !pathInside(canonicalRoot, canonicalPath)) {
        throw new CloudExecutionIsolationError('private_runtime_path_invalid')
      }
    }
    rmSync(path, {
      recursive: stat.isDirectory() && !stat.isSymbolicLink(),
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function resetSandboxPrivateRuntimePaths(
  input: CloudExecutionProvisionInput,
  runtimeRootPath: string,
) {
  try {
    const scope = canonicalPrivateRuntimePaths(input, runtimeRootPath)
    for (const path of scope.paths.sort((left, right) => right.length - left.length)) {
      removePrivateRuntimePath(scope.canonicalRoot, path)
    }
    for (const path of scope.paths) {
      ensureCanonicalDirectoryChain(scope.canonicalRoot, path)
      chmodSync(path, 0o700)
    }
  } catch (error) {
    if (error instanceof CloudExecutionIsolationError) throw error
    throw new CloudExecutionIsolationError('private_runtime_path_invalid')
  }
}

function preparePrivateRuntimePaths(
  input: CloudExecutionProvisionInput,
  runtimeRootPath: string,
) {
  const workspace = input.paths.resolveWorkspacePath(
    input.execution.tenantId,
    input.execution.sessionId,
  )
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const scope = canonicalPrivateRuntimePaths(input, runtimeRootPath)
  for (const path of scope.paths) {
    ensureCanonicalDirectoryChain(scope.canonicalRoot, path)
    chmodSync(path, 0o700)
  }
  return workspace
}

export function sandboxPrivateRuntimeScopeKey(
  input: CloudExecutionProvisionInput,
  runtimeRootPath: string,
) {
  try {
    return canonicalPrivateRuntimePaths(input, runtimeRootPath)
      .paths
      .sort()
      .join('\0')
  } catch (error) {
    if (error instanceof CloudExecutionIsolationError) throw error
    throw new CloudExecutionIsolationError('private_runtime_path_invalid')
  }
}

export function removeSandboxPrivateRuntimePaths(
  input: CloudExecutionProvisionInput,
  runtimeRootPath: string,
) {
  // These session-scoped roots are the only transient credential-bearing
  // directories owned by the boundary. Project/checkpoint state owns workspace.
  try {
    const scope = canonicalPrivateRuntimePaths(input, runtimeRootPath)
    for (const path of scope.paths.sort((left, right) => right.length - left.length)) {
      removePrivateRuntimePath(scope.canonicalRoot, path)
    }
  } catch (error) {
    if (error instanceof CloudExecutionIsolationError) throw error
    throw new CloudExecutionIsolationError('private_runtime_path_invalid')
  }
}

function writePrivateFileAtomic(path: string, body: string, mode: number) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new CloudExecutionIsolationError('private_runtime_nofollow_unavailable')
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      mode,
    )
    fchmodSync(descriptor, mode)
    const bytes = Buffer.from(body)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      )
      if (!Number.isInteger(written) || written <= 0) {
        throw new CloudExecutionIsolationError('private_runtime_file_write_failed')
      }
      offset += written
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    // rename replaces a raced symlink itself; it never follows the target.
    renameSync(temporaryPath, path)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new CloudExecutionIsolationError('private_runtime_file_invalid')
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The atomic rename may already have consumed the temporary file.
    }
    if (error instanceof CloudExecutionIsolationError) throw error
    throw new CloudExecutionIsolationError('private_runtime_file_write_failed')
  }
}

function escapeEnvFileValue(value: string) {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new CloudExecutionIsolationError('runtime_environment_value_invalid')
  }
  return value
}

function writeContainerEnvironmentFile(input: CloudExecutionProvisionInput, auth: {
  username: string
  password: string
}) {
  const runtimePaths = {
    home: `${CONTAINER_RUNTIME_ROOT}/home`,
    configHome: `${CONTAINER_RUNTIME_ROOT}/xdg/config`,
    dataHome: `${CONTAINER_RUNTIME_ROOT}/xdg/data`,
    stateHome: `${CONTAINER_RUNTIME_ROOT}/xdg/state`,
    cacheHome: `${CONTAINER_RUNTIME_ROOT}/xdg/cache`,
  }
  const env = buildManagedRuntimeEnvironment({
    // Network policy, not inherited operator proxy credentials, owns egress.
    currentEnv: {
      PATH: CONTAINER_PATH,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
    },
    runtimePaths,
    serverAuth: {
      ...auth,
      authorizationHeader: '',
    },
  })
  // These two values are minted per boundary by Cloud composition.
  for (const key of [
    'OPEN_COWORK_KNOWLEDGE_TOOL_URL',
    'OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN',
  ]) {
    const value = input.env[key]
    if (value !== undefined) env[key] = value
  }
  // Project config/plugins/agents must not widen the managed runtime policy.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
  env.OPENCODE_CONFIG_DIR = `${runtimePaths.configHome}/opencode`
  const path = join(input.paths.getRuntimeHomeDir(), '.open-cowork-boundary.env')
  const body = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeEnvFileValue(value)}`)
    .join('\n')
  writePrivateFileAtomic(path, `${body}\n`, 0o600)
  return path
}

type RuntimeConfig = CloudExecutionProvisionInput['runtimeConfig']

function withExplicitWorkspaceInstructions(
  runtimeConfig: RuntimeConfig,
  workspace: string,
): RuntimeConfig {
  try {
    if (!lstatSync(join(workspace, 'AGENTS.md')).isFile()) return runtimeConfig
  } catch {
    return runtimeConfig
  }
  const existing = Array.isArray(runtimeConfig?.instructions)
    ? runtimeConfig.instructions.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    ...runtimeConfig,
    instructions: Array.from(new Set([
      ...existing,
      `${SANDBOX_CONTAINER_WORKSPACE}/AGENTS.md`,
    ])),
  }
}

function prepareRuntimeAssets(
  runtimeConfig: RuntimeConfig,
  allowedAssetPaths: readonly string[],
) {
  if (!runtimeConfig?.mcp || typeof runtimeConfig.mcp !== 'object') {
    return { runtimeConfig, mounts: [] as SandboxMountPolicy[] }
  }
  const allowlist = new Set(allowedAssetPaths.map((path) => resolve(path)))
  const mounts: SandboxMountPolicy[] = []
  const mcp = Object.fromEntries(Object.entries(runtimeConfig.mcp).map(([name, raw]) => {
    if (!raw || typeof raw !== 'object') return [name, raw]
    const entry = raw as { command?: unknown }
    if (!Array.isArray(entry.command)) return [name, raw]
    const command = entry.command.map((arg) => {
      if (typeof arg !== 'string' || !isAbsolute(arg)) return arg
      const source = resolve(arg)
      if (!allowlist.has(source)) {
        throw new CloudExecutionIsolationError('runtime_asset_not_allowlisted')
      }
      const target = `/runtime-assets/${mounts.length}-${basename(source)}`
      mounts.push({
        source,
        target,
        mode: 'read-only',
        purpose: 'metadata',
      })
      return target
    })
    return [name, { ...raw, command }]
  }))
  return {
    runtimeConfig: {
      ...runtimeConfig,
      mcp,
    },
    mounts,
  }
}

function workspaceConfigMaskMounts(
  input: CloudExecutionProvisionInput,
  workspace: string,
) {
  const maskRoot = join(input.paths.getRuntimeHomeDir(), WORKSPACE_CONFIG_MASK_ROOT)
  const emptyDirectory = join(maskRoot, 'empty-directory')
  const emptyConfig = join(maskRoot, 'empty.json')
  mkdirSync(emptyDirectory, { recursive: true, mode: 0o700 })
  chmodSync(maskRoot, 0o700)
  chmodSync(emptyDirectory, 0o700)
  writePrivateFileAtomic(emptyConfig, '{}\n', 0o600)

  // OpenCode 1.18.1's classic config layer honors
  // OPENCODE_DISABLE_PROJECT_CONFIG, but its native V2 config layer still
  // discovers project opencode.json(c) and .opencode content. Nested read-only
  // mounts give both runtimes the same managed view without mutating the
  // tenant's project files on the host.
  const targets = [
    { path: join(workspace, 'opencode.json'), kind: 'file' as const },
    { path: join(workspace, 'opencode.jsonc'), kind: 'file' as const },
    { path: join(workspace, '.opencode'), kind: 'directory' as const },
  ]
  const placeholders = targets.filter((target) => {
    try {
      const stat = lstatSync(target.path)
      if (stat.isSymbolicLink()) {
        throw new CloudExecutionIsolationError('workspace_config_mask_target_invalid')
      }
      if (
        (target.kind === 'file' && !stat.isFile())
        || (target.kind === 'directory' && !stat.isDirectory())
      ) {
        throw new CloudExecutionIsolationError('workspace_config_mask_target_invalid')
      }
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  })
  const mounts: SandboxMountPolicy[] = [
    {
      source: emptyConfig,
      target: `${SANDBOX_CONTAINER_WORKSPACE}/opencode.json`,
      mode: 'read-only',
      purpose: 'metadata',
    },
    {
      source: emptyConfig,
      target: `${SANDBOX_CONTAINER_WORKSPACE}/opencode.jsonc`,
      mode: 'read-only',
      purpose: 'metadata',
    },
    {
      source: emptyDirectory,
      target: `${SANDBOX_CONTAINER_WORKSPACE}/.opencode`,
      mode: 'read-only',
      purpose: 'metadata',
    },
  ]
  return {
    mounts,
    cleanupPlaceholders() {
      for (const placeholder of placeholders) {
        let stat
        try {
          stat = lstatSync(placeholder.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const safeEmptyPlaceholder = placeholder.kind === 'file'
          ? stat.isFile() && stat.size === 0
          : stat.isDirectory() && readdirSync(placeholder.path).length === 0
        if (!safeEmptyPlaceholder || stat.isSymbolicLink()) {
          throw new CloudExecutionIsolationError(
            'workspace_config_mask_placeholder_changed',
          )
        }
        rmSync(placeholder.path, {
          recursive: placeholder.kind === 'directory',
          force: true,
        })
      }
    },
  }
}

function runtimeMounts(
  input: CloudExecutionProvisionInput,
  workspace: string,
  assetMounts: SandboxMountPolicy[],
  configMaskMounts: SandboxMountPolicy[],
): SandboxMountPolicy[] {
  const xdg = input.paths.getRuntimeXdgRoots()
  return [
    {
      source: workspace,
      target: SANDBOX_CONTAINER_WORKSPACE,
      mode: 'read-write',
      purpose: 'workspace',
    },
    {
      source: input.paths.getRuntimeHomeDir(),
      target: `${CONTAINER_RUNTIME_ROOT}/home`,
      mode: 'read-write',
      purpose: 'runtime-home',
    },
    {
      source: xdg.configHome,
      target: `${CONTAINER_RUNTIME_ROOT}/xdg/config`,
      mode: 'read-write',
      purpose: 'runtime-home',
    },
    {
      source: xdg.dataHome,
      target: `${CONTAINER_RUNTIME_ROOT}/xdg/data`,
      mode: 'read-write',
      purpose: 'runtime-home',
    },
    {
      source: xdg.stateHome,
      target: `${CONTAINER_RUNTIME_ROOT}/xdg/state`,
      mode: 'read-write',
      purpose: 'runtime-home',
    },
    {
      source: xdg.cacheHome,
      target: `${CONTAINER_RUNTIME_ROOT}/xdg/cache`,
      mode: 'read-write',
      purpose: 'runtime-cache',
    },
    ...configMaskMounts,
    ...assetMounts,
  ]
}

export function prepareSandboxExecutionEnvironment(
  input: CloudExecutionProvisionInput,
  auth: { username: string, password: string },
  allowedAssetPaths: readonly string[],
  runtimeRootPath: string,
) {
  const workspace = preparePrivateRuntimePaths(input, runtimeRootPath)
  const runtimeConfig = withExplicitWorkspaceInstructions(input.runtimeConfig, workspace)
  const assets = prepareRuntimeAssets(runtimeConfig, allowedAssetPaths)
  const configMasks = workspaceConfigMaskMounts(input, workspace)
  return {
    runtimeConfig: assets.runtimeConfig,
    mounts: runtimeMounts(input, workspace, assets.mounts, configMasks.mounts),
    envFile: writeContainerEnvironmentFile(input, auth),
    cleanupWorkspaceMaskPlaceholders: configMasks.cleanupPlaceholders,
  }
}
