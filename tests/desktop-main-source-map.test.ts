import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_DIR = join(process.cwd(), 'apps/desktop/src/main')

const REQUIRED_DOMAIN_FOLDERS = [
  'desktop-pairing',
  'ipc',
  'update',
  'workflow',
  'workspace',
]

// Downward-only pressure on the legacy flat layout. File identity is governed
// by imports and the canonical dead-code gate; this budget only prevents new
// top-level sprawl while cohesive behavior moves into owned domain folders.
const TOP_LEVEL_TYPESCRIPT_BUDGET = 91

function listDomainFolders() {
  return readdirSync(MAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

function listTopLevelTypescript() {
  return readdirSync(MAIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

test('desktop main-process domain folders stay reflected in the source map', () => {
  const domainFolders = listDomainFolders()
  const readme = readFileSync(join(MAIN_DIR, 'README.md'), 'utf8')

  for (const folder of REQUIRED_DOMAIN_FOLDERS) {
    assert.ok(domainFolders.includes(folder), `${folder}/ is a required desktop main-process domain`)
  }
  for (const folder of domainFolders) {
    assert.match(folder, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${folder}/ must use a stable kebab-case domain name`)
    assert.match(readme, new RegExp(`\`${folder}/\``), `${folder}/ must be described in the source map`)
  }
  assert.doesNotMatch(readme, /`thread-index\/`/, 'thread-index moved to runtime-host and must not be listed as a desktop main folder')
})

test('desktop main-process top-level TypeScript stays within the flat-file ratchet', () => {
  const files = listTopLevelTypescript()
  assert.ok(
    files.length <= TOP_LEVEL_TYPESCRIPT_BUDGET,
    `desktop main has ${files.length} top-level TypeScript files (max ${TOP_LEVEL_TYPESCRIPT_BUDGET}); move cohesive behavior into an owned domain folder instead of growing the flat layout`,
  )
  for (const file of files) {
    assert.match(file, /^(?:index|[a-z0-9]+(?:-[a-z0-9]+)*)(?:\.d)?\.ts$/, `${file} must use a stable kebab-case module name`)
    assert.doesNotMatch(file, /\.(?:test|spec)\.ts$/, `${file} belongs beside its domain or in a test directory`)
  }
})
