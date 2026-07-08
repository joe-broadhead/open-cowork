#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsVenv = join(repoRoot, '.venv-docs')
const requirementsPath = join(repoRoot, 'docs', 'requirements.txt')
const command = process.argv[2] || 'build'
const passthroughArgs = process.argv.slice(3)
const MIN_DOCS_PYTHON = { major: 3, minor: 11 }

function log(message) {
  process.stdout.write(`[docs] ${message}\n`)
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  })
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'ignore' })
  return result.status === 0
}

function pythonVersion(command, pyLauncher = false) {
  const args = pyLauncher
    ? ['-3', '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']
    : ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) return null
  const match = String(result.stdout || '').trim().match(/^(\d+)\.(\d+)$/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function pythonMeetsMinimum(version) {
  if (!version) return false
  if (version.major > MIN_DOCS_PYTHON.major) return true
  return version.major === MIN_DOCS_PYTHON.major && version.minor >= MIN_DOCS_PYTHON.minor
}

function assertPythonMeetsMinimum(command, pyLauncher = false, label = command) {
  const version = pythonVersion(command, pyLauncher)
  if (!pythonMeetsMinimum(version)) {
    throw new Error(`${label} must be Python ${MIN_DOCS_PYTHON.major}.${MIN_DOCS_PYTHON.minor}+ to build docs; found ${version ? `${version.major}.${version.minor}` : 'unknown'}.`)
  }
  return version
}

function findPython() {
  const configured = process.env.DOCS_PYTHON || process.env.PYTHON
  const candidates = [
    configured,
    process.platform === 'win32' ? 'py' : null,
    'python3',
    'python',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const args = candidate === 'py' ? ['-3', '--version'] : ['--version']
    if (commandWorks(candidate, args) && pythonMeetsMinimum(pythonVersion(candidate, candidate === 'py'))) return candidate
  }
  throw new Error(`Python ${MIN_DOCS_PYTHON.major}.${MIN_DOCS_PYTHON.minor}+ is required to build docs. Set DOCS_PYTHON to an explicit Python executable if it is not on PATH.`)
}

function venvPythonPath() {
  return process.platform === 'win32'
    ? join(docsVenv, 'Scripts', 'python.exe')
    : join(docsVenv, 'bin', 'python')
}

function venvMkdocsPath() {
  return process.platform === 'win32'
    ? join(docsVenv, 'Scripts', 'mkdocs.exe')
    : join(docsVenv, 'bin', 'mkdocs')
}

function ensureVenv() {
  const python = findPython()
  const venvPython = venvPythonPath()
  if (existsSync(venvPython)) {
    try {
      assertPythonMeetsMinimum(venvPython, false, venvPython)
    } catch (error) {
      log(`${error instanceof Error ? error.message : String(error)} Recreating ${docsVenv}.`)
      rmSync(docsVenv, { recursive: true, force: true })
    }
  }
  if (!existsSync(venvPython)) {
    assertPythonMeetsMinimum(python, python === 'py')
    mkdirSync(docsVenv, { recursive: true })
    const args = python === 'py'
      ? ['-3', '-m', 'venv', docsVenv]
      : ['-m', 'venv', docsVenv]
    run(python, args)
  }
}

function ensureRequirements() {
  const venvPython = venvPythonPath()
  run(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath])
}

function checkDocsVendorBundles() {
  run(process.execPath, ['scripts/build-docs-mermaid-vendor.mjs', '--check'])
}

function runMkdocs() {
  const mkdocs = venvMkdocsPath()
  if (command === 'build') {
    run(mkdocs, ['build', '--strict', ...passthroughArgs])
    return
  }
  if (command === 'serve') {
    run(mkdocs, ['serve', ...passthroughArgs])
    return
  }
  throw new Error(`Unsupported docs command "${command}". Use "build" or "serve".`)
}

ensureVenv()
ensureRequirements()
checkDocsVendorBundles()
runMkdocs()
