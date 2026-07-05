import { installCapabilityBundle } from '@open-cowork/runtime-host/capability-bundle-store'
import { preflightConfiguredCapabilityBundlesForRuntime } from '@open-cowork/runtime-host/capability-bundle-runtime-preflight'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CAPABILITY_BUNDLE_FORMAT } from '../packages/shared/src/capabilities.ts'
import {
  clearConfigCaches,
  getConfiguredCapabilityBundlesFromConfig,
} from '../apps/desktop/src/main/config-loader.ts'
function withConfigOverride(config: Record<string, unknown>, run: (rootDir: string) => void) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-capability-bundle-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  writeFileSync(configPath, JSON.stringify(config))
  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  process.env.OPEN_COWORK_USER_DATA_DIR = join(tempRoot, 'user-data')
  clearConfigCaches()

  try {
    run(tempRoot)
  } finally {
    if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
    else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('configured capability bundles pass runtime preflight before desktop startup', () => {
  withConfigOverride({
    capabilityBundles: [{
      format: CAPABILITY_BUNDLE_FORMAT,
      name: 'review-pack',
      version: '1.0.0',
      owner: 'open-cowork',
      compatibility: {
        productModes: {
          'desktop-local': 'supported',
        },
      },
      resources: [
        { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      ],
      permissions: [],
    }],
  }, () => {
    assert.equal(getConfiguredCapabilityBundlesFromConfig().length, 1)
    const report = preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'desktop-local' })
    assert.equal(report.runtimeStartAllowed, true)
    assert.deepEqual(report.blockers, [])
  })
})

test('configured capability bundle preflight fails closed for invalid plugin policy', () => {
  withConfigOverride({
    capabilityBundles: [{
      format: CAPABILITY_BUNDLE_FORMAT,
      name: 'plugin-pack',
      version: '1.0.0',
      owner: 'open-cowork',
      compatibility: {
        productModes: {
          'desktop-local': 'supported',
        },
      },
      resources: [
        { kind: 'opencode-plugin', id: 'plugin.without-tier' },
      ],
      permissions: [],
    }],
  }, () => {
    assert.throws(
      () => preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'desktop-local' }),
      /capability_bundle_plugin_compatibility_required/,
    )
  })
})

test('configured capability bundle preflight blocks unsupported desktop product modes before runtime start', () => {
  withConfigOverride({
    capabilityBundles: [{
      format: CAPABILITY_BUNDLE_FORMAT,
      name: 'cloud-only-pack',
      version: '1.0.0',
      owner: 'open-cowork',
      compatibility: {
        productModes: {
          'desktop-local': 'unsupported',
          'cloud-web': 'supported',
        },
      },
      resources: [
        { kind: 'skill', id: 'cloud-only-skill', ownedByBundle: true },
      ],
      permissions: [],
    }],
  }, () => {
    assert.throws(
      () => preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'desktop-local' }),
      /product_mode_unsupported/,
    )
  })
})

test('installed capability bundle registry is included in runtime preflight', () => {
  withConfigOverride({ capabilityBundles: [] }, () => {
    const installResult = installCapabilityBundle({
      format: CAPABILITY_BUNDLE_FORMAT,
      name: 'installed-local-pack',
      version: '1.0.0',
      owner: 'open-cowork',
      compatibility: {
        productModes: {
          'desktop-local': 'supported',
          'cloud-web': 'unsupported',
        },
      },
      resources: [
        { kind: 'skill', id: 'installed-skill', ownedByBundle: true },
      ],
      permissions: [],
    }, {
      productMode: 'desktop-local',
      now: '2026-06-03T10:00:00.000Z',
    })

    assert.equal(installResult.applied, true)
    const localReport = preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'desktop-local' })
    assert.equal(localReport.bundles.some((bundle) => bundle.bundleName === 'installed-local-pack'), true)
    assert.throws(
      () => preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'cloud-web' }),
      /product_mode_unsupported/,
    )
  })
})
