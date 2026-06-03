#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const DEFAULT_SUITE = 'deploy/scenarios/local-desktop-scenarios.json'
const DEFAULT_OUTPUT_DIR = '.open-cowork-test/live-scenarios'
const EXECUTION_OUTPUT_MAX_BUFFER_BYTES = 8 * 1024 * 1024
const FAILURE_SNIPPET_BYTES = 2000

const TOKEN_PATTERNS = [
  /\bAuthorization:\s*Bearer\s+\S+/gi,
  /\bAuthorization:\s*Basic\s+\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-or(?:-[a-z0-9]+)?-[A-Za-z0-9]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\boc(?:c|gw)_[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{16,}['"]?/gi,
]
const HOME_PATH_PATTERNS = [
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,
]
const FORBIDDEN_EVIDENCE_PATTERNS = [
  /\/Users\/(?!\[REDACTED_HOME\])[^/\s]+/,
  /\/home\/(?!\[REDACTED_HOME\])[^/\s]+/,
  /[A-Z]:\\Users\\(?!\[REDACTED_HOME\])/i,
  /\b(?:sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/,
  /\bAuthorization:\s*(?:Bearer|Basic)\s+\S+/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{16,}/i,
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function sanitizeEvidenceText(value) {
  let result = String(value ?? '')
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, '[REDACTED_TOKEN]')
  for (const pattern of HOME_PATH_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const prefix = match.match(/^(\/Users|\/home|[A-Z]:\\Users)/i)?.[0] || '[HOME]'
      return `${prefix}/[REDACTED_HOME]`
    })
  }
  return result
}

export function assertEvidenceSafe(value, label = 'evidence') {
  const text = String(value ?? '')
  for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${label} contains private-looking evidence: ${pattern}`)
  }
}

function requireString(record, key, label) {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}.${key} is required`)
  return value.trim()
}

function requireStringArray(record, key, label) {
  const value = record[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${label}.${key} must be a non-empty string array`)
  }
  if (value.length === 0) throw new Error(`${label}.${key} must not be empty`)
  return value
}

function validateScenario(scenario, index) {
  const label = `scenarios[${index}]`
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error(`${label} must be an object`)
  }
  requireString(scenario, 'id', label)
  requireString(scenario, 'title', label)
  requireString(scenario, 'owner', label)
  requireString(scenario, 'authority', label)
  requireString(scenario, 'productSurface', label)
  requireString(scenario, 'contract', label)
  requireString(scenario, 'stability', label)
  requireStringArray(scenario, 'productModes', label)
  requireStringArray(scenario, 'prerequisites', label)
  requireStringArray(scenario, 'steps', label)
  requireStringArray(scenario, 'expectedOutcomes', label)
  requireStringArray(scenario, 'evidence', label)
  if (!Array.isArray(scenario.command) || scenario.command.length === 0 || scenario.command.some((part) => typeof part !== 'string' || !part.trim())) {
    throw new Error(`${label}.command must be a non-empty argv array`)
  }
}

export function validateScenarioSuite(suite) {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) throw new Error('Scenario suite must be an object')
  if (suite.schemaVersion !== 1) throw new Error('Scenario suite schemaVersion must be 1')
  requireString(suite, 'purpose', 'suite')
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length < 5) {
    throw new Error('Scenario suite must include at least five scenarios')
  }
  const seen = new Set()
  suite.scenarios.forEach((scenario, index) => {
    validateScenario(scenario, index)
    if (seen.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`)
    seen.add(scenario.id)
  })
  return suite
}

function parseArgs(argv) {
  const args = {
    suite: DEFAULT_SUITE,
    outputDir: DEFAULT_OUTPUT_DIR,
    execute: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--suite') {
      args.suite = argv[index + 1]
      index += 1
    } else if (arg === '--output-dir') {
      args.outputDir = argv[index + 1]
      index += 1
    } else if (arg === '--execute') {
      args.execute = true
    } else if (arg === '--dry-run') {
      args.execute = false
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/live-scenario-evidence.mjs [--suite path] [--output-dir path] [--execute|--dry-run]\n')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!args.suite) throw new Error('--suite requires a path')
  if (!args.outputDir) throw new Error('--output-dir requires a path')
  return args
}

function commandArgv(command) {
  const [bin, ...args] = command
  return [bin === 'node' ? process.execPath : bin, args]
}

function sanitizedCommand(command) {
  return command.map((part) => sanitizeEvidenceText(part))
}

function failureSnippet(stdout, stderr, error) {
  const text = [
    error ? `spawn error: ${error.message}` : '',
    stderr,
    stdout,
  ].filter(Boolean).join('\n')
  return sanitizeEvidenceText(text).slice(0, FAILURE_SNIPPET_BYTES)
}

function scenarioFailureTaxonomy(scenario) {
  return {
    productSurface: sanitizeEvidenceText(scenario.productSurface),
    authority: sanitizeEvidenceText(scenario.authority),
    contract: sanitizeEvidenceText(scenario.contract),
    likelyOwner: sanitizeEvidenceText(scenario.owner),
  }
}

function runScenario(scenario, options) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  if (!options.execute) {
    return {
      id: scenario.id,
      title: scenario.title,
      status: 'skipped',
      productSurface: scenario.productSurface,
      authority: scenario.authority,
      contract: scenario.contract,
      owner: scenario.owner,
      failureTaxonomy: scenarioFailureTaxonomy(scenario),
      command: sanitizedCommand(scenario.command),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      stdout: '',
      stderr: '',
      redactionsApplied: false,
    }
  }
  const [bin, args] = commandArgv(scenario.command)
  const result = spawnSync(bin, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: EXECUTION_OUTPUT_MAX_BUFFER_BYTES,
  })
  const rawStdout = result.stdout || ''
  const rawStderr = result.stderr || ''
  const stdout = sanitizeEvidenceText(rawStdout)
  const stderr = sanitizeEvidenceText(rawStderr)
  const output = `${stdout}\n${stderr}`
  assertEvidenceSafe(output, scenario.id)
  const finishedAt = new Date().toISOString()
  return {
    id: scenario.id,
    title: scenario.title,
    status: result.status === 0 ? 'pass' : 'fail',
    productSurface: scenario.productSurface,
    authority: scenario.authority,
    contract: scenario.contract,
    owner: scenario.owner,
    failureTaxonomy: scenarioFailureTaxonomy(scenario),
    command: sanitizedCommand(scenario.command),
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    redactionsApplied: stdout !== rawStdout || stderr !== rawStderr,
    exitCode: result.status,
    signal: result.signal,
    failureReason: result.status === 0 && !result.error ? undefined : failureSnippet(stdout, stderr, result.error),
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Open Cowork Live Scenario Evidence',
    '',
    `Suite: ${report.suite.name}`,
    `Mode: ${report.execute ? 'execute' : 'dry-run'}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    `Result: ${report.ok ? 'pass' : 'fail'}`,
    '',
    '| Scenario | Status | Surface | Authority | Contract | Owner |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const result of report.results) {
    lines.push(`| ${result.title} | ${result.status} | ${result.productSurface} | ${result.authority} | ${result.contract} | ${result.owner} |`)
  }
  return `${lines.join('\n')}\n`
}

export function runScenarioSuite(options = {}) {
  const suitePath = options.suite || DEFAULT_SUITE
  if (!existsSync(suitePath)) throw new Error(`Scenario suite not found: ${suitePath}`)
  const suite = validateScenarioSuite(readJson(suitePath))
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR
  mkdirSync(outputDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const results = suite.scenarios.map((scenario) => runScenario(scenario, { execute: options.execute === true }))
  const finishedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    purpose: 'open-cowork-live-scenario-evidence',
    suite: {
      name: suite.name || basename(suitePath),
      path: suitePath,
      scenarioCount: suite.scenarios.length,
    },
    execute: options.execute === true,
    ok: results.every((result) => result.status === 'pass' || result.status === 'skipped'),
    startedAt,
    finishedAt,
    counts: {
      pass: results.filter((result) => result.status === 'pass').length,
      fail: results.filter((result) => result.status === 'fail').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
    },
    results,
  }
  report.failures = results
    .filter((result) => result.status === 'fail')
    .map((result) => ({
      id: result.id,
      title: result.title,
      exitCode: result.exitCode,
      signal: result.signal,
      failureReason: result.failureReason || '',
    }))
  const jsonPath = join(outputDir, 'live-scenario-evidence.json')
  const markdownPath = join(outputDir, 'live-scenario-evidence.md')
  report.artifacts = [
    { kind: 'json', path: sanitizeEvidenceText(jsonPath) },
    { kind: 'markdown', path: sanitizeEvidenceText(markdownPath) },
  ]
  const json = `${JSON.stringify(report, null, 2)}\n`
  assertEvidenceSafe(json, 'live scenario report')
  writeFileSync(jsonPath, json)
  writeFileSync(markdownPath, renderMarkdown(report))
  return { report, jsonPath, markdownPath }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const { report, jsonPath, markdownPath } = runScenarioSuite(args)
    process.stdout.write(`${JSON.stringify({
      ok: report.ok,
      counts: report.counts,
      failures: report.failures,
      jsonPath,
      markdownPath,
    })}\n`)
    if (!report.ok) process.exit(1)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
