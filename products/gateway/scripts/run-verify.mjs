#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_VERIFY_PHASES = [
  {
    id: 'typecheck',
    title: 'TypeScript typecheck',
    command: 'npm',
    args: ['run', 'typecheck'],
    safeNextAction: 'Fix TypeScript diagnostics, rerun npm run typecheck, then rerun npm run verify.',
  },
  {
    id: 'unit-full',
    title: 'Full Vitest suite',
    command: 'npm',
    args: ['test'],
    safeNextAction: 'Run the focused failing Vitest file first, then rerun npm test before npm run verify.',
  },
  {
    id: 'build',
    title: 'Production build',
    command: 'npm',
    args: ['run', 'build'],
    safeNextAction: 'Fix build-only compiler or packaging output, then rerun npm run build before npm run verify.',
  },
  {
    id: 'release-check',
    title: 'Release and claim-boundary checks',
    command: 'npm',
    args: ['run', 'release:check'],
    safeNextAction: 'Run npm run release:check and inspect the named failed gate (version alignment, claim registry, or overclaim scan over README + docs/**).',
  },
  {
    id: 'validation-gates',
    title: 'Validation-gate metadata check',
    command: 'npm',
    args: ['run', 'validation:check'],
    safeNextAction: 'Run npm run validation:check and repair validation-gates.json metadata or stale referenced paths.',
  },
  {
    id: 'evidence-safety',
    title: 'Evidence-safety scan',
    command: 'npm',
    args: ['run', 'evidence:safety'],
    safeNextAction: 'Run npm run evidence:safety and remove the flagged secret-shaped or raw-transcript content from the named evidence/doc file.',
  },
]

export function runVerifyPlan(phases = DEFAULT_VERIFY_PHASES, options = {}) {
  const cwd = options.cwd || DEFAULT_ROOT
  const env = options.env || process.env
  const logger = options.logger || console.error
  const now = options.now || (() => Date.now())
  const stdio = options.stdio || 'inherit'
  const startedAt = now()
  const results = []

  logger(`[verify] plan: ${phases.map(phase => phase.id).join(' -> ')}`)

  for (const phase of phases) {
    const phaseStartedAt = now()
    logger(`[verify] start ${phase.id}: ${phase.title}`)
    const result = spawnSync(phase.command, phase.args, {
      cwd,
      env,
      stdio,
      encoding: stdio === 'pipe' ? 'utf8' : undefined,
    })
    const durationMs = Math.max(0, now() - phaseStartedAt)
    const errorSummary = result.error ? safeDiagnosticMessage(result.error) : undefined
    const phaseResult = {
      id: phase.id,
      title: phase.title,
      command: [phase.command, ...phase.args].join(' '),
      status: result.status === 0 && !result.error ? 'pass' : 'fail',
      durationMs,
      safeNextAction: phase.safeNextAction,
      ...(errorSummary ? { errorSummary } : {}),
    }
    results.push(phaseResult)

    if (phaseResult.status !== 'pass') {
      logger(`[verify] fail ${phase.id} after ${formatDuration(durationMs)}`)
      if (errorSummary) logger(`[verify] error ${phase.id}: ${errorSummary}`)
      logger(`[verify] next action: ${phase.safeNextAction}`)
      return {
        schemaVersion: 1,
        mode: 'verify_phase_runner',
        status: 'fail',
        failedPhase: phase.id,
        totalDurationMs: Math.max(0, now() - startedAt),
        phases: results,
      }
    }

    logger(`[verify] pass ${phase.id} in ${formatDuration(durationMs)}`)
  }

  const totalDurationMs = Math.max(0, now() - startedAt)
  logger(`[verify] pass all phases in ${formatDuration(totalDurationMs)}`)
  return {
    schemaVersion: 1,
    mode: 'verify_phase_runner',
    status: 'pass',
    totalDurationMs,
    phases: results,
  }
}

export function formatDuration(durationMs) {
  if (durationMs < 1000) return `${durationMs}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

export function safeDiagnosticMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer <redacted>')
    .replace(/\b(token|secret|password|credential)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/\/Users\/[^/\s]+/g, '<home>')
    .replace(/\/home\/[^/\s]+/g, '<home>')
    .replace(/\/private\/[^\s]+/g, '<private-path>')
    .replace(/\/var\/folders\/[^\s]+/g, '<private-path>')
}

function parseArgs(argv) {
  const options = { json: false, help: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    else throw new Error('Unexpected positional argument')
  }
  return options
}

function printHelp() {
  console.log(`Usage: node scripts/run-verify.mjs [--json]

Runs the repository verification phases with phase names, timing, and safe next actions:
  1. npm run typecheck
  2. npm test
  3. npm run build
  4. npm run release:check
  5. npm run validation:check
  6. npm run evidence:safety
`)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('[verify] argument error')
    console.error(`[verify] detail: ${safeDiagnosticMessage(error)}`)
    console.error(`[verify] next action: run node scripts/run-verify.mjs --help`)
    process.exit(1)
  }
  if (options.help) {
    printHelp()
    return
  }

  const result = runVerifyPlan()
  if (options.json) console.log(JSON.stringify(result, null, 2))
  process.exit(result.status === 'pass' ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error('[verify] unexpected failure')
    console.error(`[verify] detail: ${safeDiagnosticMessage(error)}`)
    console.error('[verify] next action: inspect scripts/run-verify.mjs and rerun npm run verify')
    process.exit(1)
  })
}
