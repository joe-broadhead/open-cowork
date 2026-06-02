import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const unpackedDir = resolve(process.cwd(), 'apps/desktop/release/linux-unpacked')

const ignoredExecutableNames = new Set([
  'chrome-sandbox',
  'chrome_crashpad_handler',
])

function isIgnoredSharedObject(name) {
  return name.endsWith('.so') || name.includes('.so.')
}

if (!existsSync(unpackedDir)) {
  console.error(`Linux unpacked release directory not found: ${unpackedDir}`)
  process.exit(1)
}

const candidates = readdirSync(unpackedDir)
  .map((name) => ({ name, path: join(unpackedDir, name) }))
  .filter((candidate) => {
    if (ignoredExecutableNames.has(candidate.name)) return false
    if (isIgnoredSharedObject(candidate.name)) return false
    const stat = statSync(candidate.path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  })
  .sort((left, right) => left.name.localeCompare(right.name))

if (candidates.length === 0) {
  console.error(`No packaged Linux executable found under ${unpackedDir}`)
  process.exit(1)
}

process.stdout.write(candidates[0].path)
