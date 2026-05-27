import { accessSync, constants, statSync } from 'node:fs'

const envName = 'OPEN_COWORK_PACKAGED_EXECUTABLE'
const executablePath = process.env[envName]?.trim()

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!executablePath) {
  fail(`${envName} must point at a packaged desktop executable before running packaged smoke tests.`)
}

let stats
try {
  stats = statSync(executablePath)
} catch {
  fail(`${envName} does not exist: ${executablePath}`)
}

if (!stats.isFile()) {
  fail(`${envName} must point at an executable file: ${executablePath}`)
}

try {
  accessSync(executablePath, constants.X_OK)
} catch {
  fail(`${envName} is not executable: ${executablePath}`)
}
