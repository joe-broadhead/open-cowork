#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 1
const DEFAULT_REPORTER = 'spec'
const VALUE_OPTIONS = new Set(['pattern', 'timeout', 'retries', 'reporter'])

function writeLine(message = '') {
  process.stdout.write(`${message}\n`)
}

function failLine(message) {
  process.stderr.write(`${message}\n`)
}

function readOption(argv, name, fallback) {
  const values = readOptionValues(argv, name)
  return values[0] ?? fallback
}

function readOptionValues(argv, name) {
  const prefix = `--${name}=`
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (entry.startsWith(prefix)) {
      values.push(entry.slice(prefix.length))
      continue
    }
    if (entry === `--${name}`) {
      const value = argv[index + 1]
      if (typeof value === 'string') values.push(value)
      index += 1
    }
  }
  return values
}

function readIntegerOption(argv, name, fallback) {
  const raw = readOption(argv, name, String(fallback))
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`)
  }
  return value
}

function unexpectedPositionalArgs(argv) {
  const unexpected = []
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]
    if (!entry.startsWith('--')) {
      unexpected.push(entry)
      continue
    }
    const optionName = entry.includes('=')
      ? entry.slice(2, entry.indexOf('='))
      : entry.slice(2)
    if (VALUE_OPTIONS.has(optionName) && !entry.includes('=')) {
      index += 1
    }
  }
  return unexpected
}

export function parseSmokeRunnerArgs(argv = process.argv.slice(2)) {
  const positionalArgs = unexpectedPositionalArgs(argv)
  if (positionalArgs.length > 0) {
    throw new Error(`Unexpected positional smoke runner arguments: ${positionalArgs.join(', ')}. Quote globs so the smoke runner expands them deterministically.`)
  }
  const patternValues = readOptionValues(argv, 'pattern')
  if (patternValues.length > 1) {
    throw new Error('Received multiple --pattern values. Quote the glob so the smoke runner expands it deterministically.')
  }
  const pattern = patternValues[0] ?? null
  if (!pattern) {
    throw new Error('Missing --pattern=<glob>, for example --pattern=tests/*.smoke.test.ts')
  }
  return {
    pattern,
    timeoutMs: readIntegerOption(argv, 'timeout', DEFAULT_TIMEOUT_MS),
    retries: readIntegerOption(
      argv,
      'retries',
      Number.parseInt(process.env.OPEN_COWORK_SMOKE_RETRIES || String(DEFAULT_RETRIES), 10),
    ),
    reporter: readOption(argv, 'reporter', DEFAULT_REPORTER),
  }
}

function globBasenameToRegExp(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

export function collectSmokeTestFiles(pattern, cwd = process.cwd()) {
  const directory = dirname(pattern)
  const filePattern = basename(pattern)
  if (!filePattern.includes('*')) {
    const candidate = join(cwd, pattern)
    return statSync(candidate).isFile() ? [pattern] : []
  }
  if (directory.includes('*')) {
    throw new Error(`Unsupported smoke test glob: ${pattern}. Use a concrete directory and wildcard filename.`)
  }

  const matcher = globBasenameToRegExp(filePattern)
  return readdirSync(join(cwd, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function buildNodeTestArgs(file, options) {
  return [
    '--no-warnings',
    '--experimental-sqlite',
    '--experimental-strip-types',
    `--test-timeout=${options.timeoutMs}`,
    '--test-force-exit',
    `--test-reporter=${options.reporter}`,
    '--test',
    file,
  ]
}

function runNodeTestFile(file, options) {
  writeLine(`[smoke] ${file} attempt ${options.attempt}/${options.totalAttempts}`)
  const result = spawnSync(process.execPath, buildNodeTestArgs(file, options), {
    cwd: options.cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) {
    failLine(`[smoke] ${file} failed to launch: ${result.error.message}`)
    return 1
  }
  if (typeof result.status === 'number') return result.status
  if (result.signal) {
    failLine(`[smoke] ${file} terminated by ${result.signal}`)
    return 1
  }
  return 1
}

export function runSmokeTests(options, runner = runNodeTestFile) {
  const cwd = options.cwd || process.cwd()
  const files = collectSmokeTestFiles(options.pattern, cwd)
  if (files.length === 0) {
    failLine(`[smoke] No test files matched ${options.pattern}`)
    return {
      exitCode: 1,
      files,
      flaky: [],
      failed: [],
    }
  }

  const totalAttempts = options.retries + 1
  const flaky = []
  const failed = []

  for (const file of files) {
    let passed = false
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const status = runner(file, {
        ...options,
        cwd,
        attempt,
        totalAttempts,
      })
      if (status === 0) {
        passed = true
        if (attempt > 1) flaky.push(file)
        break
      }
      if (attempt < totalAttempts) {
        failLine(`[smoke] ${file} failed attempt ${attempt}/${totalAttempts}; retrying.`)
      }
    }
    if (!passed) {
      failed.push(file)
    }
  }

  if (flaky.length > 0) {
    failLine(`[smoke] flaky pass after retry: ${flaky.join(', ')}`)
  }
  if (failed.length > 0) {
    failLine(`[smoke] failed after ${totalAttempts} attempt(s): ${failed.join(', ')}`)
    return {
      exitCode: 1,
      files,
      flaky,
      failed,
    }
  }

  writeLine(`[smoke] ${files.length} file(s) passed${flaky.length > 0 ? `; ${flaky.length} required retry` : ''}.`)
  return {
    exitCode: 0,
    files,
    flaky,
    failed,
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMainModule()) {
  try {
    const result = runSmokeTests(parseSmokeRunnerArgs())
    process.exitCode = result.exitCode
  } catch (error) {
    failLine(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
