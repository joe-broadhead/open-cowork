import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const envName = 'OPEN_COWORK_PACKAGED_EXECUTABLE'
const executablePath = process.env[envName]?.trim()

function fail(message) {
  console.error(`${message}\n\nBuild a packaged desktop app first, then run the release smoke gate. Examples:\n  pnpm --dir apps/desktop dist:ci:mac\n  ${envName}="$(node scripts/find-macos-packaged-executable.mjs)" pnpm test:e2e:packaged\n\nFor Linux, run:\n  pnpm --dir apps/desktop dist:ci:linux\n  ${envName}=apps/desktop/release/linux-unpacked/<binary> pnpm test:e2e:packaged`)
  process.exit(1)
}

if (!executablePath) {
  fail(`${envName} must point at a packaged desktop executable before running packaged smoke tests.`)
}

function assertExecutableFile(path) {
  const stats = statSync(path)
  if (!stats.isFile()) {
    fail(`${envName} must point at an executable file or a macOS .app bundle: ${path}`)
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    fail(`${envName} is not executable: ${path}`)
  }
  return path
}

function resolveMacAppExecutable(appPath) {
  const appName = basename(appPath).replace(/\.app$/i, '')
  const macOsDir = join(appPath, 'Contents', 'MacOS')
  let entries
  try {
    entries = readdirSync(macOsDir)
  } catch {
    fail(`${envName} points at a .app bundle without Contents/MacOS: ${appPath}`)
  }

  const executableCandidates = entries
    .map((entry) => join(macOsDir, entry))
    .filter((candidate) => {
      try {
        const stats = statSync(candidate)
        accessSync(candidate, constants.X_OK)
        return stats.isFile()
      } catch {
        return false
      }
    })

  const preferred = executableCandidates.find((candidate) => basename(candidate) === appName)
  const resolved = preferred || (executableCandidates.length === 1 ? executableCandidates[0] : null)
  if (!resolved) {
    fail(`${envName} points at a .app bundle without one resolvable executable in Contents/MacOS: ${appPath}`)
  }
  return resolved
}

let stats
try {
  stats = statSync(executablePath)
} catch {
  fail(`${envName} does not exist: ${executablePath}`)
}

if (stats.isDirectory() && /\.app$/i.test(executablePath)) {
  resolveMacAppExecutable(executablePath)
} else {
  assertExecutableFile(executablePath)
}
