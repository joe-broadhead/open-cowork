import { getAppPathHost, writeFileAtomic } from '@open-cowork/shared/node'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getConfiguredSkillsFromConfig } from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import { getMachineSkillsDir, getManagedSkillsDir, getRuntimeHomeDir, getRuntimeSkillCatalogDir } from './runtime-paths.js'
import { syncProjectOverlayToRuntime } from './runtime-project-overlay.js'
import { buildRuntimeSkillCatalog } from './runtime-skill-catalog.js'
import { pruneManagedSkillMirror } from './runtime-skill-mirror.js'
import { syncCustomAgentRuntimeGuidance } from './native-customizations.js'
import { findBundledSkillDirInRoot, getBundledSkillIndex } from './bundled-skill-index.js'
import { getActiveManagedPolicy, isManagedPolicyExtensionClassEnabled } from './managed-policy.js'


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
  if (getAppPathHost()?.isPackaged) return join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'runtime-config')
  if (getAppPathHost()?.getAppPath) return join(getAppPathHost()!.getAppPath!(), 'runtime-config')
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
  // The app-path host is unset outside Electron (cloud / node:test), so fall
  // back to cwd-relative roots so tests can still resolve the repo's bundles.
  if (getAppPathHost()?.isPackaged) {
    roots.push(join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'runtime-config', 'skills'))
    roots.push(join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'skills'))
  } else if (getAppPathHost()?.getAppPath) {
    const appPath = getAppPathHost()!.getAppPath!()
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
  return findBundledSkillDirInRoot(root, skillName)
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
  const allowCustomSkills = isManagedPolicyExtensionClassEnabled(getActiveManagedPolicy(), 'customSkills')
  const skillSourceRoots = getBundledSkillRoots()
  const bundledSkillIndex = getBundledSkillIndex(skillSourceRoots)
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

  for (const skillName of Array.from(configuredSkillNames)) {
    const destination = join(skillsDst, skillName)
    const source = bundledSkillIndex.get(skillName)?.skillDir || null

    if (!source) {
      log('runtime', `Bundled skill not found: ${skillName}`)
      continue
    }

    mkdirSync(join(destination, '..'), { recursive: true })
    copySkillDirectory(source, destination)
  }

  syncCustomAgentRuntimeGuidance({ directory: projectDirectory || undefined })
  const activeOverlayDirectory = syncProjectOverlayToRuntime(projectDirectory, { includeSkills: false })
  buildRuntimeSkillCatalog({ directory: activeOverlayDirectory, includeCustomSkills: allowCustomSkills })
  return activeOverlayDirectory
}
