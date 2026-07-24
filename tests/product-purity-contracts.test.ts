import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_PRIMARY_FEATURE_KEYS,
  DESKTOP_SECONDARY_FEATURE_KEYS,
  isDesktopFeatureEnabled,
} from '../packages/shared/src/app-config.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('product purity: primary features default on; secondary default off', () => {
  for (const key of DESKTOP_PRIMARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), true)
  }
  for (const key of DESKTOP_SECONDARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), false)
  }
})

test('product purity: Settings notifications has no Coming soon teaser controls', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/sidebar/SettingsPanel.tsx'),
    'utf8',
  )
  assert.doesNotMatch(source, /settings\.notifications\.comingSoon/)
  assert.doesNotMatch(source, /settings\.notifications\.voiceReplies['"]/)
  assert.doesNotMatch(source, /settings\.notifications\.dailyDigest['"]/)
  assert.doesNotMatch(source, /statusLabel=\{t\('settings\.notifications\.comingSoon'/)
})

test('product purity: Approvals queue does not wire Always-allow no-op', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/studio/StudioUtilityPages.tsx'),
    'utf8',
  )
  assert.doesNotMatch(source, /alwaysAllowUnavailable/)
  assert.doesNotMatch(source, /onAlwaysAllow=\{/)
})

test('product purity: Tools page does not teaser Relationships as coming soon', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/capabilities/CapabilitiesPage.tsx'),
    'utf8',
  )
  assert.doesNotMatch(source, /coming soon/i)
  assert.doesNotMatch(source, /relationshipsDisabled/)
})

test('product purity: public default config does not enable secondary Studio flags', () => {
  const config = JSON.parse(readFileSync(join(root, 'open-cowork.config.json'), 'utf8')) as {
    features?: Record<string, boolean>
    mcps?: Array<{ name?: string }>
  }
  if (config.features) {
    for (const key of DESKTOP_SECONDARY_FEATURE_KEYS) {
      assert.notEqual(config.features[key], true, `features.${key} must not default true`)
    }
  }
  const mcpNames = (config.mcps || []).map((entry) => entry.name || '')
  assert.ok(!mcpNames.some((name) => /wiki|openwiki|cowork-wiki/i.test(name)), 'default config must not register Wiki MCP')
  assert.ok(!mcpNames.some((name) => name === 'gateway' || name === 'cowork-gateway'), 'default config must not register durable Gateway MCP')
})

test('product purity: register and progressive disclosure docs exist', () => {
  for (const rel of [
    'docs/product-purity-register.md',
    'docs/progressive-disclosure.md',
    'docs/product-purity-checklist.md',
    'docs/pairing-connector-scope.md',
    'docs/runbooks/product-purity-dogfood.md',
  ]) {
    const text = readFileSync(join(root, rel), 'utf8')
    assert.ok(text.length > 100, `${rel} should be non-empty`)
  }
})

test('product purity: sidebar labels Health Center not Diagnostics', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/layout/Sidebar.tsx'),
    'utf8',
  )
  assert.match(source, /sidebar\.healthCenter/)
  assert.doesNotMatch(source, /sidebar\.diagnostics/)
  assert.doesNotMatch(source, /'Diagnostics'/)
})

test('product purity: release checklist includes purity claim gate', () => {
  const source = readFileSync(join(root, 'docs/release-checklist.md'), 'utf8')
  assert.match(source, /Product purity claim gate/)
  assert.match(source, /product-purity-register/)
})

test('product purity: enterprise matrix and maintainer map exist', () => {
  for (const rel of [
    'docs/enterprise-readiness-matrix.md',
    'docs/maintainer-product-map.md',
    'docs/runbooks/cloud-sync-dogfood.md',
  ]) {
    const text = readFileSync(join(root, rel), 'utf8')
    assert.ok(text.length > 100, `${rel} should be non-empty`)
  }
})

test('product purity: Home hides empty launchpad motion section', () => {
  const source = readFileSync(join(root, 'packages/app/src/components/HomePage.tsx'), 'utf8')
  assert.match(source, /never reserve Home space for an empty motion grid/)
  assert.match(source, /if \(!smartSuggestions\)/)
})
