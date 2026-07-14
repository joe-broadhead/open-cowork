import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const inputArgs = process.argv.slice(2)
const coverage = inputArgs.includes('--coverage')
const explicitTestFiles = inputArgs.filter((entry) => entry !== '--coverage')
const testFiles = explicitTestFiles.length > 0
  ? explicitTestFiles
  : readdirSync('tests')
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => join('tests', entry))

if (testFiles.length === 0) {
  console.error('No Node test files found under tests/*.test.ts')
  process.exit(1)
}

const args = [
  '--no-warnings',
  '--experimental-sqlite',
  '--experimental-strip-types',
]

if (coverage) {
  mkdirSync('coverage/node', { recursive: true })
  args.push(
    '--experimental-test-coverage',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/node/lcov.info',
  )
}

args.push('--test', ...testFiles)

const callerUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR?.trim()
const testUserDataDir = callerUserDataDir || mkdtempSync(join(tmpdir(), 'open-cowork-node-tests-'))
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OPEN_COWORK_USER_DATA_DIR: testUserDataDir,
  },
})
if (!callerUserDataDir) rmSync(testUserDataDir, { recursive: true, force: true })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
