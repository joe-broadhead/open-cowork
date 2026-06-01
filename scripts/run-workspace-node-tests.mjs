import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const inputArgs = process.argv.slice(2)
const coverage = inputArgs.includes('--coverage')
const explicitTestFiles = inputArgs.filter((entry) => entry !== '--coverage')

const testRoots = [
  'apps/gateway/src',
  'apps/standalone-gateway/src',
  'apps/website/src',
  'mcps/agents/tests',
  'mcps/charts/tests',
  'mcps/clock/tests',
  'mcps/skills/tests',
  'mcps/workflows/tests',
  'packages/gateway-channel/src',
  'packages/gateway-provider-cli/src',
  'packages/gateway-provider-discord/src',
  'packages/gateway-provider-email/src',
  'packages/gateway-provider-signal/src',
  'packages/gateway-provider-slack/src',
  'packages/gateway-provider-telegram/src',
  'packages/gateway-provider-webhook/src',
  'packages/gateway-provider-whatsapp/src',
  'packages/gateway-testing/src',
]

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectTests(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const testFiles = explicitTestFiles.length > 0
  ? explicitTestFiles
  : testRoots
    .filter((root) => {
      try {
        return statSync(root).isDirectory()
      } catch {
        return false
      }
    })
    .flatMap(collectTests)
    .sort()

if (testFiles.length === 0) {
  console.error('No workspace Node test files found.')
  process.exit(1)
}

const args = [
  '--no-warnings',
  '--experimental-sqlite',
  '--experimental-strip-types',
]

if (coverage) {
  mkdirSync('coverage/workspace', { recursive: true })
  args.push(
    '--experimental-test-coverage',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/workspace/lcov.info',
  )
}

args.push('--test', ...testFiles)

const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
