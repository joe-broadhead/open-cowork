import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfiguredSkillsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'
import { getRuntimeHomeDir } from './runtime-paths.ts'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.ts'

const { app } = electron

function findBundledSkillDir(root: string, skillName: string): string | null {
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

  const packagedSkillsSrc = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), '..', '..', 'skills')
  const downstreamSkillsSrc = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
    ? join(process.env.OPEN_COWORK_DOWNSTREAM_ROOT.trim(), 'skills')
    : null

  const skillSourceRoots = [join(runtimeConfigSrc, 'skills'), packagedSkillsSrc]
  if (downstreamSkillsSrc) {
    skillSourceRoots.unshift(downstreamSkillsSrc)
  }
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
