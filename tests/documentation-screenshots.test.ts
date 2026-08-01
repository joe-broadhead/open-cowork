import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDocumentationScreenshots } from '../scripts/check-doc-screenshots.mjs'
import { cleanupSmokePaths, createSmokePaths } from '../apps/desktop/tests/smoke-helpers.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('documentation setup profiles preserve production credential requirements', () => {
  const paths = createSmokePaths({ preserveProviderCredentialRequirements: true })
  try {
    const config = JSON.parse(readFileSync(paths.configPath, 'utf8')) as {
      providers?: {
        defaultProvider?: string
        descriptors?: Record<string, { credentials?: Array<{ required?: boolean }> }>
      }
    }
    const defaultProvider = config.providers?.defaultProvider || ''
    const credentials = config.providers?.descriptors?.[defaultProvider]?.credentials || []
    assert.ok(credentials.length > 0)
    assert.ok(credentials.some((credential) => credential.required === true))
  } finally {
    cleanupSmokePaths(paths)
  }
})

test('documentation screenshots reject unowned, unreferenced generated assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-doc-shots-'))
  try {
    mkdirSync(join(root, 'docs/assets/auto'), { recursive: true })
    writeFileSync(join(root, 'docs/guide.md'), '![Home](assets/auto/home.png)\n')
    writeFileSync(join(root, 'docs/assets/auto/home.png'), '')
    writeFileSync(join(root, 'docs/assets/auto/orphan.png'), '')

    const errors = validateDocumentationScreenshots({
      root,
      journeys: [{ id: 'home', route: 'home', owner: 'Desktop', doc: 'docs/guide.md' }],
    })
    assert.deepEqual(errors, [
      'Unreferenced generated screenshot: docs/assets/auto/orphan.png',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('documentation screenshots require distinct routes and an owned doc reference', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-doc-shots-'))
  try {
    mkdirSync(join(root, 'docs/assets/auto'), { recursive: true })
    writeFileSync(join(root, 'docs/guide.md'), 'No screenshots here.\n')
    writeFileSync(join(root, 'docs/assets/auto/home.png'), '')
    writeFileSync(join(root, 'docs/assets/auto/chat.png'), '')

    const errors = validateDocumentationScreenshots({
      root,
      journeys: [
        { id: 'home', route: 'hero', owner: 'Desktop', doc: 'docs/guide.md' },
        { id: 'chat', route: 'hero', owner: 'Runtime', doc: 'docs/guide.md' },
      ],
    })
    assert.ok(errors.some((error) => error === 'Duplicate screenshot route/state: hero'))
    assert.ok(errors.some((error) => error.includes('home: docs/guide.md must reference')))
    assert.ok(errors.some((error) => error.includes('chat: docs/guide.md must reference')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('documentation screenshots reject undeclared generated assets in the public README', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-doc-shots-'))
  try {
    mkdirSync(join(root, 'docs/assets/auto'), { recursive: true })
    writeFileSync(join(root, 'docs/guide.md'), '![Home](assets/auto/home.png)\n')
    writeFileSync(join(root, 'README.md'), '![Old](docs/assets/auto/old-home.png)\n')
    writeFileSync(join(root, 'docs/assets/auto/home.png'), '')

    const errors = validateDocumentationScreenshots({
      root,
      journeys: [{ id: 'home', route: 'home', owner: 'Desktop', doc: 'docs/guide.md' }],
    })
    assert.ok(errors.some((error) => error === 'README.md references undeclared generated screenshot: old-home.png'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('documentation screenshot capture pins time, timezone, and the chat title', () => {
  const source = readFileSync(join(repoRoot, 'apps/desktop/tests/screenshots.ts'), 'utf8')
  assert.match(source, /DOCUMENTATION_CAPTURE_TIME = '[^']+Z'/)
  assert.match(source, /page\.clock\.setFixedTime\(DOCUMENTATION_CAPTURE_TIME\)/)
  assert.match(source, /Emulation\.setTimezoneOverride['"], \{ timezoneId: ['"]UTC['"] \}/)
  assert.match(source, /DOCUMENTATION_CHAT_TITLE = 'Launch brief planning'/)
  assert.match(source, /window\.coworkApi\.session\.rename\(sessions\[0\]!\.id, title\)/)
  assert.match(source, /hasText: DOCUMENTATION_CHAT_TITLE/)
})

test('documentation screenshot capture waits for semantic route readiness instead of a fixed delay', () => {
  const source = readFileSync(join(repoRoot, 'apps/desktop/tests/screenshots.ts'), 'utf8')
  assert.doesNotMatch(source, /SETTLE_MS|waitForTimeout\(/)
  assert.match(source, /waitForSettledJourney\(page, id\)/)
  assert.match(source, /team-surface/)
  assert.match(source, /playbooks-surface/)
  assert.match(source, /tools-skills-surface/)
  assert.match(source, /dataset\.loadState !== 'loading'/)
})
