import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'
import { getMachineSkillsDir, getManagedSkillsDir, getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.ts'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.ts'
import { buildRuntimeSkillCatalog } from './runtime-skill-catalog.ts'

const { app } = electron

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
  if (existsSync(direct)) return direct
  if (!existsSync(root)) return null

  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    for (const entry of readdirSync(current)) {
      const candidate = join(current, entry)
      let stats
      try {
        stats = statSync(candidate)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      if (entry === skillName && existsSync(join(candidate, 'SKILL.md'))) {
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
// reads AGENTS.md from cwd, and OpenCode discovers skills from the
// documented XDG config location (`~/.config/opencode/skills`). Because
// `withRuntimeEnvironment` points XDG_CONFIG_HOME at `runtime-home/.config`,
// `getMachineSkillsDir()` is still app-isolated and safe to populate.
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
    cpSync(source, destination, { recursive: true })
    // OpenCode's native skill tool currently discovers from fixed
    // locations (`~/.config/opencode/skills`, project `.opencode/skills`,
    // and compatibility dirs). Mirror configured Open Cowork skills into
    // the isolated runtime global dir so `skill({ name })` works without
    // inventing an app-side skill loader.
    const discoverableDestination = join(discoverableSkillsDst, skillName)
    rmSync(discoverableDestination, { recursive: true, force: true })
    cpSync(source, discoverableDestination, { recursive: true })
  }

  const activeOverlayDirectory = syncProjectOverlayToRuntime(projectDirectory)
  buildRuntimeSkillCatalog({ directory: activeOverlayDirectory })
  return activeOverlayDirectory
}
