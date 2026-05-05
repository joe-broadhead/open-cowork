import electron from 'electron'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'
import { getMachineSkillsDir, getManagedSkillsDir, getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.ts'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.ts'
import { buildRuntimeSkillCatalog } from './runtime-skill-catalog.ts'

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
// prepared skill catalog via `skills.paths`. Because the managed OpenCode
// server is launched with XDG_CONFIG_HOME pointing at `runtime-home/.config`,
// the compatibility mirror in `getMachineSkillsDir()` is still app-isolated
// and safe to populate.
export function copySkillsAndAgents(projectDirectory?: string | null) {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')

  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  const skillsDst = getManagedSkillsDir()
  const discoverableSkillsDst = getMachineSkillsDir()
  const runtimeSkillCatalog = getRuntimeSkillCatalogDir()
  rmSync(skillsDst, { recursive: true, force: true })
  rmSync(runtimeSkillCatalog, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })
  mkdirSync(discoverableSkillsDst, { recursive: true })

  // Older installs populated `runtime-home/.opencode/skills/` because
  // OpenCode used to discover skills cwd-relative. Keep clearing that
  // stale project-local tree so `du` reads match the user's mental model
  // ("fresh install only contains what the app uses") and so a future SDK
  // change that re-enables cwd-relative discovery can't resurface old skills.
  const legacyCwdSkills = join(runtimeHome, '.opencode', 'skills')
  if (existsSync(legacyCwdSkills)) {
    rmSync(legacyCwdSkills, { recursive: true, force: true })
  }

  const skillSourceRoots = getBundledSkillRoots()
  for (const skillName of Array.from(new Set(getConfiguredSkillsFromConfig().map((skill) => skill.sourceName)))) {
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
    // buildRuntimeConfig passes the prepared skill catalog through the
    // SDK-native `skills.paths` field. Keep this isolated XDG mirror as a
    // compatibility fallback for OpenCode discovery paths that still read
    // from ~/.config/opencode/skills.
    const discoverableDestination = join(discoverableSkillsDst, skillName)
    copySkillDirectory(source, discoverableDestination)
  }

  const activeOverlayDirectory = syncProjectOverlayToRuntime(projectDirectory)
  buildRuntimeSkillCatalog({ directory: activeOverlayDirectory })
  return activeOverlayDirectory
}
