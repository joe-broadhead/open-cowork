import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const productionCopyRoots = [
  'apps/desktop/src/renderer/components',
]

const productionDocs = [
  'README.md',
  'docs/desktop-app.md',
  'docs/automations.md',
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

test('desktop guide documents fleet operations language and density standards', () => {
  const guide = readFileSync(join(repoRoot, 'docs/desktop-app.md'), 'utf8')
  assert.match(guide, /Fleet operations language and density standards/)
  assert.match(guide, /Prepare brief/)
  assert.match(guide, /Check-in/)
  assert.match(guide, /compact tables, split panes, saved\s+filters, and bulk-safe actions/)
  for (const status of ['running', 'waiting on user', 'needs review', 'blocked', 'failed', 'delivered', 'paused', 'archived']) {
    assert.match(guide, new RegExp(status))
  }
})

test('localized Pulse homepage copy avoids runtime-health terminology', () => {
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
