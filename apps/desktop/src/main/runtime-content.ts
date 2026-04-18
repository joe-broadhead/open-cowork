import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'
import { getRuntimeHomeDir } from './runtime-paths.ts'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.ts'

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

// TODO(cowork): Migrate this three-root filesystem overlay to SDK v2's
// `Config.skills.paths?: string[]` (@opencode-ai/sdk types.gen.d.ts:1198).
//
// Why we haven't yet:
//   The current loop only copies skills whose names appear in
//   getConfiguredSkillsFromConfig(). That filter is the Cowork product
//   gate — it keeps OpenCode's runtime skill set aligned with what the
//   app surfaces in the Capabilities UI. A naive switch to
//   `skills.paths: [downstream, dev, packaged]` would make OpenCode
//   load every skill in those directories, including ones the Cowork
//   config never registered. That's a UX regression (hidden skills
//   become callable) and a downstream-distribution regression (a
//   downstream couldn't ship a skills/ dir with preview skills that
//   aren't yet opted into the catalog).
//
// Right migration path:
//   Copy the configured-skills subset once into a Cowork-managed dir
//   (e.g. runtime-home/managed-skills/) and pass that single path via
//   `config.skills.paths`. Keeps the product filter; removes the
//   implicit reliance on OpenCode reading runtime-home/.opencode/skills
//   from cwd. Still a filesystem copy, but the contract with the SDK
//   is explicit rather than path-coincidence.
//
// AGENTS.md and project-overlay copying stay out of scope for that
// migration — OpenCode reads AGENTS.md from cwd and the project
// overlay handles per-project .opencowork/skills.
export function copySkillsAndAgents(projectDirectory?: string | null) {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')

  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  rmSync(skillsDst, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })

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
  }

  return syncProjectOverlayToRuntime(projectDirectory)
}
