import { readJsoncFile, writeJsonFile } from '@open-cowork/runtime-host'
import { join } from 'node:path'
import {
  type CapabilityBundleInstallPlan,
  type CapabilityBundleLifecycleApplyResult,
  type CapabilityBundleLifecycleState,
  type CapabilityBundleManifest,
  type CapabilityBundleProductMode,
  type CapabilityBundleUninstallPlan,
  type CapabilityBundleUpdatePlan,
} from '@open-cowork/shared'
import {
  applyCapabilityBundleInstall,
  applyCapabilityBundleUninstall,
  applyCapabilityBundleUpdate,
  createEmptyCapabilityBundleLifecycleState,
} from './capability-bundle-engine.js'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'

const CAPABILITY_BUNDLE_STORE_SCHEMA_VERSION = 1
const CAPABILITY_BUNDLE_STORE_FILENAME = 'capability-bundles.open-cowork.json'

type CapabilityBundleStoreFile = {
  schemaVersion: typeof CAPABILITY_BUNDLE_STORE_SCHEMA_VERSION
  state: CapabilityBundleLifecycleState
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function assertLifecycleState(value: unknown): CapabilityBundleLifecycleState {
  const record = asRecord(value)
  if (!Array.isArray(record.bundles) || !Array.isArray(record.resources)) {
    throw new Error('capability_bundle_store_invalid: expected lifecycle bundles and resources arrays')
  }
  return {
    bundles: record.bundles as CapabilityBundleLifecycleState['bundles'],
    resources: record.resources as CapabilityBundleLifecycleState['resources'],
  }
}

export function capabilityBundleStorePath(rootDir = getAppDataDir()) {
  return join(rootDir, CAPABILITY_BUNDLE_STORE_FILENAME)
}

export function readCapabilityBundleStoreState(rootDir = getAppDataDir()): CapabilityBundleLifecycleState {
  const raw = readJsoncFile<Record<string, unknown>>(capabilityBundleStorePath(rootDir))
  if (Object.keys(raw).length === 0) return createEmptyCapabilityBundleLifecycleState()
  if (raw.schemaVersion !== CAPABILITY_BUNDLE_STORE_SCHEMA_VERSION) {
    throw new Error('capability_bundle_store_invalid: unsupported schema version')
  }
  return assertLifecycleState(raw.state)
}

export function writeCapabilityBundleStoreState(
  state: CapabilityBundleLifecycleState,
  rootDir = getAppDataDir(),
) {
  const payload: CapabilityBundleStoreFile = {
    schemaVersion: CAPABILITY_BUNDLE_STORE_SCHEMA_VERSION,
    state,
  }
  writeJsonFile(capabilityBundleStorePath(rootDir), payload)
}

function persistIfApplied<Plan>(
  result: CapabilityBundleLifecycleApplyResult<Plan>,
  rootDir: string,
  action: string,
) {
  for (const event of result.audit) {
    log('audit', `capability_bundle.${event.action} ${event.outcome} bundle=${event.bundleName} kind=${event.kind} id=${event.id} reason=${event.reason}`)
  }
  if (result.applied) {
    writeCapabilityBundleStoreState(result.state, rootDir)
    log('runtime', `Capability bundle ${action} applied.`)
  }
  return result
}

export function listInstalledCapabilityBundles(rootDir = getAppDataDir()) {
  return readCapabilityBundleStoreState(rootDir).bundles
}

export function getInstalledCapabilityBundleManifests(rootDir = getAppDataDir()) {
  return listInstalledCapabilityBundles(rootDir).map((bundle) => bundle.manifest)
}

export function previewCapabilityBundleInstall(
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    rootDir?: string
    now?: string
  },
): CapabilityBundleLifecycleApplyResult<CapabilityBundleInstallPlan> {
  const rootDir = options.rootDir || getAppDataDir()
  return applyCapabilityBundleInstall(readCapabilityBundleStoreState(rootDir), manifest, options)
}

export function installCapabilityBundle(
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    rootDir?: string
    now?: string
  },
) {
  const rootDir = options.rootDir || getAppDataDir()
  return persistIfApplied(
    applyCapabilityBundleInstall(readCapabilityBundleStoreState(rootDir), manifest, options),
    rootDir,
    'install',
  )
}

export function previewCapabilityBundleUpdate(
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    rootDir?: string
    now?: string
  },
): CapabilityBundleLifecycleApplyResult<CapabilityBundleUpdatePlan> {
  const rootDir = options.rootDir || getAppDataDir()
  return applyCapabilityBundleUpdate(readCapabilityBundleStoreState(rootDir), manifest, options)
}

export function updateCapabilityBundle(
  manifest: CapabilityBundleManifest,
  options: {
    productMode: CapabilityBundleProductMode
    rootDir?: string
    now?: string
  },
) {
  const rootDir = options.rootDir || getAppDataDir()
  return persistIfApplied(
    applyCapabilityBundleUpdate(readCapabilityBundleStoreState(rootDir), manifest, options),
    rootDir,
    'update',
  )
}

export function previewCapabilityBundleUninstall(
  bundleName: string,
  options: {
    rootDir?: string
  } = {},
): CapabilityBundleLifecycleApplyResult<CapabilityBundleUninstallPlan> {
  const rootDir = options.rootDir || getAppDataDir()
  return applyCapabilityBundleUninstall(readCapabilityBundleStoreState(rootDir), bundleName)
}

export function uninstallCapabilityBundle(
  bundleName: string,
  options: {
    rootDir?: string
  } = {},
) {
  const rootDir = options.rootDir || getAppDataDir()
  return persistIfApplied(
    applyCapabilityBundleUninstall(readCapabilityBundleStoreState(rootDir), bundleName),
    rootDir,
    'uninstall',
  )
}
