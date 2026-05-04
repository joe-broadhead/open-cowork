import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const noticesPath = join(rootDir, 'THIRD_PARTY_NOTICES.md')
const licenseDir = join(rootDir, 'THIRD_PARTY_LICENSES')
const notices = readFileSync(noticesPath, 'utf8')
const referencedDirs = Array.from(notices.matchAll(/THIRD_PARTY_LICENSES\/([^)\s|]+)\//g))
  .map((match) => match[1])
  .filter(Boolean)

const missing = []
const empty = []
for (const dirName of referencedDirs) {
  const dir = join(licenseDir, dirName)
  if (!existsSync(dir)) {
    missing.push(`THIRD_PARTY_LICENSES/${dirName}/`)
    continue
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
  if (files.length === 0) {
    empty.push(`THIRD_PARTY_LICENSES/${dirName}/`)
  }
}

if (missing.length > 0 || empty.length > 0) {
  for (const path of missing) {
    console.error(`Missing bundled license directory referenced by THIRD_PARTY_NOTICES.md: ${path}`)
  }
  for (const path of empty) {
    console.error(`Bundled license directory has no files: ${path}`)
  }
  process.exit(1)
}
