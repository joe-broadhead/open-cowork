#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkOpencodeCompatibilityReport,
  getOpencodeCompatibilityReport,
  type OpencodeRuntimeContractFixture,
} from '../apps/desktop/src/main/opencode-compatibility.ts'

interface CliOptions {
  allowMissingRuntimeVersion: boolean
  allowPrivateAssumptions: boolean
  json: boolean
  repositoryRoot: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    allowMissingRuntimeVersion: false,
    allowPrivateAssumptions: false,
    json: false,
    repositoryRoot: process.cwd(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--allow-missing-runtime-version') options.allowMissingRuntimeVersion = true
    else if (arg === '--allow-private-assumptions') options.allowPrivateAssumptions = true
    else if (arg === '--root') options.repositoryRoot = argv[++index] || ''
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node --no-warnings --experimental-strip-types scripts/check-opencode-compatibility.ts [--json] [--root DIR]

Validates the OpenCode compatibility registry used by runtime diagnostics.

Options:
  --json                             Print the report and check result as JSON.
  --root DIR                         Repository root for proving-test path checks.
  --allow-missing-runtime-version    Development-only override for missing OpenCode package metadata.
  --allow-private-assumptions        Development-only override for private OpenCode assumptions.
`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!options.repositoryRoot) throw new Error('--root requires a directory')
  return options
}

function formatIssue(issue: { assumptionId?: string; code: string; message: string }) {
  const id = issue.assumptionId ? ` ${issue.assumptionId}` : ''
  return `- ${issue.code}${id}: ${issue.message}`
}

const options = parseArgs(process.argv.slice(2))
const report = getOpencodeCompatibilityReport()
const runtimeContractFixture = JSON.parse(readFileSync(
  join(options.repositoryRoot, 'tests/fixtures/opencode-runtime-contract.json'),
  'utf8',
)) as OpencodeRuntimeContractFixture
const result = checkOpencodeCompatibilityReport(report, {
  allowMissingRuntimeVersion: options.allowMissingRuntimeVersion,
  allowPrivateAssumptions: options.allowPrivateAssumptions,
  repositoryRoot: options.repositoryRoot,
  runtimeContractFixture,
})

if (options.json) {
  process.stdout.write(`${JSON.stringify({ result, report }, null, 2)}\n`)
} else if (result.ok) {
  process.stdout.write(
    `[opencode-compatibility] ok version=${result.opencodeVersion || 'missing'} assumptions=${result.assumptionCount} runtimeContracts=${result.runtimeContractCount} blocked=${result.blockedCount} shims=${result.shimCount}\n`,
  )
} else {
  process.stderr.write(`[opencode-compatibility] failed version=${result.opencodeVersion || 'missing'}\n${result.issues.map(formatIssue).join('\n')}\n`)
}

if (!result.ok) process.exitCode = 1
