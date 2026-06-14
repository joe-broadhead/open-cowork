import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLOUD_WEB_ROUTES } from './app-shell.ts'
import { cloudWebsiteHtml } from './render.ts'
import {
  OPENWIKI_DEFERRAL_CONTRACT,
  STUDIO_PRODUCTION_AUDIT_CHECKLIST,
  STUDIO_VISUAL_QA_MATRIX,
  type StudioProductionAuditEntry,
  type StudioQaState,
  type StudioVisualQaEntry,
} from './studio-production-qa.ts'

const workbenchDocPath = new URL('../../../docs/cloud-web-workbench.md', import.meta.url)
const releaseChecklistPath = new URL('../../../docs/release-checklist.md', import.meta.url)
const repoRoot = new URL('../../../', import.meta.url)

function markdownTableCell(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function studioVisualQaDocRow(entry: StudioVisualQaEntry) {
  const routes = entry.routeIds.map((routeId) => `\`${routeId}\``).join(', ')
  const states = entry.states.map((state) => `\`${state}\``).join(', ')
  return `| ${markdownTableCell(entry.label)} | ${routes} | ${markdownTableCell(entry.desktopSurface)} | ${markdownTableCell(entry.cloudCheck)} | ${states} | ${markdownTableCell(entry.boundary)} |`
}

function studioProductionAuditDocRow(entry: StudioProductionAuditEntry) {
  const evidence = entry.evidence.map((item) => `\`${item}\``).join(', ')
  return `| \`${entry.id}\` | ${markdownTableCell(entry.requirement)} | ${evidence} |`
}

function repoEvidenceExists(path: string) {
  return existsSync(fileURLToPath(new URL(path, repoRoot)))
}

test('studio production QA matrix covers every Cloud Web route, state class, and documented row', () => {
  const doc = readFileSync(fileURLToPath(workbenchDocPath), 'utf8')
  const routeIds = new Set(CLOUD_WEB_ROUTES.map((route) => route.id))
  const coveredRouteIds = new Set(STUDIO_VISUAL_QA_MATRIX.flatMap((entry) => entry.routeIds))
  const coveredStates = new Set(STUDIO_VISUAL_QA_MATRIX.flatMap((entry) => entry.states))
  const requiredStates: StudioQaState[] = [
    'loading',
    'empty',
    'error',
    'disabled',
    'permission-gated',
    'offline-disconnected',
    'retry',
    'destructive-confirmation',
    'one-time-reveal',
  ]

  assert.match(doc, /Studio Production Visual QA Matrix/)
  assert.match(doc, /Production Audit Checklist/)
  assert.equal(STUDIO_VISUAL_QA_MATRIX.length, 9)

  for (const routeId of routeIds) {
    assert.ok(coveredRouteIds.has(routeId), `${routeId} has a Studio visual QA entry`)
  }
  for (const routeId of coveredRouteIds) {
    assert.ok(routeIds.has(routeId), `${routeId} is an existing Cloud Web route`)
  }
  for (const state of requiredStates) {
    assert.ok(coveredStates.has(state), `${state} state is part of production visual QA`)
  }

  for (const entry of STUDIO_VISUAL_QA_MATRIX) {
    assert.deepEqual(entry.viewports, ['desktop', 'tablet', 'mobile'], `${entry.id} covers all release viewports`)
    assert.ok(entry.desktopSurface, `${entry.id} names the Desktop surface`)
    assert.ok(entry.cloudCheck, `${entry.id} names the Cloud Web check`)
    assert.ok(entry.boundary, `${entry.id} documents the product/runtime boundary`)
    assert.ok(entry.evidence.length > 0, `${entry.id} lists automated evidence`)
    assert.ok(doc.includes(studioVisualQaDocRow(entry)), `docs list exact Studio visual QA row for ${entry.id}`)
    for (const evidence of entry.evidence) {
      assert.ok(repoEvidenceExists(evidence), `${entry.id} evidence exists: ${evidence}`)
    }
  }
})

test('studio production audit checklist is documented and points at real evidence', () => {
  const doc = readFileSync(fileURLToPath(workbenchDocPath), 'utf8')
  const checklistIds = new Set(STUDIO_PRODUCTION_AUDIT_CHECKLIST.map((entry) => entry.id))
  const requiredIds = [
    'canonical-shared-tokens',
    'shared-primitives-first',
    'shared-product-vocabulary',
    'cloud-api-client-only',
    'admin-not-default-path',
    'safe-redaction',
    'honest-performance-budgets',
    'docs-match-shipped-behavior',
  ]

  assert.deepEqual([...checklistIds].sort(), requiredIds.sort())
  for (const entry of STUDIO_PRODUCTION_AUDIT_CHECKLIST) {
    assert.ok(doc.includes(studioProductionAuditDocRow(entry)), `docs list exact production audit row for ${entry.id}`)
    for (const evidence of entry.evidence) {
      assert.ok(repoEvidenceExists(evidence), `${entry.id} evidence exists: ${evidence}`)
    }
  }
})

test('OpenWiki Knowledge is explicitly deferred without route, CTA, or runtime coupling', () => {
  const doc = readFileSync(fileURLToPath(workbenchDocPath), 'utf8')
  const releaseChecklist = readFileSync(fileURLToPath(releaseChecklistPath), 'utf8')
  const html = cloudWebsiteHtml({
    role: 'web',
    profileName: 'default',
    features: {
      chat: true,
      workflows: true,
    },
  })

  assert.equal(OPENWIKI_DEFERRAL_CONTRACT.status, 'deferred')
  assert.deepEqual(OPENWIKI_DEFERRAL_CONTRACT.routeIds, [])
  assert.deepEqual(OPENWIKI_DEFERRAL_CONTRACT.visibleCtas, [])
  assert.deepEqual(OPENWIKI_DEFERRAL_CONTRACT.runtimeDependencies, [])
  assert.match(doc, /OpenWiki\/Knowledge Deferral/)
  assert.match(doc, /Knowledge\/OpenWiki is intentionally deferred/)
  assert.match(doc, /no Cloud Web route,\s+no visible CTA, no runtime dependency, and no data-sync claim/)
  assert.match(releaseChecklist, /OpenWiki\/Knowledge deferral/)
  assert.doesNotMatch(html, /OpenWiki|Knowledge/)
  assert.doesNotMatch(html, /data-route-panel="(?:knowledge|openwiki|wiki)"/i)
  for (const route of CLOUD_WEB_ROUTES) {
    assert.doesNotMatch(route.id, /knowledge|openwiki|wiki/i)
    assert.doesNotMatch(route.label, /Knowledge|OpenWiki|Wiki/)
  }
})
