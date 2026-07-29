import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verifyProbes = process.argv.slice(2).includes('--verify-probes')
const knipEntryPoint = fileURLToPath(new URL('../bin/knip.js', import.meta.resolve('knip')))
const maxBuffer = 64 * 1024 * 1024

function canonicalKnipArguments(config = 'knip.jsonc') {
  return [
    '--config',
    config,
    '--files',
    '--exports',
    '--dependencies',
    '--reporter',
    'json',
    '--no-config-hints',
  ]
}

function runKnip(cwd, config = 'knip.jsonc') {
  return spawnSync(
    process.execPath,
    [knipEntryPoint, ...canonicalKnipArguments(config)],
    {
      cwd,
      encoding: 'utf8',
      env: process.env,
      maxBuffer,
    },
  )
}

function compareValues(left, right) {
  const leftText = JSON.stringify(left)
  const rightText = JSON.stringify(right)
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort(compareValues)
  }
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

function parseKnipReport(result) {
  if (result.error) {
    throw new Error(`unable to launch Knip: ${result.error.message}`)
  }
  if (result.stderr) process.stderr.write(result.stderr)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    if (result.stdout) process.stderr.write(result.stdout)
    throw new Error(
      `Knip returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function issueHas(report, field, predicate) {
  return report.issues?.some((issue) => (
    Array.isArray(issue[field]) && issue[field].some(predicate)
  )) === true
}

function verifyCanonicalProbes() {
  // Keep the fixture beneath the repository so its deliberately unlisted
  // import can resolve through the real root node_modules tree.
  const fixtureRoot = mkdtempSync(join(process.cwd(), '.open-cowork-dead-code-probes-'))
  try {
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true })
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      `${JSON.stringify({
        name: '@open-cowork/dead-code-probe',
        private: true,
        scripts: {
          'unlisted-binary-probe': 'definitely-unlisted-knip-probe',
        },
        dependencies: {
          'definitely-unused-knip-probe': '1.0.0',
        },
      }, null, 2)}\n`,
    )
    writeFileSync(
      join(fixtureRoot, 'knip.json'),
      `${JSON.stringify({
        workspaces: {
          '.': {
            entry: ['src/index.ts'],
            project: ['src/**/*.ts'],
          },
        },
      }, null, 2)}\n`,
    )
    writeFileSync(
      join(fixtureRoot, 'src/index.ts'),
      "import { z } from 'zod'\nimport { liveValue } from './live.js'\nvoid z\nvoid liveValue\n",
    )
    writeFileSync(
      join(fixtureRoot, 'src/live.ts'),
      [
        'export const liveValue = true',
        'export const deliberatelyUnusedExportProbe = true',
        'export type DeliberatelyUnusedTypeProbe = string',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(fixtureRoot, 'src/unused-file.ts'),
      'export const deliberatelyUnusedFileProbe = true\n',
    )

    const result = runKnip(fixtureRoot, 'knip.json')
    const report = parseKnipReport(result)
    const probes = {
      unusedDependency: issueHas(
        report,
        'dependencies',
        (issue) => issue.name === 'definitely-unused-knip-probe',
      ),
      unusedExport: issueHas(
        report,
        'exports',
        (issue) => issue.name === 'deliberatelyUnusedExportProbe',
      ),
      unusedFile: issueHas(
        report,
        'files',
        (issue) => issue.name === 'src/unused-file.ts',
      ),
      unusedType: issueHas(
        report,
        'types',
        (issue) => issue.name === 'DeliberatelyUnusedTypeProbe',
      ),
      unlistedBinary: issueHas(
        report,
        'binaries',
        (issue) => issue.name === 'definitely-unlisted-knip-probe',
      ),
      unlistedDependency: issueHas(
        report,
        'unlisted',
        (issue) => issue.name === 'zod',
      ),
    }
    process.stdout.write(`${JSON.stringify({
      probes,
      schemaVersion: 1,
    })}\n`)
    return Object.values(probes).every(Boolean) ? 0 : 3
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function generateReport() {
  const result = runKnip(process.cwd())
  const report = parseKnipReport(result)
  process.stdout.write(`${JSON.stringify(canonicalize({
    ...report,
    schemaVersion: 1,
  }))}\n`)
  return result.status ?? 2
}

try {
  process.exitCode = verifyProbes
    ? verifyCanonicalProbes()
    : generateReport()
} catch (error) {
  process.stderr.write(`[dead-code-report] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
