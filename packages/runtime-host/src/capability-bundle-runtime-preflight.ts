import {
  CAPABILITY_BUNDLE_FORMAT,
  type CapabilityBundleIssue,
  type CapabilityBundleManifest,
  type CapabilityBundleProductMode,
  type CapabilityBundleRuntimeSupportReport,
} from '@open-cowork/shared'
import {
  normalizeCapabilityBundleManifest,
  validateCapabilityBundleRuntimeSupport,
} from './capability-bundle-engine.js'
import { getInstalledCapabilityBundleManifests } from './capability-bundle-store.js'
import { getConfiguredCapabilityBundlesFromConfig } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'

export class CapabilityBundleRuntimePreflightError extends Error {
  report: CapabilityBundleRuntimeSupportReport

  constructor(report: CapabilityBundleRuntimeSupportReport) {
    const summary = report.blockers
      .slice(0, 6)
      .map((blocker) => `${blocker.code}${blocker.resourceId ? `:${blocker.resourceId}` : ''}`)
      .join(', ')
    super(`Capability bundle runtime preflight failed for ${report.productMode}: ${summary}`)
    this.name = 'CapabilityBundleRuntimePreflightError'
    this.report = report
  }
}

function createEmptyRuntimeSupportReport(
  productMode: CapabilityBundleProductMode,
  blockers: CapabilityBundleIssue[] = [],
): CapabilityBundleRuntimeSupportReport {
  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    productMode,
    runtimeStartAllowed: blockers.length === 0,
    blockers,
    warnings: [],
    bundles: [],
  }
}

function normalizeConfiguredCapabilityBundles(rawManifests: unknown[]) {
  const manifests: CapabilityBundleManifest[] = []
  const blockers: CapabilityBundleIssue[] = []

  for (const [index, rawManifest] of rawManifests.entries()) {
    const result = normalizeCapabilityBundleManifest(rawManifest)
    if (result.ok) {
      manifests.push(result.manifest)
      continue
    }
    for (const issue of result.issues) {
      blockers.push({
        ...issue,
        code: `capability_bundle_${issue.code}`,
        resourceId: issue.resourceId || `bundle[${index}]`,
      })
    }
  }

  return { manifests, blockers }
}

export function preflightConfiguredCapabilityBundlesForRuntime(options: {
  productMode?: CapabilityBundleProductMode
  manifests?: unknown[]
} = {}) {
  const productMode = options.productMode || 'desktop-local'
  const rawManifests = options.manifests || [
    ...getConfiguredCapabilityBundlesFromConfig(),
    ...getInstalledCapabilityBundleManifests(),
  ]
  if (rawManifests.length === 0) return createEmptyRuntimeSupportReport(productMode)

  const normalized = normalizeConfiguredCapabilityBundles(rawManifests)
  const report = validateCapabilityBundleRuntimeSupport(normalized.manifests, { productMode })
  if (normalized.blockers.length > 0) {
    report.blockers.unshift(...normalized.blockers)
    report.runtimeStartAllowed = false
  }

  if (!report.runtimeStartAllowed) {
    throw new CapabilityBundleRuntimePreflightError(report)
  }

  if (report.warnings.length > 0) {
    log('runtime', `Capability bundle runtime preflight passed with warnings: ${report.warnings.map((warning) => warning.code).join(', ')}`)
  }

  return report
}
