import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const coverage = process.argv.includes('--coverage')
const testFiles = readdirSync('tests')
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
    '--test-coverage-lines=80',
    '--test-coverage-branches=68',
    '--test-coverage-functions=74',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/node/lcov.info',
  )
}

args.push('--test', ...testFiles)

const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
