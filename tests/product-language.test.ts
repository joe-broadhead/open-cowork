import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const productionCopyRoots = [
  'apps/desktop/src/renderer/components',
]

const productionDocs = [
  'README.md',
  'docs/desktop-app.md',
  'docs/workflows.md',
  'docs/workflow-recipes.md',
  'docs/index.md',
  'docs/glossary.md',
]

const i18nCatalogRoot = 'apps/desktop/src/renderer/helpers/i18n-catalogs'

const bannedProductionPhrases = [
  /Start MVP Run/i,
  /MVP run/i,
  /minimum crew shape/i,
  /Research Crew/i,
  /research crew demo/i,
  /enriching or supervising/i,
  /Work items appear after enrichment/i,
  /Heartbeat minutes/i,
  /heartbeat supervision/i,
  /heartbeat review/i,
  /dream runs/i,
]

function walkFiles(relativeDir: string): string[] {
  const absoluteDir = join(repoRoot, relativeDir)
  const entries = readdirSync(absoluteDir)
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry)
    const relativePath = join(relativeDir, entry)
    const stat = statSync(absolutePath)
    if (stat.isDirectory()) {
      files.push(...walkFiles(relativePath))
      continue
    }
    if (!/\.(ts|tsx|md)$/.test(entry)) continue
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue
    files.push(relativePath)
  }
  return files
}

test('production copy avoids demo-era and runtime-internal language', () => {
  const files = [
    ...productionCopyRoots.flatMap(walkFiles),
    ...productionDocs,
  ]

  const failures: string[] = []
  for (const relativePath of files) {
    const content = readFileSync(join(repoRoot, relativePath), 'utf8')
    for (const phrase of bannedProductionPhrases) {
      if (phrase.test(content)) failures.push(`${relativePath}: ${phrase}`)
    }
  }

  assert.deepEqual(failures, [])
})

test('desktop guide documents focused product language and density standards', () => {
  const guide = readFileSync(join(repoRoot, 'docs/desktop-app.md'), 'utf8')
  assert.match(guide, /Product Language And Density Standards/)
  assert.match(guide, /Chat/)
  assert.match(guide, /Coworker/)
  assert.match(guide, /Playbook/)
  assert.match(guide, /OpenCode-native agent configurations/)
  assert.match(guide, /workflow definition/)
  assert.match(guide, /Workflows MCP/)
  assert.match(guide, /setup chat/)
  assert.match(guide, /compact tables, split panes, saved filters,\s+and bulk-safe actions/)
  for (const status of ['active', 'running', 'failed', 'paused', 'archived']) {
    assert.match(guide, new RegExp(status))
  }
})

test('workflow renderer surface uses workflow filenames and route key', () => {
  const stalePaths = [
    'apps/desktop/src/renderer/components/automations',
    'apps/desktop/tests/automations-page.smoke.test.ts',
  ].filter((relativePath) => existsSync(join(repoRoot, relativePath)))

  const workflowFiles = walkFiles('apps/desktop/src/renderer/components/workflows')
  const staleWorkflowNames = workflowFiles.filter((relativePath) => /^(Automation|Automations|automation)/.test(basename(relativePath)))
  const appTypes = readFileSync(join(repoRoot, 'apps/desktop/src/renderer/app-types.ts'), 'utf8')

  assert.deepEqual(stalePaths, [])
  assert.deepEqual(staleWorkflowNames, [])
  assert.match(appTypes, /'workflows'/)
  assert.doesNotMatch(appTypes, /'automations'/)
})

test('chat delegated-run surface uses agent-run vocabulary instead of mission-control vocabulary', () => {
  const chatFiles = walkFiles('apps/desktop/src/renderer/components/chat')
  const staleChatNames = chatFiles.filter((relativePath) => /MissionControl|mission-control/.test(relativePath))
  const checkedContentFiles = [
    ...chatFiles,
    ...walkFiles(i18nCatalogRoot),
    'docs/roadmap.md',
  ]
  const staleChatContent = checkedContentFiles.flatMap((relativePath) => {
    const content = readFileSync(join(repoRoot, relativePath), 'utf8')
    return /MissionControl|mission-control|missionControl/.test(content) ? [relativePath] : []
  })

  assert.deepEqual(staleChatNames, [])
  assert.deepEqual(staleChatContent, [])
})

test('localized Home copy avoids runtime-health terminology', () => {
  const runtimeTerms = [
    /runtime/i,
    /ランタイム/,
    /रनटाइम/,
    /运行时/,
    /런타임/,
  ]
  const localizedKeys = ['homepage.title', 'homepage.subtitle']
  const failures: string[] = []
  let copyCount = 0

  for (const relativePath of walkFiles(i18nCatalogRoot)) {
    const content = readFileSync(join(repoRoot, relativePath), 'utf8')
    for (const key of localizedKeys) {
      const escapedKey = key.replace('.', '\\.')
      const match = content.match(new RegExp(`'${escapedKey}':\\s*'([^']*)'`))
      if (!match) continue
      copyCount += 1
      for (const term of runtimeTerms) {
        if (term.test(match[1] || '')) failures.push(`${relativePath}: ${key}: ${term}`)
      }
    }
  }

  assert.equal(copyCount > 0, true)
  assert.deepEqual(failures, [])
})
