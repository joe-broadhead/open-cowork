import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const verifyProbe = process.argv.slice(2).includes('--verify-probe')
const probeRelativePath = `scripts/dead-code-unused-probe-${process.pid}.mjs`
const probeUrl = new URL(`../${probeRelativePath}`, import.meta.url)
const knipEntryPoint = fileURLToPath(new URL('../bin/knip.js', import.meta.resolve('knip')))
const knipArguments = [
  '--config',
  'knip.jsonc',
  '--include',
  'files,exports,dependencies,unlisted',
  '--reporter',
  'json',
  '--no-config-hints',
]

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

function cleanupProbe() {
  if (verifyProbe) rmSync(probeUrl, { force: true })
}

process.once('exit', cleanupProbe)

if (verifyProbe) {
  writeFileSync(
    probeUrl,
    'export const deliberatelyUnusedDeadCodeProbe = true\n',
    { flag: 'wx' },
  )
}

const child = spawn(process.execPath, [knipEntryPoint, ...knipArguments], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

let spawnError
child.on('error', (error) => {
  spawnError = error
})

child.on('close', (code) => {
  cleanupProbe()
  if (spawnError) {
    process.stderr.write(`[dead-code-report] unable to launch Knip: ${spawnError.message}\n`)
    process.exitCode = 2
    return
  }
  if (stderr) process.stderr.write(stderr)

  try {
    const knipReport = JSON.parse(stdout)
    if (verifyProbe) {
      const probeDetected = knipReport.issues?.some((issue) => (
        issue.file === probeRelativePath
        || issue.files?.some((file) => file.name === probeRelativePath)
      )) === true
      process.stdout.write(`${JSON.stringify({
        probeDetected,
        schemaVersion: 1,
      })}\n`)
      process.exitCode = probeDetected ? 0 : 3
      return
    }

    const report = canonicalize({
      ...knipReport,
      schemaVersion: 1,
    })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    process.exitCode = code ?? 2
  } catch (error) {
    process.stderr.write(`[dead-code-report] Knip returned invalid JSON: ${error.message}\n`)
    if (stdout) process.stderr.write(stdout)
    process.exitCode = 2
  }
})
