import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { listCustomAgents, listCustomMcps, listCustomSkills } from './native-customizations.ts'
import {
  getMachineAgentsDir,
  getMachineSkillsDir,
  getProjectCoworkAgentsDir,
  getProjectCoworkSkillsDir,
  getRuntimeEnvPaths,
  getRuntimeHomeDir,
} from './runtime-paths.ts'
import { getProjectNamespace, getSidecarJsonSuffix } from './config-loader.ts'

function agentOverlayFileSuffixes() {
  return ['.md', '.disabled.md', getSidecarJsonSuffix()]
}

type ProjectOverlayManifest = {
  directory: string | null
  skillNames: string[]
  agentNames: string[]
  backedUpSkillNames: string[]
  backedUpAgentNames: string[]
}

function normalizeDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

// Returns true iff the project directory has any project-scoped skill,
// agent, or MCP that would change the OpenCode server's configuration.
// If false, switching to (or away from, while current is null) this
// directory doesn't require a server reboot — the runtime's existing
// config is equivalent.
//
// Used by `ensureRuntimeForDirectory` to short-circuit reboots when the
// overlay delta is empty. Cheap filesystem + config reads; no spawn.
export function projectHasOverlayContent(directory?: string | null): boolean {
  const normalized = normalizeDirectory(directory)
  if (!normalized) return false
  const skillMatch = (entry: { scope: string; directory?: string | null }) =>
    entry.scope === 'project' && normalizeDirectory(entry.directory) === normalized
  if (listCustomSkills({ directory: normalized }).some(skillMatch)) return true
  if (listCustomAgents({ directory: normalized }).some(skillMatch)) return true
  if (listCustomMcps({ directory: normalized }).some(skillMatch)) return true
  return false
}

function getProjectOverlayManifestPath() {
  return join(getRuntimeEnvPaths().configHome, 'opencode', `.${getProjectNamespace()}-project-overlay.json`)
}

function getProjectOverlayBackupRoot() {
  return join(getRuntimeEnvPaths().configHome, 'opencode', `.${getProjectNamespace()}-project-overlay-backups`)
}

function readProjectOverlayManifest(): ProjectOverlayManifest {
  const path = getProjectOverlayManifestPath()
  if (!existsSync(path)) {
    return { directory: null, skillNames: [], agentNames: [], backedUpSkillNames: [], backedUpAgentNames: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProjectOverlayManifest>
    return {
      directory: typeof parsed.directory === 'string' ? parsed.directory : null,
      skillNames: Array.isArray(parsed.skillNames) ? parsed.skillNames.filter((entry): entry is string => typeof entry === 'string') : [],
      agentNames: Array.isArray(parsed.agentNames) ? parsed.agentNames.filter((entry): entry is string => typeof entry === 'string') : [],
      backedUpSkillNames: Array.isArray(parsed.backedUpSkillNames)
        ? parsed.backedUpSkillNames.filter((entry): entry is string => typeof entry === 'string')
        : [],
      backedUpAgentNames: Array.isArray(parsed.backedUpAgentNames)
        ? parsed.backedUpAgentNames.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return { directory: null, skillNames: [], agentNames: [], backedUpSkillNames: [], backedUpAgentNames: [] }
  }
}

function writeProjectOverlayManifest(manifest: ProjectOverlayManifest) {
  writeFileSync(getProjectOverlayManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`)
}

export function clearProjectOverlayCopies() {
  const manifest = readProjectOverlayManifest()
  const skillsRoot = getMachineSkillsDir()
  const agentsRoot = getMachineAgentsDir()
  const backupRoot = getProjectOverlayBackupRoot()
  const backupSkillsRoot = join(backupRoot, 'skills')
  const backupAgentsRoot = join(backupRoot, 'agents')

  for (const skillName of manifest.skillNames) {
    rmSync(join(skillsRoot, skillName), { recursive: true, force: true })
  }

  for (const skillName of manifest.backedUpSkillNames) {
    const backup = join(backupSkillsRoot, skillName)
    const destination = join(skillsRoot, skillName)
    if (!existsSync(backup)) continue
    rmSync(destination, { recursive: true, force: true })
    cpSync(backup, destination, { recursive: true })
    rmSync(backup, { recursive: true, force: true })
  }

  const agentSuffixes = agentOverlayFileSuffixes()
  for (const agentName of manifest.agentNames) {
    for (const suffix of agentSuffixes) {
      rmSync(join(agentsRoot, `${agentName}${suffix}`), { force: true })
    }
  }

  for (const agentName of manifest.backedUpAgentNames) {
    for (const suffix of agentSuffixes) {
      const backup = join(backupAgentsRoot, `${agentName}${suffix}`)
      const destination = join(agentsRoot, `${agentName}${suffix}`)
      if (!existsSync(backup)) continue
      cpSync(backup, destination, { recursive: false })
      rmSync(backup, { force: true })
    }
  }

  rmSync(backupRoot, { recursive: true, force: true })

  writeProjectOverlayManifest({
    directory: null,
    skillNames: [],
    agentNames: [],
    backedUpSkillNames: [],
    backedUpAgentNames: [],
  })
}

export function syncProjectOverlayToRuntime(projectDirectory?: string | null) {
  clearProjectOverlayCopies()

  const normalized = normalizeDirectory(projectDirectory)
  if (!normalized || normalized === normalizeDirectory(getRuntimeHomeDir())) {
    return null
  }

  const skillsRoot = getMachineSkillsDir()
  const agentsRoot = getMachineAgentsDir()
  const backupRoot = getProjectOverlayBackupRoot()
  const backupSkillsRoot = join(backupRoot, 'skills')
  const backupAgentsRoot = join(backupRoot, 'agents')
  mkdirSync(skillsRoot, { recursive: true })
  mkdirSync(agentsRoot, { recursive: true })
  mkdirSync(backupSkillsRoot, { recursive: true })
  mkdirSync(backupAgentsRoot, { recursive: true })

  const projectSkills = listCustomSkills({ directory: normalized })
    .filter((skill) => skill.scope === 'project' && skill.directory === normalized)
    .map((skill) => skill.name)
  const projectAgents = listCustomAgents({ directory: normalized })
    .filter((agent) => agent.scope === 'project' && agent.directory === normalized)
    .map((agent) => agent.name)

  const skillSourceRoot = getProjectCoworkSkillsDir(normalized)
  const agentSourceRoot = getProjectCoworkAgentsDir(normalized)
  const backedUpSkillNames = new Set<string>()
  const backedUpAgentNames = new Set<string>()

  for (const skillName of projectSkills) {
    const source = join(skillSourceRoot, skillName)
    const destination = join(skillsRoot, skillName)
    if (!existsSync(source)) continue
    if (existsSync(destination)) {
      const backup = join(backupSkillsRoot, skillName)
      rmSync(backup, { recursive: true, force: true })
      cpSync(destination, backup, { recursive: true })
      backedUpSkillNames.add(skillName)
    }
    rmSync(destination, { recursive: true, force: true })
    cpSync(source, destination, { recursive: true })
  }

  for (const agentName of projectAgents) {
    let backedUp = false
    for (const suffix of agentOverlayFileSuffixes()) {
      const source = join(agentSourceRoot, `${agentName}${suffix}`)
      const destination = join(agentsRoot, `${agentName}${suffix}`)
      if (!existsSync(source)) continue
      if (existsSync(destination)) {
        const backup = join(backupAgentsRoot, `${agentName}${suffix}`)
        rmSync(backup, { force: true })
        cpSync(destination, backup, { recursive: false })
        backedUp = true
      }
      rmSync(destination, { recursive: true, force: true })
      cpSync(source, destination, { recursive: false })
    }
    if (backedUp) {
      backedUpAgentNames.add(agentName)
    }
  }

  writeProjectOverlayManifest({
    directory: normalized,
    skillNames: projectSkills,
    agentNames: projectAgents,
    backedUpSkillNames: Array.from(backedUpSkillNames).sort((a, b) => a.localeCompare(b)),
    backedUpAgentNames: Array.from(backedUpAgentNames).sort((a, b) => a.localeCompare(b)),
  })

  return normalized
}
