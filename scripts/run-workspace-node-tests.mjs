import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mergeSubprocessV8Coverage } from './subprocess-v8-coverage.mjs'

const inputArgs = process.argv.slice(2)
const coverage = inputArgs.includes('--coverage')
const explicitTestFiles = inputArgs.filter((entry) => entry !== '--coverage')

const testRoots = [
  'apps/gateway/src',
  'apps/standalone-gateway/src',
  'mcps/agents/tests',
  'mcps/charts/tests',
  'mcps/knowledge/tests',
  'mcps/semantic-ui/tests',
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
  'packages/cloud-client/src',
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
  rmSync('coverage/workspace/v8-subprocess', { recursive: true, force: true })
  mkdirSync('coverage/workspace/v8-subprocess', { recursive: true })
  args.push(
    '--experimental-test-coverage',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=coverage/workspace/lcov.info',
  )
}

args.push('--test', ...testFiles)

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: coverage
    ? {
        ...process.env,
        NODE_V8_COVERAGE: join(process.cwd(), 'coverage/workspace/v8-subprocess'),
      }
    : process.env,
})
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

if (coverage) {
  const merged = mergeSubprocessV8Coverage({
    coverageDir: join(process.cwd(), 'coverage/workspace/v8-subprocess'),
    lcovPath: join(process.cwd(), 'coverage/workspace/lcov.info'),
  })
  process.stdout.write(`[workspace-coverage] merged ${merged.files} subprocess V8 files (${merged.lines} lines) from ${merged.v8Files} coverage payloads\n`)
}

process.exit(0)
