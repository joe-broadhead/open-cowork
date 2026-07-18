#!/usr/bin/env node
/**
 * Standalone install smoke for Wiki CLI (JOE-914).
 *
 * Builds the packed CLI (or uses a provided tarball), installs into a clean
 * temp consumer project (no monorepo node_modules), then runs non-destructive
 * checks. Fail closed on missing bins.
 *
 * Usage:
 *   node products/wiki/scripts/standalone-smoke.mjs
 *   node products/wiki/scripts/standalone-smoke.mjs /path/to/openwiki-cli-0.0.0.tgz
 *   WIKI_SMOKE_TARBALL=... node products/wiki/scripts/standalone-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const monorepoRoot = path.resolve(productRoot, '../..')
const providedTarball = process.argv[2] || process.env.WIKI_SMOKE_TARBALL

function fail(message) {
  console.error(`[wiki-standalone-smoke] ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed (exit ${result.status})\n`
      + `${result.stdout || ''}${result.stderr || ''}`,
    )
  }
  return result
}

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-wiki-standalone-smoke-'))

let tarballPath
try {
  if (providedTarball) {
    tarballPath = path.resolve(providedTarball)
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`)
  } else {
    run('pnpm', ['--filter', 'cowork-wiki-workspace', 'pack:cli'], { cwd: monorepoRoot })
    const artifacts = path.join(productRoot, 'artifacts', 'npm')
    if (!fs.existsSync(artifacts)) fail(`pack:cli did not create ${artifacts}`)
    const tgz = fs.readdirSync(artifacts).filter((name) => name.endsWith('.tgz')).sort()
    if (!tgz.length) fail(`no .tgz under ${artifacts}`)
    tarballPath = path.join(artifacts, tgz[tgz.length - 1])
  }

  const consumer = path.join(smokeRoot, 'consumer')
  fs.mkdirSync(consumer, { recursive: true })
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'wiki-smoke-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
  )
  run('npm', ['install', '--prefix', consumer, tarballPath], { cwd: consumer })

  const binDir = path.join(consumer, 'node_modules', '.bin')
  const preferred = path.join(binDir, 'cowork-wiki')
  const legacy = path.join(binDir, 'openwiki')
  const bin = fs.existsSync(preferred) ? preferred : legacy
  if (!fs.existsSync(bin)) {
    fail(`installed package missing CLI bin (looked for cowork-wiki and openwiki under ${binDir})`)
  }

  // Prefer dual-bin when present in package.json of the installed package.
  const installedPkgPath = path.join(consumer, 'node_modules', '@openwiki', 'cli', 'package.json')
  if (fs.existsSync(installedPkgPath)) {
    const installed = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'))
    if (installed.bin?.['cowork-wiki'] && !fs.existsSync(preferred)) {
      fail('packaged CLI declares cowork-wiki but install did not create the bin')
    }
  }

  const help = run(bin, ['--help'], { cwd: consumer })
  if (!(help.stdout || '').toLowerCase().includes('openwiki') && !(help.stdout || '').toLowerCase().includes('wiki')) {
    fail(`--help output did not look like the Wiki CLI:\n${help.stdout}`)
  }

  // Prefer --version when supported; fall back to help-only if version is absent.
  const versionResult = spawnSync(bin, ['--version'], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (versionResult.status === 0) {
    console.log(`[wiki-standalone-smoke] version: ${(versionResult.stdout || '').trim()}`)
  }

  const wikiRoot = path.join(smokeRoot, 'wiki-root')
  // setup personal is the lightest non-destructive create path used by packaged smoke.
  const setup = spawnSync(bin, ['setup', 'personal', wikiRoot, '--agent', 'none', '--json'], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (setup.status !== 0) {
    fail(`setup personal failed (exit ${setup.status})\n${setup.stdout || ''}${setup.stderr || ''}`)
  }
  if (!fs.existsSync(wikiRoot)) fail('setup did not create wiki root')

  console.log(`[wiki-standalone-smoke] ok — ${path.basename(tarballPath)} installed; bin=${path.basename(bin)}`)
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true })
}
