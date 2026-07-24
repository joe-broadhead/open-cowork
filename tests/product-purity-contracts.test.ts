import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_PRIMARY_FEATURE_KEYS,
  DESKTOP_SECONDARY_FEATURE_KEYS,
  desktopFeatureEnablementWarnings,
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

test('product purity: final-wave docs and residual register exist', () => {
  for (const rel of [
    'docs/product-purity-final-wave.md',
    'docs/product-purity-residual-risks.md',
    'docs/adr/standalone-desktop-session-api.md',
  ]) {
    const text = readFileSync(join(root, rel), 'utf8')
    assert.ok(text.length > 100, `${rel} should be non-empty`)
  }
  const residual = readFileSync(join(root, 'docs/product-purity-residual-risks.md'), 'utf8')
  assert.match(residual, /P0 residuals:\*\* none/)
  assert.match(residual, /R-1042/)
})

test('product purity: Knowledge UI exports Knowledge* aliases (JOE-1034)', () => {
  const source = readFileSync(join(root, 'packages/ui/src/index.ts'), 'utf8')
  assert.match(source, /WikiPage as KnowledgePage/)
  assert.match(source, /WikiSpaceRail as KnowledgeSpaceRail/)
  assert.match(source, /WikiProposeEditDialog as KnowledgeProposeEditDialog/)
  const knowledgePage = readFileSync(
    join(root, 'packages/app/src/components/studio/KnowledgePage.tsx'),
    'utf8',
  )
  assert.match(knowledgePage, /KnowledgeDocumentPage|KnowledgeSpaceRail|KnowledgeProposeEditDialog/)
  assert.doesNotMatch(knowledgePage, /<WikiPage[\s>]/)
  assert.doesNotMatch(knowledgePage, /<WikiSpaceRail[\s>]/)
  assert.doesNotMatch(knowledgePage, /<WikiProposeEditDialog[\s>]/)
})

test('product purity: Projects board uses coordination.projects support key', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/projects/ProjectsBoardPage.tsx'),
    'utf8',
  )
  assert.match(source, /'coordination\.projects'/)
  assert.match(source, /RestrictedState/)
  assert.match(source, /disabledReason/)
  assert.doesNotMatch(source, /'coordination\.board'/)
})

test('product purity: Chat density defaults keep inspector closed and filters gated', () => {
  const chatView = readFileSync(join(root, 'packages/app/src/components/chat/ChatView.tsx'), 'utf8')
  assert.match(chatView, /useState\(false\)/)
  assert.match(chatView, /isAgentRunFiltersEnabled/)
  const filters = readFileSync(
    join(root, 'packages/app/src/components/chat/agent-run-filter-model.ts'),
    'utf8',
  )
  assert.match(filters, /getItem\(AGENT_RUN_FILTERS_FEATURE_GATE_KEY\) === 'true'/)
})

test('product purity: Cloud Web / local thread menus hide unavailable session ops', () => {
  const threadList = readFileSync(
    join(root, 'packages/app/src/components/sidebar/ThreadList.tsx'),
    'utf8',
  )
  assert.match(threadList, /if \(!activeWorkspaceIsLocal\)/)
  assert.match(threadList, /onContextMenu=\{activeWorkspaceIsLocal/)
})

test('product purity: composer surfaces support matrix prompt reason', () => {
  const source = readFileSync(join(root, 'packages/app/src/components/chat/ChatInput.tsx'), 'utf8')
  assert.match(source, /sendBlockedReason/)
  assert.match(source, /sendDisabledReason=\{sendBlockedReason\}/)
  assert.match(source, /flags\.reasons\.prompt/)
})

test('product purity: feature enablement warnings for secondary flags (JOE-1063)', () => {
  assert.deepEqual(desktopFeatureEnablementWarnings(undefined), [])
  assert.deepEqual(desktopFeatureEnablementWarnings({}), [])
  const warnings = desktopFeatureEnablementWarnings({
    channels: true,
    approvals: true,
    knowledge: true,
    artifacts: true,
  })
  assert.equal(warnings.length, 4)
  assert.ok(warnings.some((w) => /channels/i.test(w) && /Cloud/i.test(w)))
  assert.ok(warnings.some((w) => /approvals/i.test(w) && /Always-allow/i.test(w)))
  assert.ok(warnings.some((w) => /knowledge/i.test(w) && /Wiki/i.test(w)))
  assert.ok(warnings.some((w) => /artifacts/i.test(w) && /redaction/i.test(w)))
})

test('product purity: Admin billing omitted when adapter off; audit export honest', () => {
  const billing = readFileSync(
    join(root, 'packages/app/src/components/admin/BillingSection.tsx'),
    'utf8',
  )
  assert.match(billing, /billingEnabled/)
  const audit = readFileSync(join(root, 'packages/app/src/components/admin/AuditSection.tsx'), 'utf8')
  assert.match(audit, /exportUnavailable/)
  const adminTest = readFileSync(
    join(root, 'packages/app/src/components/admin/AdminPage.test.tsx'),
    'utf8',
  )
  assert.match(adminTest, /omits the Billing section when the billing adapter is off/)
})

test('product purity: Product MCP link copy keeps Wiki as optional sibling', () => {
  const source = readFileSync(
    join(root, 'packages/app/src/components/capabilities/ProductMcpLinkPanel.tsx'),
    'utf8',
  )
  assert.match(source, /Optional installables/)
  assert.match(source, /not the in-app Knowledge store/)
  assert.match(source, /cowork-wiki/)
})

test('product purity: English catalog remains SoT empty table (JOE-1081)', () => {
  const en = readFileSync(join(root, 'packages/app/src/helpers/i18n-catalogs/en.ts'), 'utf8')
  assert.match(en, /source-of-truth language/)
  const coverage = readFileSync(
    join(root, 'packages/app/src/helpers/i18n-catalogs/coverage-status.ts'),
    'utf8',
  )
  assert.match(coverage, /BUILT_IN_TRANSLATION_COVERAGE/)
  assert.match(coverage, /translatedKeys/)
})
