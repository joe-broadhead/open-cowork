import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_PRIMARY_FEATURE_KEYS,
  DESKTOP_SECONDARY_FEATURE_KEYS,
  desktopFeatureEnablementWarnings,
  isDesktopFeatureEnabled,
} from '../packages/shared/src/app-config.ts'
import {
  PRODUCT_CAPABILITY_MANIFEST,
  productFeatureForRoute,
} from '../packages/shared/src/product-capability-manifest.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function repositorySourceFiles() {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (['node_modules', 'release', 'coverage', '.venv'].includes(entry.name) || entry.name.startsWith('dist'))) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(path)
    }
  }
  for (const scope of ['apps', 'mcps', 'packages', 'products', 'scripts', 'tests']) visit(join(root, scope))
  return files
}

function markdownDocs(relativeDirectory = 'docs'): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name).replaceAll('\\', '/')
    if (entry.isDirectory()) return markdownDocs(relativePath)
    return entry.isFile() && entry.name.endsWith('.md') ? [relativePath] : []
  })
}

function publicDocResidueReason(relativePath: string, source: string): string | null {
  const filename = relativePath.split('/').at(-1)?.replace(/\.md$/i, '') || ''
  const transientFilenamePatterns: Array<[RegExp, string]> = [
    [/(?:^|-)epic-close-?out(?:-|$)/i, 'epic closeout filename'],
    [/(?:^|-)(?:full-|surface-|pr-)?audit-(?:dump|findings?|register|report)(?:-|$)/i, 'audit artifact filename'],
    [/(?:^|-)residuals?-(?:register|risks?)(?:-|$)/i, 'residual register filename'],
    [/(?:^|-)product-purity-(?:register|checklist|final-wave)(?:-|$)/i, 'product-purity checklist filename'],
    [/(?:^|-)final-wave(?:-|$)/i, 'final-wave filename'],
    [/(?:^|-)evidence-(?:joe-\d+|\d{4}-\d{2}-\d{2})(?:-|$)/i, 'dated or issue-bound evidence filename'],
  ]
  for (const [pattern, reason] of transientFilenamePatterns) {
    if (pattern.test(filename)) return reason
  }

  const firstHeading = source.match(/^#\s+(.+)$/m)?.[1] || ''
  if (/\b(?:full|surface|pr) audit\b|\baudit (?:dump|findings?|register)\b/i.test(firstHeading)) {
    return 'audit artifact title'
  }

  const status = source.match(/^\*\*Status:\*\*\s*(.+)$/im)?.[1] || ''
  if (/\bepic\b/i.test(status) && /\b(?:closed|completed)\b/i.test(status)) {
    return 'closed epic status'
  }
  if (/^##\s+Exit criteria for [^\n]*\bepic\b/im.test(source)) {
    return 'epic exit-criteria checklist'
  }
  if (/^##\s+Residual register\s*\([^\n)]*\bpost[- ]epic\b/im.test(source)) {
    return 'post-epic residual register'
  }
  return null
}

function mkdocsNavEntries(source: string): Map<string, string> {
  const nav = source.match(/^nav:\s*$([\s\S]*?)^(?:extra|not_in_nav):/m)?.[1] || ''
  return new Map(
    [...nav.matchAll(/^\s*-\s+(?:"([^"]+)"|([^:\n]+)):\s+([^\s#]+\.md)\s*$/gm)]
      .map((match) => [`docs/${match[3]}`, (match[1] || match[2]).trim()]),
  )
}

test('product purity: primary features default on; secondary default off', () => {
  for (const key of DESKTOP_PRIMARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), true)
  }
  for (const key of DESKTOP_SECONDARY_FEATURE_KEYS) {
    assert.equal(isDesktopFeatureEnabled(undefined, key), false)
  }
})

test('product purity: versioned manifest owns hero routes and configured catalog counts', () => {
  assert.equal(PRODUCT_CAPABILITY_MANIFEST.version, 1)
  assert.deepEqual(PRODUCT_CAPABILITY_MANIFEST.heroPath, [
    'home',
    'chat',
    'projects',
    'team',
    'playbooks',
    'tools',
    'settings',
  ])
  assert.equal(productFeatureForRoute('home'), null)
  assert.equal(productFeatureForRoute('chat'), null)
  assert.equal(productFeatureForRoute('projects'), 'projects')
  assert.equal(productFeatureForRoute('knowledge'), 'knowledge')
  assert.equal(productFeatureForRoute('health'), null)

  const config = JSON.parse(readFileSync(join(root, 'open-cowork.config.json'), 'utf8')) as {
    tools?: unknown[]
    skills?: unknown[]
    mcps?: unknown[]
  }
  assert.deepEqual(PRODUCT_CAPABILITY_MANIFEST.configuredCatalog, {
    tools: config.tools?.length || 0,
    skills: config.skills?.length || 0,
    mcpServers: config.mcps?.length || 0,
  })
  assert.deepEqual(PRODUCT_CAPABILITY_MANIFEST.projects.provides, [
    'objectives',
    'Kanban tasks',
    'linked work chats',
  ])
})

test('product purity: every manifest route renders and every hero surface has an entry point', () => {
  const appRoutes = readFileSync(
    join(root, 'packages/app/src/components/layout/AppRoutes.tsx'),
    'utf8',
  )
  const sidebar = readFileSync(
    join(root, 'packages/app/src/components/layout/Sidebar.tsx'),
    'utf8',
  )
  const renderedRoutes = new Set(
    [...appRoutes.matchAll(/\bview\s*===\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  )
  const sidebarRoutes = new Set(
    [...sidebar.matchAll(/(?:\bview\s*:\s*|\bonViewChange\(\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1]),
  )

  for (const surface of PRODUCT_CAPABILITY_MANIFEST.surfaces) {
    if (surface.route) {
      assert.ok(renderedRoutes.has(surface.route), `${surface.id} must render route ${surface.route}`)
    }
  }
  for (const id of PRODUCT_CAPABILITY_MANIFEST.heroPath) {
    const surface = PRODUCT_CAPABILITY_MANIFEST.surfaces.find((entry) => entry.id === id)
    assert.ok(surface, `${id} must resolve to a manifest surface`)
    if (surface.route) {
      assert.ok(sidebarRoutes.has(surface.route), `${id} must have a sidebar or work-entry action`)
    } else {
      assert.match(sidebar, new RegExp(`sidebar\\.${surface.id}['"]\\s*,\\s*['"]${surface.label}`))
    }
  }
})

test('product claims: docs build fails fast through the manifest claim gate', () => {
  const docsBuild = readFileSync(join(root, 'scripts/docs-build.mjs'), 'utf8')
  assert.match(docsBuild, /--experimental-strip-types['"],\s*['"]scripts\/check-product-capability-claims\.mjs/)
  assert.match(docsBuild, /checkProductCapabilityClaims\(\)\s*\nensureVenv\(\)/)
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

test('product purity: public tool presentation uses the product glossary while stable IDs remain compatible', () => {
  const config = JSON.parse(readFileSync(join(root, 'open-cowork.config.json'), 'utf8')) as {
    tools?: Array<{ id?: string; name?: string; description?: string; namespace?: string }>
    mcps?: Array<{ name?: string; description?: string }>
  }
  const byId = new Map((config.tools || []).map((tool) => [tool.id, tool]))

  assert.equal(byId.get('agents')?.namespace, 'agents')
  assert.equal(byId.get('agents')?.name, 'Team')
  assert.match(byId.get('agents')?.description || '', /coworkers/i)
  assert.doesNotMatch(byId.get('agents')?.description || '', /\bagents?\b/i)
  assert.equal(byId.get('workflows')?.namespace, 'workflows')
  assert.equal(byId.get('workflows')?.name, 'Playbooks')
  assert.match(byId.get('workflows')?.description || '', /playbooks/i)
  assert.doesNotMatch(byId.get('workflows')?.description || '', /Open Cowork workflows/i)
  assert.doesNotMatch(byId.get('knowledge')?.description || '', /\bwiki\b/i)
  assert.doesNotMatch(
    (config.mcps || []).map((mcp) => mcp.description || '').join('\n'),
    /\bwiki\b/i,
    'MCP catalog descriptions must distinguish product Knowledge from the separate Wiki product',
  )
})

test('product purity: removed Settings fields and the Voice accelerator stay single-sourced', () => {
  const sources = repositorySourceFiles()
  const references = (pattern: RegExp) => Array.from(new Set(sources
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path))))
    .sort()

  assert.deepEqual(
    references(/requireApprovalBeforeSending|privacyKeepConversationHistory/),
    ['tests/product-purity-contracts.test.ts', 'tests/settings.test.ts'],
    'retired Settings keys may exist only in the explicit migration regression',
  )
  assert.deepEqual(
    references(/CmdOrCtrl\+Shift\+Space/),
    ['packages/shared/src/shortcuts.ts'],
    'the default Voice accelerator must be imported from the shared shortcut contract',
  )
})

test('product claims: durable guidance exists', () => {
  for (const rel of [
    'docs/product-contract.md',
    'docs/progressive-disclosure.md',
    'docs/pairing-connector-scope.md',
    'docs/release-checklist.md',
  ]) {
    const text = readFileSync(join(root, rel), 'utf8')
    assert.ok(text.length > 100, `${rel} should be non-empty`)
  }
})

test('product claims: closeout-residue classifier preserves durable release and runbook docs', () => {
  assert.equal(
    publicDocResidueReason(
      'docs/future-protocol.md',
      '# Future protocol\n\n**Status:** Capacity epic **closed** — all phases shipped.',
    ),
    'closed epic status',
  )
  assert.equal(
    publicDocResidueReason('docs/platform-audit-findings.md', '# Platform audit findings'),
    'audit artifact filename',
  )
  assert.equal(
    publicDocResidueReason('docs/provider-residual-register.md', '# Provider follow-ups'),
    'residual register filename',
  )

  for (const rel of [
    'docs/release-checklist.md',
    'docs/packaging-and-releases.md',
    'docs/runbooks/launch-readiness-report.md',
    'docs/runbooks/restore-drill-report.md',
    'docs/adr/private-realtime-voice.md',
  ]) {
    assert.equal(
      publicDocResidueReason(rel, readFileSync(join(root, rel), 'utf8')),
      null,
      `${rel} is durable release, runbook, or decision guidance`,
    )
  }
})

test('product claims: public and nav-listed docs contain no closeout residue', () => {
  const navEntries = mkdocsNavEntries(readFileSync(join(root, 'mkdocs.yml'), 'utf8'))
  const findings = markdownDocs().flatMap((rel) => {
    const reason = publicDocResidueReason(rel, readFileSync(join(root, rel), 'utf8'))
    return reason ? [`${rel}${navEntries.has(rel) ? ' (nav-listed)' : ''}: ${reason}`] : []
  })
  for (const [rel, label] of navEntries) {
    if (/\b(?:epic close-?out|audit (?:dump|findings?|register)|residual (?:risks?|register)|final wave)\b/i.test(label)) {
      findings.push(`${rel} (nav label): ${label}`)
    }
  }

  assert.deepEqual(
    findings,
    [],
    'migrate durable guidance to an ADR, ownership document, release guide, or runbook; do not publish epic closeout artifacts',
  )
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

test('product claims: release checklist uses durable claim sources', () => {
  const source = readFileSync(join(root, 'docs/release-checklist.md'), 'utf8')
  assert.match(source, /Product claim gate/)
  assert.match(source, /product contract/)
  assert.match(source, /capability manifest/)
  assert.doesNotMatch(source, /product-purity-register|pure-release-notes-claim-freeze/)
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
  assert.match(source, /const MAX_RECENT_SESSIONS = 4/)
  assert.match(source, /<HomeComposer/)
  assert.match(source, /<HomeRecentWork/)
  assert.doesNotMatch(source, /LaunchpadMotionGrid|HomeReviewSnapshot/)
})

test('product claims: readiness and deferred boundaries stay in durable docs', () => {
  const matrix = readFileSync(join(root, 'docs/enterprise-readiness-matrix.md'), 'utf8')
  assert.match(matrix, /Owner/)
  assert.match(matrix, /Next evidence artifact/)
  assert.match(matrix, /Fail-closed claim wording/)
  assert.match(matrix, /partial/)
  assert.match(matrix, /Cloud continuity smoke/)

  const standalone = readFileSync(join(root, 'docs/adr/standalone-desktop-session-api.md'), 'utf8')
  assert.match(standalone, /deferred/i)
  assert.match(standalone, /connection/i)

  const releaseChecklist = readFileSync(join(root, 'docs/release-checklist.md'), 'utf8')
  assert.match(releaseChecklist, /enterprise-readiness-matrix/)
  assert.match(releaseChecklist, /cloud-sync-dogfood/)
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
    voice: true,
  })
  assert.equal(warnings.length, 5)
  assert.ok(warnings.some((w) => /channels/i.test(w) && /Cloud/i.test(w)))
  assert.ok(warnings.some((w) => /approvals/i.test(w) && /Always-allow/i.test(w)))
  assert.ok(warnings.some((w) => /knowledge/i.test(w) && /Wiki/i.test(w)))
  assert.ok(warnings.some((w) => /artifacts/i.test(w) && /redaction/i.test(w)))
  assert.ok(warnings.some((w) => /voice/i.test(w) && /Desktop Local/i.test(w)))
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
