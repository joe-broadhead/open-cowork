import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from './config-loader.ts'
import { log } from './logger.ts'
import { getConfiguredIntegrationBundles, type BundleMcp } from './integration-bundles.ts'
import { getIntegrationCredentialValue, loadSettings } from './settings.ts'

type Plugin = {
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

interface PluginState {
  installed: string[]
}

function getPluginStatePath() {
  mkdirSync(getAppDataDir(), { recursive: true })
  return join(getAppDataDir(), 'plugins.json')
}

function getAllBundles() {
  return getConfiguredIntegrationBundles()
}

function loadState(): PluginState {
  const path = getPluginStatePath()
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch (err: any) {
      log('error', `Plugin state: ${err?.message}`)
    }
  }

  return {
    installed: getAllBundles()
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

function bundleToPlugin(bundle: ReturnType<typeof getAllBundles>[number], installed: boolean): Plugin {
  const settings = loadSettings()
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
      secret: credential.secret === true,
      configured: credential.required === false || Boolean(getIntegrationCredentialValue(settings, bundle.id, credential.key)),
    })),
    allowedTools: bundle.allowedTools,
    deniedTools: bundle.deniedTools,
  }
}

export function getInstalledPlugins(): Plugin[] {
  const bundles = getAllBundles()
  const state = loadState()
  return bundles.map((bundle) => bundleToPlugin(bundle, isInstalled(bundle.id, state)))
}

export function getEnabledIntegrationBundles() {
  const bundles = getAllBundles()
  const state = loadState()
  return bundles.filter((bundle) => isInstalled(bundle.id, state))
}

export function installPlugin(id: string) {
  const bundle = getAllBundles().find((entry) => entry.id === id)
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

export function uninstallPlugin(id: string) {
  const bundle = getAllBundles().find((entry) => entry.id === id)
  if (!bundle) return false

  const state = loadState()
  state.installed = state.installed.filter((entry) => entry !== id)
  saveState(state)
  log('plugin', `Uninstalled ${id}`)
  return true
}

export function getEnabledBuiltInMcps(): BundleMcp[] {
  return getEnabledIntegrationBundles().flatMap((bundle) => bundle.mcps)
}

export function getEnabledBundleSkillNames() {
  return Array.from(new Set(
    getEnabledIntegrationBundles()
      .flatMap((bundle) => bundle.skills.map((skill) => skill.sourceName)),
  ))
}
