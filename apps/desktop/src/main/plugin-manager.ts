import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from './logger'
import { BUILTIN_INTEGRATION_BUNDLES, type BundleMcp } from './integration-bundles'
import { loadSettings } from './settings'

interface Plugin {
  id: string
  name: string
  icon: string
  description: string
  longDescription?: string
  category: string
  author: string
  version: string
  builtin: boolean
  installed: boolean
  apps: Array<{ name: string; description: string; badge: string }>
  skills: Array<{ name: string; description: string; badge: string }>
  credentials?: Array<{ key: string; label: string; description: string; placeholder?: string; secret: boolean; configured: boolean }>
  allowedTools: string[]
  deniedTools: string[]
}

function getPluginStatePath(): string {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'plugins.json')
}

interface PluginState {
  installed: string[]
}

function loadState(): PluginState {
  const path = getPluginStatePath()
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch (e: any) {
      log('error', `Plugin state: ${e?.message}`)
    }
  }
  return {
    installed: BUILTIN_INTEGRATION_BUNDLES
      .filter((bundle) => bundle.enabledByDefault)
      .map((bundle) => bundle.id),
  }
}

function saveState(state: PluginState) {
  writeFileSync(getPluginStatePath(), JSON.stringify(state, null, 2))
}

function isInstalled(id: string, state = loadState()) {
  return state.installed.includes(id)
}

function bundleToPlugin(bundle: typeof BUILTIN_INTEGRATION_BUNDLES[number], installed: boolean): Plugin {
  const settings = loadSettings() as unknown as Record<string, unknown>
  return {
    id: bundle.id,
    name: bundle.name,
    icon: bundle.icon,
    description: bundle.description,
    longDescription: bundle.longDescription,
    category: bundle.category,
    author: bundle.author,
    version: bundle.version,
    builtin: bundle.builtin,
    installed,
    apps: bundle.apps,
    skills: bundle.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      badge: skill.badge,
    })),
    credentials: (bundle.credentials || []).map((credential) => ({
      ...credential,
      configured: Boolean(typeof settings[credential.key] === 'string' && String(settings[credential.key]).trim()),
    })),
    allowedTools: bundle.allowedTools,
    deniedTools: bundle.deniedTools,
  }
}

export function getInstalledPlugins(): Plugin[] {
  const state = loadState()
  return BUILTIN_INTEGRATION_BUNDLES.map((bundle) => bundleToPlugin(bundle, isInstalled(bundle.id, state)))
}

export function installPlugin(id: string): boolean {
  const bundle = BUILTIN_INTEGRATION_BUNDLES.find((entry) => entry.id === id)
  if (!bundle) {
    log('plugin', `Plugin not found: ${id}`)
    return false
  }

  const state = loadState()
  if (!state.installed.includes(id)) {
    state.installed.push(id)
    saveState(state)
    log('plugin', `Installed ${id}`)
  }
  return true
}

export function uninstallPlugin(id: string): boolean {
  const bundle = BUILTIN_INTEGRATION_BUNDLES.find((entry) => entry.id === id)
  if (!bundle) return false

  const state = loadState()
  state.installed = state.installed.filter((entry) => entry !== id)
  saveState(state)
  log('plugin', `Uninstalled ${id}`)
  return true
}

export function getPluginToolACLs(): { allowed: string[]; denied: string[] } {
  const state = loadState()
  const allowed: string[] = []
  const denied: string[] = []

  for (const bundle of BUILTIN_INTEGRATION_BUNDLES) {
    if (isInstalled(bundle.id, state)) {
      allowed.push(...bundle.allowedTools)
      denied.push(...bundle.deniedTools)
    }
  }

  return { allowed, denied }
}

export function getEnabledBuiltInMcps(): BundleMcp[] {
  const state = loadState()
  return BUILTIN_INTEGRATION_BUNDLES
    .filter((bundle) => isInstalled(bundle.id, state))
    .flatMap((bundle) => bundle.mcps)
}

export function getEnabledBundleSkillNames(): string[] {
  const state = loadState()
  return Array.from(new Set(
    BUILTIN_INTEGRATION_BUNDLES
      .filter((bundle) => isInstalled(bundle.id, state))
      .flatMap((bundle) => bundle.skills.map((skill) => skill.sourceName)),
  ))
}
