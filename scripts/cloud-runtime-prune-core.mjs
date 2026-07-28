import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'

const ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'open-cowork.config.json',
  'open-cowork.config.schema.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

const CLOUD_RUNTIME_METADATA_FILE = 'apps/desktop/dist/cloud/cloud-runtime-workspaces.json'
const REQUIRED_CLOUD_ASSETS = [
  'open-cowork-cloud.mjs',
  'open-cowork-cloud-migrate.mjs',
  'mcp-knowledge.mjs',
  'browser-renderer/browser.html',
  'browser-renderer/chart-frame.html',
]

const WORKSPACE_ARTIFACTS = ['package.json', 'dist', 'dist-browser']
const BUILT_IN_CLOUD_PROFILE_NAMES = ['full', 'focused-agent', 'custom']
const BUILT_IN_CLOUD_PROFILE_CAPABILITIES = {
  'focused-agent': {
    agents: [],
    tools: [],
    mcps: [],
  },
}

class CloudRuntimePruneError extends Error {
  constructor(code, path, detail) {
    super(`${code}: ${path}${detail ? ` (${detail})` : ''}`)
    this.name = 'CloudRuntimePruneError'
    this.code = code
    this.path = path
  }
}

function normalizedPath(path) {
  return path.split(sep).join('/')
}

function resolveWithin(root, path, code = 'CLOUD_RUNTIME_PATH_UNSAFE') {
  const base = resolve(root)
  const target = resolve(base, path)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new CloudRuntimePruneError(code, path, `path escapes ${base}`)
  }
  return target
}

function readJson(path, code, displayPath) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CloudRuntimePruneError(code, displayPath, error.message)
  }
}

function requireFile(repoRoot, path) {
  const absolute = join(repoRoot, path)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new CloudRuntimePruneError('CLOUD_RUNTIME_ARTIFACT_MISSING', path, 'required file')
  }
  return absolute
}

function requireDirectory(repoRoot, path) {
  const absolute = join(repoRoot, path)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new CloudRuntimePruneError('CLOUD_RUNTIME_ARTIFACT_MISSING', path, 'required directory')
  }
  return absolute
}

function requireRegularFile(repoRoot, path) {
  const absolute = resolveWithin(repoRoot, path)
  if (
    !existsSync(absolute)
    || lstatSync(absolute).isSymbolicLink()
    || !lstatSync(absolute).isFile()
  ) {
    throw new CloudRuntimePruneError('CLOUD_RUNTIME_ARTIFACT_MISSING', path, 'required regular file')
  }
  return absolute
}

function requireRealDirectory(repoRoot, path) {
  const absolute = resolveWithin(repoRoot, path)
  if (
    !existsSync(absolute)
    || lstatSync(absolute).isSymbolicLink()
    || !lstatSync(absolute).isDirectory()
  ) {
    throw new CloudRuntimePruneError('CLOUD_RUNTIME_ARTIFACT_MISSING', path, 'required real directory')
  }
  return absolute
}

function assertTreeHasNoSymlinks(path, displayPath) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    const relativeEntry = `${displayPath}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_DYNAMIC_ASSET_SYMLINK',
        relativeEntry,
        'symbolic links are not allowed in configured runtime assets',
      )
    }
    if (entry.isDirectory()) assertTreeHasNoSymlinks(entryPath, relativeEntry)
  }
}

function assertCopiedPathHasNoSymlinks(repoRoot, path) {
  const absolute = resolveWithin(repoRoot, path)
  const metadata = lstatSync(absolute)
  if (metadata.isSymbolicLink()) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_PAYLOAD_SYMLINK',
      path,
      'symbolic links are not allowed in the production runtime payload',
    )
  }
  if (!metadata.isDirectory()) return
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    assertCopiedPathHasNoSymlinks(repoRoot, `${path}/${entry.name}`)
  }
}

function requireDynamicAssetName(value, kind) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_DYNAMIC_ASSET_NAME_INVALID',
      String(value || ''),
      `${kind} names must be one lowercase path-safe segment`,
    )
  }
  return name
}

function workspacePatterns(source) {
  const patterns = []
  let inPackages = false
  for (const line of source.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const item = line.match(/^\s+-\s+(.+?)\s*$/)
    if (item) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ''))
      continue
    }
    if (/^\S/.test(line) && line.trim()) break
  }
  if (patterns.length === 0) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_WORKSPACE_CONFIG_INVALID',
      'pnpm-workspace.yaml',
      'packages list is empty',
    )
  }
  return patterns
}

function expandWorkspacePattern(repoRoot, pattern) {
  if (!pattern.includes('*')) return [pattern]
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_WORKSPACE_PATTERN_UNSUPPORTED',
      pattern,
      'only exact paths and one-level /* patterns are supported',
    )
  }
  const parent = pattern.slice(0, -2)
  const absoluteParent = join(repoRoot, parent)
  if (!existsSync(absoluteParent)) return []
  return readdirSync(absoluteParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
}

function discoverWorkspaces(repoRoot) {
  const workspaceYaml = requireFile(repoRoot, 'pnpm-workspace.yaml')
  const directories = workspacePatterns(readFileSync(workspaceYaml, 'utf8'))
    .flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern))
    .filter((path) => existsSync(join(repoRoot, path, 'package.json')))
    .sort()
  const byName = new Map()
  const byPath = new Map()

  for (const path of directories) {
    const manifest = readJson(
      join(repoRoot, path, 'package.json'),
      'CLOUD_RUNTIME_WORKSPACE_MANIFEST_INVALID',
      `${path}/package.json`,
    )
    if (typeof manifest.name !== 'string' || !manifest.name) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_WORKSPACE_NAME_MISSING',
        `${path}/package.json`,
      )
    }
    if (byName.has(manifest.name)) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_WORKSPACE_NAME_DUPLICATE',
        manifest.name,
      )
    }
    const workspace = { path, manifest }
    byName.set(manifest.name, workspace)
    byPath.set(path, workspace)
  }
  return { byName, byPath, directories }
}

function productionWorkspaceClosure(rootManifest, workspaces, seedWorkspaces) {
  const pending = []
  for (const [name, version] of Object.entries(rootManifest.dependencies || {})) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      if (!workspaces.byName.has(name)) {
        throw new CloudRuntimePruneError(
          'CLOUD_RUNTIME_WORKSPACE_DEPENDENCY_MISSING',
          name,
          'declared by root package.json',
        )
      }
      pending.push(name)
    }
  }
  pending.push(...seedWorkspaces.map((workspace) => workspace.manifest.name))

  const included = new Map()
  while (pending.length > 0) {
    const name = pending.shift()
    if (included.has(name)) continue
    const workspace = workspaces.byName.get(name)
    if (!workspace) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_WORKSPACE_DEPENDENCY_MISSING',
        name,
      )
    }
    included.set(name, workspace)
    for (const [dependencyName, version] of Object.entries(workspace.manifest.dependencies || {})) {
      if (typeof version !== 'string' || !version.startsWith('workspace:')) continue
      if (!workspaces.byName.has(dependencyName)) {
        throw new CloudRuntimePruneError(
          'CLOUD_RUNTIME_WORKSPACE_DEPENDENCY_MISSING',
          dependencyName,
          `declared by ${workspace.path}/package.json`,
        )
      }
      pending.push(dependencyName)
    }
  }

  return Array.from(included.values()).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function cloudProfilePolicy(config, profileName) {
  const cloud = config.cloud && typeof config.cloud === 'object'
    ? config.cloud
    : {}
  const profiles = cloud.profiles && typeof cloud.profiles === 'object'
    ? cloud.profiles
    : {}
  const configuredProfile = profiles[profileName] && typeof profiles[profileName] === 'object'
    ? profiles[profileName]
    : {}
  const profile = {
    ...(BUILT_IN_CLOUD_PROFILE_CAPABILITIES[profileName] || {}),
    ...configuredProfile,
  }
  const runtime = {
    ...(cloud.runtime && typeof cloud.runtime === 'object' ? cloud.runtime : {}),
    ...(profile.runtime && typeof profile.runtime === 'object' ? profile.runtime : {}),
  }
  return {
    profile,
    allowLocalStdioMcps: runtime.allowLocalStdioMcps === true,
    allowedLocalMcpNames: new Set(
      Array.isArray(runtime.allowedLocalMcpNames)
        ? runtime.allowedLocalMcpNames.filter((name) => typeof name === 'string')
        : [],
    ),
  }
}

function profileAllowsNamedCapability(allowlist, name) {
  return !Array.isArray(allowlist) || allowlist.includes(name)
}

function isCommandLaunchedLocalMcp(mcp) {
  return mcp?.type === 'local'
    && Array.isArray(mcp.command)
}

function assertNoEnabledBareLocalMcps(config) {
  const cloud = config.cloud && typeof config.cloud === 'object'
    ? config.cloud
    : {}
  const profileNames = new Set([
    ...BUILT_IN_CLOUD_PROFILE_NAMES,
    typeof cloud.defaultProfile === 'string' && cloud.defaultProfile.trim()
      ? cloud.defaultProfile.trim()
      : 'full',
    ...(
      cloud.profiles && typeof cloud.profiles === 'object'
        ? Object.keys(cloud.profiles)
        : []
    ),
  ])

  for (const profileName of profileNames) {
    const policy = cloudProfilePolicy(config, profileName)
    for (const [index, mcp] of (Array.isArray(config.mcps) ? config.mcps : []).entries()) {
      if (
        !isCommandLaunchedLocalMcp(mcp)
        || !profileAllowsNamedCapability(policy.profile.mcps, mcp.name)
        || (
          !policy.allowLocalStdioMcps
          && !policy.allowedLocalMcpNames.has(mcp.name)
        )
      ) {
        continue
      }
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_BARE_MCP_COMMAND_UNSUPPORTED',
        `open-cowork.config.json.mcps[${index}].command`,
        `Cloud profile ${profileName} enables ${mcp.name || index}, but production commands must be packageName-backed`,
      )
    }
  }
}

export function resolveEffectiveCloudRuntimeConfig(config) {
  assertNoEnabledBareLocalMcps(config)

  const cloud = config.cloud && typeof config.cloud === 'object'
    ? config.cloud
    : {}
  const profileName = typeof cloud.defaultProfile === 'string' && cloud.defaultProfile.trim()
    ? cloud.defaultProfile.trim()
    : 'full'
  const policy = cloudProfilePolicy(config, profileName)
  const mcps = (Array.isArray(config.mcps) ? config.mcps : []).filter((mcp) => (
    profileAllowsNamedCapability(policy.profile.mcps, mcp?.name)
    && !isCommandLaunchedLocalMcp(mcp)
  ))
  const mcpNames = new Set(mcps.map((mcp) => mcp.name))
  const tools = (Array.isArray(config.tools) ? config.tools : []).filter((tool) => (
    profileAllowsNamedCapability(policy.profile.tools, tool?.id)
    && (!tool?.namespace || mcpNames.has(tool.namespace))
  ))
  const toolIds = new Set(tools.map((tool) => tool.id))
  const skills = (Array.isArray(config.skills) ? config.skills : []).filter((skill) => (
    !Array.isArray(skill?.toolIds)
    || skill.toolIds.every((toolId) => toolIds.has(toolId))
  ))
  const skillNames = new Set(skills.map((skill) => skill.sourceName))
  const agents = (Array.isArray(config.agents) ? config.agents : []).filter((agent) => (
    profileAllowsNamedCapability(policy.profile.agents, agent?.name)
    && (
      !Array.isArray(agent?.toolIds)
      || agent.toolIds.every((toolId) => toolIds.has(toolId))
    )
    && (
      !Array.isArray(agent?.skillNames)
      || agent.skillNames.every((skillName) => skillNames.has(skillName))
    )
  ))
  const agentNames = new Set(agents.map((agent) => agent.name))
  const removedMcpNames = new Set(
    (Array.isArray(config.mcps) ? config.mcps : [])
      .map((mcp) => mcp?.name)
      .filter((name) => name && !mcpNames.has(name)),
  )
  const removedToolIds = new Set(
    (Array.isArray(config.tools) ? config.tools : [])
      .map((tool) => tool?.id)
      .filter((id) => id && !toolIds.has(id)),
  )
  const removedAgentNames = new Set(
    (Array.isArray(config.agents) ? config.agents : [])
      .map((agent) => agent?.name)
      .filter((name) => name && !agentNames.has(name)),
  )
  const filterRemoved = (values, removed) => (
    Array.isArray(values)
      ? values.filter((value) => !removed.has(value))
      : values
  )
  const filterRuntime = (runtime) => (
    runtime && typeof runtime === 'object'
      ? {
          ...runtime,
          allowedLocalMcpNames: filterRemoved(
            runtime.allowedLocalMcpNames,
            removedMcpNames,
          ),
        }
      : runtime
  )
  const effectiveCloud = config.cloud && typeof config.cloud === 'object'
    ? {
        ...config.cloud,
        runtime: filterRuntime(config.cloud.runtime),
        profiles: config.cloud.profiles && typeof config.cloud.profiles === 'object'
          ? Object.fromEntries(Object.entries(config.cloud.profiles).map(([name, profile]) => [
              name,
              profile && typeof profile === 'object'
                ? {
                    ...profile,
                    agents: filterRemoved(profile.agents, removedAgentNames),
                    tools: filterRemoved(profile.tools, removedToolIds),
                    mcps: filterRemoved(profile.mcps, removedMcpNames),
                    runtime: filterRuntime(profile.runtime),
                  }
                : profile,
            ]))
          : config.cloud.profiles,
      }
    : config.cloud

  return {
    ...config,
    tools,
    skills,
    mcps,
    agents,
    ...(effectiveCloud ? { cloud: effectiveCloud } : {}),
  }
}

function runtimeConfigAssets(repoRoot, workspaces) {
  const sourceConfig = readJson(
    requireFile(repoRoot, 'open-cowork.config.json'),
    'CLOUD_RUNTIME_CONFIG_INVALID',
    'open-cowork.config.json',
  )
  const config = resolveEffectiveCloudRuntimeConfig(sourceConfig)
  const mcpWorkspaces = []
  for (const mcp of (Array.isArray(config.mcps) ? config.mcps : [])) {
    if (mcp?.type !== 'local') continue
    if (typeof mcp.packageName === 'string' && mcp.packageName.trim()) {
      const packageName = requireDynamicAssetName(mcp.packageName, 'MCP package')
      const path = `mcps/${packageName}`
      const workspace = workspaces.byPath.get(path)
      if (!workspace) {
        throw new CloudRuntimePruneError(
          'CLOUD_RUNTIME_DYNAMIC_MCP_WORKSPACE_MISSING',
          path,
          `configured MCP ${mcp.name || mcp.packageName}`,
        )
      }
      mcpWorkspaces.push(workspace)
    }
  }

  const skills = Array.from(new Set(
    (Array.isArray(config.skills) ? config.skills : [])
      .map((skill) => skill?.sourceName)
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => `skills/${requireDynamicAssetName(name, 'skill')}`),
  )).sort()

  return {
    mcpWorkspaces: Array.from(new Map(mcpWorkspaces.map((workspace) => [workspace.path, workspace])).values())
      .sort((left, right) => left.path.localeCompare(right.path, 'en')),
    skills,
    effectiveConfig: config,
  }
}

function bundleRuntimeMetadata(repoRoot, workspaces) {
  const path = CLOUD_RUNTIME_METADATA_FILE
  const metadata = readJson(
    requireFile(repoRoot, path),
    'CLOUD_RUNTIME_BUNDLE_METADATA_INVALID',
    path,
  )
  if (
    metadata.schemaVersion !== 3
    || !Array.isArray(metadata.bundledSourceWorkspaces)
    || !metadata.bundledSourceWorkspaces.every((workspace) => typeof workspace === 'string')
    || !Array.isArray(metadata.externalPackages)
    || !metadata.externalPackages.every((dependency) => typeof dependency === 'string')
    || !Array.isArray(metadata.runtimePackages)
    || !metadata.runtimePackages.every((dependency) => typeof dependency === 'string')
    || !Array.isArray(metadata.runtimeAssets)
    || !metadata.runtimeAssets.every((asset) => typeof asset === 'string')
  ) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_BUNDLE_METADATA_INVALID',
      path,
      'expected schemaVersion 3 with source workspaces, external packages, runtime packages, and runtime assets',
    )
  }
  const bundledSourceWorkspaces = Array.from(new Set(metadata.bundledSourceWorkspaces))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((workspacePath) => {
      const workspace = workspaces.byPath.get(workspacePath)
      if (!workspace) {
        throw new CloudRuntimePruneError(
          'CLOUD_RUNTIME_BUNDLE_WORKSPACE_MISSING',
          workspacePath,
          `declared by ${path}`,
        )
      }
      return workspace
    })
  const externalPackages = Array.from(new Set(metadata.externalPackages))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const runtimePackages = Array.from(new Set(metadata.runtimePackages))
    .sort((left, right) => left.localeCompare(right, 'en'))
  for (const dependency of [...externalPackages, ...runtimePackages]) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(dependency)) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_BUNDLE_METADATA_INVALID',
        dependency,
        'external package name is invalid',
      )
    }
  }
  const runtimeAssets = Array.from(new Set(metadata.runtimeAssets))
    .sort((left, right) => left.localeCompare(right, 'en'))
  for (const asset of runtimeAssets) {
    if (
      !asset
      || asset.includes('\\')
      || asset.startsWith('/')
      || asset.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_BUNDLE_METADATA_INVALID',
        asset,
        'runtime asset path must be relative and confined',
      )
    }
  }
  for (const requiredAsset of REQUIRED_CLOUD_ASSETS) {
    if (!runtimeAssets.includes(requiredAsset)) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_BUNDLE_METADATA_INVALID',
        requiredAsset,
        'required Cloud runtime asset is absent from the generated inventory',
      )
    }
  }
  return {
    bundledSourceWorkspaces,
    externalPackages,
    runtimePackages,
    runtimeAssets,
  }
}

function listFiles(path) {
  if (!existsSync(path)) return []
  const metadata = lstatSync(path)
  if (!metadata.isDirectory()) return [path]
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => listFiles(join(path, entry.name)))
}

function bytesForPaths(paths) {
  const files = new Set(paths.flatMap(listFiles).map((path) => resolve(path)))
  let bytes = 0
  for (const file of files) {
    const metadata = lstatSync(file)
    if (metadata.isFile()) bytes += metadata.size
  }
  return bytes
}

function preflight(repoRoot, outDir) {
  for (const path of ROOT_FILES) requireFile(repoRoot, path)
  requireDirectory(repoRoot, 'THIRD_PARTY_LICENSES')
  requireDirectory(repoRoot, 'apps/desktop/dist/cloud')
  requireFile(repoRoot, 'apps/desktop/runtime-config/AGENTS.md')
  requireRegularFile(repoRoot, CLOUD_RUNTIME_METADATA_FILE)

  const rootManifest = readJson(
    join(repoRoot, 'package.json'),
    'CLOUD_RUNTIME_ROOT_MANIFEST_INVALID',
    'package.json',
  )
  const workspaces = discoverWorkspaces(repoRoot)
  const dynamicAssets = runtimeConfigAssets(repoRoot, workspaces)
  const bundleMetadata = bundleRuntimeMetadata(repoRoot, workspaces)
  for (const asset of bundleMetadata.runtimeAssets) {
    requireRegularFile(repoRoot, `apps/desktop/dist/cloud/${asset}`)
  }
  for (const skill of dynamicAssets.skills) {
    const skillDirectory = requireRealDirectory(repoRoot, skill)
    requireFile(repoRoot, `${skill}/SKILL.md`)
    assertTreeHasNoSymlinks(skillDirectory, skill)
  }
  const externalWorkspaceSeeds = []
  for (const dependency of Array.from(new Set([
    ...bundleMetadata.externalPackages,
    ...bundleMetadata.runtimePackages,
  ]))) {
    if (
      typeof rootManifest.dependencies?.[dependency] !== 'string'
      || !rootManifest.dependencies[dependency]
    ) {
      throw new CloudRuntimePruneError(
        'CLOUD_RUNTIME_EXTERNAL_DEPENDENCY_MISSING',
        dependency,
        'generated Cloud runtime dependency must be a direct root production dependency',
      )
    }
    const workspace = workspaces.byName.get(dependency)
    if (workspace) externalWorkspaceSeeds.push(workspace)
  }

  const closure = productionWorkspaceClosure(
    rootManifest,
    workspaces,
    [...dynamicAssets.mcpWorkspaces, ...externalWorkspaceSeeds],
  )
  for (const workspace of closure) {
    requireFile(repoRoot, `${workspace.path}/package.json`)
    requireDirectory(repoRoot, `${workspace.path}/dist`)
  }

  const copyPaths = [
    ...ROOT_FILES,
    'THIRD_PARTY_LICENSES',
    CLOUD_RUNTIME_METADATA_FILE,
    ...bundleMetadata.runtimeAssets.map((asset) => `apps/desktop/dist/cloud/${asset}`),
    'apps/desktop/runtime-config/AGENTS.md',
    ...dynamicAssets.skills,
    ...closure.flatMap((workspace) => [
      `${workspace.path}/package.json`,
      `${workspace.path}/dist`,
    ]),
  ]
  for (const path of copyPaths) assertCopiedPathHasNoSymlinks(repoRoot, path)

  const eligibleWorkspacePaths = workspaces.directories.flatMap((workspace) => {
    return WORKSPACE_ARTIFACTS
      .map((artifact) => join(repoRoot, workspace, artifact))
      .filter(existsSync)
  })
  const copiedWorkspacePaths = closure.flatMap((workspace) => {
    return [
      join(repoRoot, workspace.path, 'package.json'),
      join(repoRoot, workspace.path, 'dist'),
    ]
  })

  const target = resolve(outDir)
  const root = resolve(repoRoot)
  if (
    target === parse(target).root
    || target === root
    || root.startsWith(`${target}${sep}`)
  ) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_OUTPUT_UNSAFE',
      target,
      'output must not be the repository, a repository ancestor, or filesystem root',
    )
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new CloudRuntimePruneError(
      'CLOUD_RUNTIME_OUTPUT_UNSAFE',
      target,
      'symbolic-link outputs are not allowed',
    )
  }

  return {
    closure,
    dynamicAssets,
    bundleMetadata,
    copyPaths,
    eligibleWorkspaceBytes: bytesForPaths(eligibleWorkspacePaths),
    copiedWorkspaceBytes: bytesForPaths(copiedWorkspacePaths),
  }
}

function copyRelative(repoRoot, outDir, path) {
  const source = resolveWithin(repoRoot, path)
  const target = resolveWithin(outDir, path)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, dereference: false })
}

function fileManifest(outDir) {
  return listFiles(outDir)
    .map((path) => {
      const metadata = lstatSync(path)
      const manifestPath = normalizedPath(relative(outDir, path))
      return {
        path: manifestPath,
        type: 'file',
        bytes: metadata.size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export function pruneCloudRuntime(input) {
  const repoRoot = resolve(input.repoRoot)
  const outDir = resolve(input.outDir)
  const plan = preflight(repoRoot, outDir)

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  for (const path of plan.copyPaths) copyRelative(repoRoot, outDir, path)
  writeFileSync(
    join(outDir, 'open-cowork.config.json'),
    `${JSON.stringify(plan.dynamicAssets.effectiveConfig, null, 2)}\n`,
    { mode: 0o644 },
  )
  for (const path of plan.copyPaths) assertCopiedPathHasNoSymlinks(outDir, path)

  const files = fileManifest(outDir)
  const copiedWorkspaceBytes = plan.copiedWorkspaceBytes
  const eligibleWorkspaceBytes = plan.eligibleWorkspaceBytes
  const savedBytes = Math.max(0, eligibleWorkspaceBytes - copiedWorkspaceBytes)
  const manifest = {
    schemaVersion: 1,
    productionWorkspaces: plan.closure.map((workspace) => workspace.path),
    bundleSourceWorkspaces: plan.bundleMetadata.bundledSourceWorkspaces.map((workspace) => workspace.path),
    externalPackages: plan.bundleMetadata.externalPackages,
    runtimePackages: plan.bundleMetadata.runtimePackages,
    entrypoints: REQUIRED_CLOUD_ASSETS.map((path) => `apps/desktop/dist/cloud/${path}`),
    dynamicAssets: {
      mcpWorkspaces: plan.dynamicAssets.mcpWorkspaces.map((workspace) => workspace.path),
      skills: plan.dynamicAssets.skills,
      runtimeAgent: 'apps/desktop/runtime-config/AGENTS.md',
    },
    comparison: {
      eligibleWorkspaceBytes,
      copiedWorkspaceBytes,
      savedBytes,
      savedPercent: eligibleWorkspaceBytes === 0
        ? 0
        : Number(((savedBytes / eligibleWorkspaceBytes) * 100).toFixed(2)),
      payloadBytes: files.reduce((sum, file) => sum + (file.bytes || 0), 0),
    },
    files,
  }
  writeFileSync(
    join(outDir, 'cloud-runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  )
  return manifest
}
