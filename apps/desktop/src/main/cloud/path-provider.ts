import { join, resolve, relative, isAbsolute } from 'path'

export type RuntimeXdgRoots = {
  home: string
  configHome: string
  dataHome: string
  stateHome: string
  cacheHome: string
}

export type CloudPathRoots = {
  appDataDir: string
  runtimeHomeDir: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgStateHome: string
  xdgCacheHome: string
  workspaceRoot: string
  artifactRoot: string
}

export type PathProvider = {
  getAppDataDir: () => string
  getRuntimeHomeDir: () => string
  getRuntimeXdgRoots: () => RuntimeXdgRoots
  getWorkspaceRoot: () => string
  getArtifactRoot: () => string
  resolveWorkspacePath: (...segments: string[]) => string
  resolveArtifactPath: (...segments: string[]) => string
}

function assertRelativeSegments(segments: readonly string[]) {
  for (const segment of segments) {
    const parts = segment.split(/[\\/]+/)
    if (!segment || segment === '.' || segment.includes('\0') || isAbsolute(segment) || parts.includes('..')) {
      throw new Error('Cloud path segments must be non-empty relative path parts.')
    }
  }
}

function resolveInside(root: string, segments: readonly string[]) {
  assertRelativeSegments(segments)
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...segments)
  const rel = relative(resolvedRoot, target)
  if (rel && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`Resolved path escapes cloud root ${resolvedRoot}.`)
  }
  return target
}

function normalizeRoots(roots: CloudPathRoots): CloudPathRoots {
  return {
    appDataDir: resolve(roots.appDataDir),
    runtimeHomeDir: resolve(roots.runtimeHomeDir),
    xdgConfigHome: resolve(roots.xdgConfigHome),
    xdgDataHome: resolve(roots.xdgDataHome),
    xdgStateHome: resolve(roots.xdgStateHome),
    xdgCacheHome: resolve(roots.xdgCacheHome),
    workspaceRoot: resolve(roots.workspaceRoot),
    artifactRoot: resolve(roots.artifactRoot),
  }
}

export function createStaticPathProvider(roots: CloudPathRoots): PathProvider {
  const normalized = normalizeRoots(roots)
  return {
    getAppDataDir: () => normalized.appDataDir,
    getRuntimeHomeDir: () => normalized.runtimeHomeDir,
    getRuntimeXdgRoots: () => ({
      home: normalized.runtimeHomeDir,
      configHome: normalized.xdgConfigHome,
      dataHome: normalized.xdgDataHome,
      stateHome: normalized.xdgStateHome,
      cacheHome: normalized.xdgCacheHome,
    }),
    getWorkspaceRoot: () => normalized.workspaceRoot,
    getArtifactRoot: () => normalized.artifactRoot,
    resolveWorkspacePath: (...segments: string[]) => resolveInside(normalized.workspaceRoot, segments),
    resolveArtifactPath: (...segments: string[]) => resolveInside(normalized.artifactRoot, segments),
  }
}

export function createCloudPathProvider(root: string): PathProvider {
  const base = resolve(root)
  return createStaticPathProvider({
    appDataDir: join(base, 'app'),
    runtimeHomeDir: join(base, 'runtime', 'home'),
    xdgConfigHome: join(base, 'runtime', 'xdg', 'config'),
    xdgDataHome: join(base, 'runtime', 'xdg', 'data'),
    xdgStateHome: join(base, 'runtime', 'xdg', 'state'),
    xdgCacheHome: join(base, 'runtime', 'xdg', 'cache'),
    workspaceRoot: join(base, 'workspaces'),
    artifactRoot: join(base, 'artifacts'),
  })
}
