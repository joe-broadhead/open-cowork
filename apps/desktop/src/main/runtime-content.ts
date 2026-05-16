import electron from 'electron'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import { log } from './logger.ts'
import { getMachineSkillsDir, getManagedSkillsDir, getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.ts'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.ts'
import { buildRuntimeSkillCatalog } from './runtime-skill-catalog.ts'
import { pruneManagedSkillMirror } from './runtime-skill-mirror.ts'
import { syncCustomAgentRuntimeGuidance } from './native-customizations.ts'

const { app } = electron

function isInsideRoot(root: string, candidate: string) {
  const relativePath = relative(root, candidate)
  const firstSegment = relativePath.split(/[\\/]/, 1)[0]
  return relativePath === '' || (
    Boolean(relativePath)
    && firstSegment !== '..'
    && !isAbsolute(relativePath)
  )
}

function isSafeDirectoryInsideRoot(root: string, candidate: string) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (!isInsideRoot(absoluteRoot, absoluteCandidate)) return false
  if (!existsSync(absoluteCandidate)) return false

  try {
    if (lstatSync(absoluteCandidate).isSymbolicLink()) return false
    const realRoot = realpathSync.native(absoluteRoot)
    const realCandidate = realpathSync.native(absoluteCandidate)
    if (!isInsideRoot(realRoot, realCandidate)) return false
    return statSync(realCandidate).isDirectory()
  } catch {
    return false
  }
}

function isSafeFileInsideRoot(root: string, candidate: string) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (!isInsideRoot(absoluteRoot, absoluteCandidate)) return false
  if (!existsSync(absoluteCandidate)) return false

  try {
    if (lstatSync(absoluteCandidate).isSymbolicLink()) return false
    const realRoot = realpathSync.native(absoluteRoot)
    const realCandidate = realpathSync.native(absoluteCandidate)
    if (!isInsideRoot(realRoot, realCandidate)) return false
    return statSync(realCandidate).isFile()
  } catch {
    return false
  }
}

function hasSafeSkillDefinition(root: string, skillDir: string) {
  return isSafeDirectoryInsideRoot(root, skillDir)
    && isSafeFileInsideRoot(root, join(skillDir, 'SKILL.md'))
}

function copySkillDirectory(source: string, destination: string) {
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      try {
        return !lstatSync(sourcePath).isSymbolicLink()
      } catch {
        return false
      }
    },
  })
}

export function writeRuntimeAgentsFile(runtimeHome: string, agentsSrc: string) {
  writeFileAtomic(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'), { mode: 0o600 })
}

function runtimeConfigSourceDir() {
  if (app?.isPackaged) return join(process.resourcesPath, 'runtime-config')
  if (app?.getAppPath) return join(app.getAppPath(), 'runtime-config')
  const repoDesktopRuntimeConfig = join(process.cwd(), 'apps', 'desktop', 'runtime-config')
  return existsSync(repoDesktopRuntimeConfig)
    ? repoDesktopRuntimeConfig
    : join(process.cwd(), 'runtime-config')
}

// Root directories where bundled skill packages may live, in priority
// order. Exported so the effective-skills catalog can resolve the same
// paths as `copySkillsAndAgents` — otherwise the Capabilities UI's
// "Skill content" view reads from `process.cwd()/skills`, which is the
// sandbox runtime home after the startup chdir and has no bundles.
export function getBundledSkillRoots(): string[] {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  const roots: string[] = []
  // `app` is undefined outside Electron (e.g. in node:test), so fall back
  // to cwd-relative roots so tests can still resolve the repo's bundles.
  if (app?.isPackaged) {
    roots.push(join(process.resourcesPath, 'runtime-config', 'skills'))
    roots.push(join(process.resourcesPath, 'skills'))
  } else if (app?.getAppPath) {
    const appPath = app.getAppPath()
    roots.push(join(appPath, 'runtime-config', 'skills'))
    roots.push(join(appPath, '..', '..', 'skills'))
  } else {
    roots.push(join(process.cwd(), 'runtime-config', 'skills'))
    roots.push(join(process.cwd(), 'skills'))
  }
  if (downstreamRoot) {
    roots.unshift(join(downstreamRoot, 'skills'))
  }
  return roots
}

export function findBundledSkillDir(root: string, skillName: string): string | null {
  const direct = join(root, skillName)
  if (hasSafeSkillDefinition(root, direct)) return direct
  if (!existsSync(root)) return null

  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    for (const entry of readdirSync(current)) {
      const candidate = join(current, entry)
      if (!isSafeDirectoryInsideRoot(root, candidate)) continue
      if (entry === skillName && hasSafeSkillDefinition(root, candidate)) {
        return candidate
      }
      queue.push(candidate)
    }
  }

  return null
}

// Copies the configured-skill subset into Cowork-managed mirrors. The
// filter is the Cowork product gate — OpenCode only sees skills whose
// names appear in `getConfiguredSkillsFromConfig()`, so downstream
// distributions can ship a `skills/` dir with preview content without
// every entry becoming callable.
//
// AGENTS.md and project-overlay copying are separate concerns: OpenCode
// reads AGENTS.md from cwd, while buildRuntimeConfig points OpenCode at the
// prepared skill catalog via `skills.paths`. The OpenCode-discoverable XDG
// skills directory is reserved for user-authored custom skills; copying
// bundled skills there as well causes duplicate skill discovery in current
// OpenCode builds.
export function copySkillsAndAgents(projectDirectory?: string | null) {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = runtimeConfigSourceDir()

  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeRuntimeAgentsFile(runtimeHome, agentsSrc)
  }

  const skillsDst = getManagedSkillsDir()
  const customSkillsDst = getMachineSkillsDir()
  const runtimeSkillCatalog = getRuntimeSkillCatalogDir()
  const skillSourceRoots = getBundledSkillRoots()
  const configuredSkillNames = new Set(getConfiguredSkillsFromConfig().map((skill) => skill.sourceName))
  pruneManagedSkillMirror({
    discoverableSkillsDir: customSkillsDst,
    previousManagedSkillsDir: skillsDst,
    configuredSkillNames: new Set(),
  })
  rmSync(skillsDst, { recursive: true, force: true })
  rmSync(runtimeSkillCatalog, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })
  mkdirSync(customSkillsDst, { recursive: true })

  // Older installs populated `runtime-home/.opencode/skills/` because
  // OpenCode used to discover skills cwd-relative. Keep clearing that
  // stale project-local tree so `du` reads match the user's mental model
  // ("fresh install only contains what the app uses") and so a future SDK
  // change that re-enables cwd-relative discovery can't resurface old skills.
  const legacyCwdSkills = join(runtimeHome, '.opencode', 'skills')
  if (existsSync(legacyCwdSkills)) {
    rmSync(legacyCwdSkills, { recursive: true, force: true })
  }

  for (const skillName of Array.from(configuredSkillNames)) {
    const destination = join(skillsDst, skillName)
    const source = skillSourceRoots
      .map((root) => findBundledSkillDir(root, skillName))
      .find((candidate) => candidate && existsSync(candidate))

    if (!source) {
      log('runtime', `Bundled skill not found: ${skillName}`)
      continue
    }

    mkdirSync(join(destination, '..'), { recursive: true })
    copySkillDirectory(source, destination)
  }

  syncCustomAgentRuntimeGuidance({ directory: projectDirectory || undefined })
  const activeOverlayDirectory = syncProjectOverlayToRuntime(projectDirectory)
  buildRuntimeSkillCatalog({ directory: activeOverlayDirectory })
  return activeOverlayDirectory
}
