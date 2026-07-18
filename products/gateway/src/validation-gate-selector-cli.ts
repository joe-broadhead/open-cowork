import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  formatValidationGateSelection,
  normalizeChangedFile,
  selectValidationGates,
} from './validation-gate-selector.js'

interface CliOptions {
  json: boolean
  help: boolean
  staged: boolean
  base?: string
  files: string[]
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { json: false, help: false, staged: false, files: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--staged') options.staged = true
    else if (arg === '--base') {
      const value = argv[i + 1]
      if (!value) throw new Error('--base requires a ref')
      options.base = value
      i += 1
    } else if (arg === '--files') {
      i += 1
      while (i < argv.length && !argv[i]!.startsWith('--')) {
        options.files.push(argv[i]!)
        i += 1
      }
      i -= 1
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      options.files.push(arg)
    }
  }
  return options
}

function printHelp(): void {
  console.log(`Usage: npm run validation:select -- [--json] [--staged] [--base REF] [--files FILE...]

Prints recommended local validation gates for changed files without running them.

Examples:
  npm run validation:select -- --files docs/index.md mkdocs.yml
  npm run validation:select -- --base origin/main --json
  npm run validation:select -- --staged
`)
}

function gitDiffNameOnly(args: readonly string[]): string[] {
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUB', ...args], {
    encoding: 'utf8',
  })
  if (result.status !== 0 || result.error) {
    const detail = result.stderr?.trim() || result.error?.message || 'git diff failed'
    throw new Error(detail)
  }
  return result.stdout
    .split(/\r?\n/)
    .map(normalizeChangedFile)
    .filter(Boolean)
}

function changedFilesFrom(options: CliOptions): string[] {
  if (options.files.length > 0) return options.files.map(normalizeChangedFile)
  if (options.base) return gitDiffNameOnly([`${options.base}...HEAD`])
  if (options.staged) return gitDiffNameOnly(['--cached'])

  return [
    ...gitDiffNameOnly(['--cached']),
    ...gitDiffNameOnly([]),
  ]
}

function main(): void {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`validation selector argument error: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Safe next action: run npm run validation:select -- --help')
    process.exit(1)
  }

  if (options.help) {
    printHelp()
    return
  }

  try {
    const selection = selectValidationGates({ changedFiles: changedFilesFrom(options) })
    if (options.json) console.log(JSON.stringify(selection, null, 2))
    else process.stdout.write(formatValidationGateSelection(selection))
  } catch (error) {
    console.error(`validation selector failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Safe next action: run npm run verify and record the selector blocker in Linear.')
    process.exit(1)
  }
}

main()
