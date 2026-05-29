#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsVenv = join(repoRoot, '.venv-docs')
const requirementsPath = join(repoRoot, 'docs', 'requirements.txt')
const command = process.argv[2] || 'build'
const passthroughArgs = process.argv.slice(3)

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
    if (commandWorks(candidate, args)) return candidate
  }
  throw new Error('Python 3 is required to build docs. Set DOCS_PYTHON to an explicit Python executable if it is not on PATH.')
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
  if (!existsSync(venvPython)) {
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
runMkdocs()
