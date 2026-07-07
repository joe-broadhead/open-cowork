import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// electron-builder writes the unpacked Windows app to release/win-unpacked
// (win-arm64-unpacked for arm64). The packaged smoke test launches the
// bundled Electron executable directly, so resolve the product .exe rather
// than the NSIS installer.
const candidateDirs = [
  resolve(process.cwd(), 'apps/desktop/release/win-unpacked'),
  resolve(process.cwd(), 'apps/desktop/release/win-arm64-unpacked'),
]

const ignoredExecutableNames = new Set([
  'chrome-sandbox.exe',
  'chrome_crashpad_handler.exe',
  'elevate.exe',
])

const unpackedDir = candidateDirs.find((dir) => existsSync(dir))
if (!unpackedDir) {
  console.error(`Windows unpacked release directory not found. Looked in: ${candidateDirs.join(', ')}`)
  process.exit(1)
}

const candidates = readdirSync(unpackedDir)
  .filter((name) => name.toLowerCase().endsWith('.exe'))
  .filter((name) => !ignoredExecutableNames.has(name))
  .map((name) => ({ name, path: join(unpackedDir, name) }))
  .filter((candidate) => statSync(candidate.path).isFile())
  .sort((left, right) => left.name.localeCompare(right.name))

if (candidates.length === 0) {
  console.error(`No packaged Windows executable found under ${unpackedDir}`)
  process.exit(1)
}

process.stdout.write(candidates[0].path)
