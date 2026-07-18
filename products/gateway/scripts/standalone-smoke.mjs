#!/usr/bin/env node
/**
 * Standalone install smoke for cowork-gateway (JOE-914).
 *
 * Packs (or uses a provided tarball), installs into a clean temp prefix
 * that is *not* the monorepo node_modules tree, then runs non-destructive
 * CLI checks. Fail closed on missing bins or wrong package name.
 *
 * Usage:
 *   node products/gateway/scripts/standalone-smoke.mjs
 *   node products/gateway/scripts/standalone-smoke.mjs /path/to/cowork-gateway-1.3.0.tgz
 *   GATEWAY_SMOKE_TARBALL=... node products/gateway/scripts/standalone-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const monorepoRoot = path.resolve(productRoot, '../..')
const providedTarball = process.argv[2] || process.env.GATEWAY_SMOKE_TARBALL

function fail(message) {
  console.error(`[gateway-standalone-smoke] ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
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

const pkg = JSON.parse(fs.readFileSync(path.join(productRoot, 'package.json'), 'utf8'))
if (pkg.name !== 'cowork-gateway' && pkg.name !== 'opencode-gateway') {
  fail(`unexpected package name ${pkg.name}`)
}
if (!pkg.bin?.['cowork-gateway'] && !pkg.bin?.['opencode-gateway']) {
  fail('package.json bin must include cowork-gateway or opencode-gateway')
}

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-gateway-standalone-smoke-'))
const installPrefix = path.join(smokeRoot, 'prefix')
const packDir = path.join(smokeRoot, 'pack')
fs.mkdirSync(installPrefix, { recursive: true })
fs.mkdirSync(packDir, { recursive: true })

let tarballPath
try {
  if (providedTarball) {
    tarballPath = path.resolve(providedTarball)
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`)
  } else {
    // Build + pack from monorepo product package.
    run('pnpm', ['--filter', 'cowork-gateway', 'build'], { cwd: monorepoRoot })
    const pack = run('npm', ['pack', '--pack-destination', packDir], { cwd: productRoot })
    const lines = (pack.stdout || '').trim().split('\n').filter(Boolean)
    const filename = lines[lines.length - 1]
    if (!filename?.endsWith('.tgz')) fail(`npm pack did not report a tarball: ${pack.stdout}`)
    tarballPath = path.join(packDir, filename)
  }

  const base = path.basename(tarballPath)
  if (!/^(cowork-gateway|opencode-gateway)-\d+\.\d+\.\d+.*\.tgz$/.test(base)) {
    fail(`tarball name must be cowork-gateway-*.tgz or opencode-gateway-*.tgz, got ${base}`)
  }

  // Clean consumer project (no monorepo workspace links).
  const consumer = path.join(smokeRoot, 'consumer')
  fs.mkdirSync(consumer, { recursive: true })
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'gateway-smoke-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
  )
  run('npm', ['install', '--prefix', consumer, tarballPath], { cwd: consumer })

  const binDir = path.join(consumer, 'node_modules', '.bin')
  const preferred = path.join(binDir, 'cowork-gateway')
  const legacy = path.join(binDir, 'opencode-gateway')
  const bin = fs.existsSync(preferred) ? preferred : legacy
  if (!fs.existsSync(bin)) {
    fail(`installed package missing CLI bin (looked for cowork-gateway and opencode-gateway under ${binDir})`)
  }

  const version = run(bin, ['--version'], { cwd: consumer })
  const reported = (version.stdout || '').trim()
  if (!reported.includes(pkg.version)) {
    fail(`--version reported "${reported}", expected to include ${pkg.version}`)
  }

  // doctor is non-destructive; may report degraded local state but must start.
  const doctor = spawnSync(bin, ['doctor'], {
    cwd: consumer,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      // Isolate config/state from the developer's real gateway home.
      OPENCODE_GATEWAY_CONFIG_DIR: path.join(smokeRoot, 'config'),
      HOME: path.join(smokeRoot, 'home'),
    },
  })
  if (doctor.status !== 0 && doctor.status !== 1) {
    // 0 = healthy, 1 = degraded/missing config is still a successful binary boot.
    fail(`doctor exited ${doctor.status}\n${doctor.stdout || ''}${doctor.stderr || ''}`)
  }

  // Prefer preferred bin name when package declares it.
  if (pkg.bin?.['cowork-gateway'] && !fs.existsSync(preferred)) {
    fail('package declares cowork-gateway bin but install did not create it')
  }

  console.log(`[gateway-standalone-smoke] ok — ${base} installed; ${path.basename(bin)} --version=${reported}`)
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true })
}
