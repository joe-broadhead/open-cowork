#!/usr/bin/env node
/**
 * Build a standalone-installable cowork-gateway tarball from the monorepo.
 *
 * Workspace deps such as `@open-cowork/shared` (and JOE-994 Telegram stack
 * packages) are vendored under `vendor/` and rewritten to `file:` dependencies
 * so `npm install` of the packed tarball works outside the pnpm workspace
 * (JOE-914 smoke / release pack).
 *
 * Usage:
 *   node products/gateway/scripts/pack-standalone.mjs [pack-destination-dir]
 * Prints the absolute tarball path on the last stdout line.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const monorepoRoot = path.resolve(productRoot, '../..')
const packagesRoot = path.join(monorepoRoot, 'packages')
const packDestination = path.resolve(process.argv[2] || path.join(productRoot, 'artifacts/pack'))

/** Private workspace packages Durable Gateway may compose (JOE-994 Phase 2+). */
const WORKSPACE_VENDOR_PACKAGES = [
  { name: '@open-cowork/shared', dir: 'shared' },
  { name: '@open-cowork/gateway-channel', dir: 'gateway-channel' },
  { name: '@open-cowork/gateway-provider-webhook', dir: 'gateway-provider-webhook' },
  { name: '@open-cowork/gateway-provider-telegram', dir: 'gateway-provider-telegram' },
  { name: '@open-cowork/gateway-provider-discord', dir: 'gateway-provider-discord' },
  { name: '@open-cowork/gateway-provider-whatsapp', dir: 'gateway-provider-whatsapp' },
]

function fail(message) {
  console.error(`[gateway-pack-standalone] ${message}`)
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

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

const pkg = JSON.parse(fs.readFileSync(path.join(productRoot, 'package.json'), 'utf8'))

// Build monorepo channel stack then Durable Gateway dist.
run('pnpm', ['--filter', '@open-cowork/gateway-provider-telegram', 'build'], { cwd: monorepoRoot })
run('pnpm', ['--filter', '@open-cowork/gateway-provider-discord', 'build'], { cwd: monorepoRoot })
run('pnpm', ['--filter', '@open-cowork/gateway-provider-whatsapp', 'build'], { cwd: monorepoRoot })
run('pnpm', ['--filter', 'cowork-gateway', 'build'], { cwd: monorepoRoot })

for (const entry of WORKSPACE_VENDOR_PACKAGES) {
  const distIndex = path.join(packagesRoot, entry.dir, 'dist/index.js')
  if (!fs.existsSync(distIndex)) {
    fail(`packages/${entry.dir} dist/index.js missing after build`)
  }
}
if (!fs.existsSync(path.join(productRoot, 'dist/cli.js'))) {
  fail('products/gateway dist/cli.js missing after build')
}

const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-gateway-pack-stage-'))
try {
  // Copy allowlisted package contents into staging.
  const allow = Array.isArray(pkg.files) ? pkg.files : ['dist/', 'bin/']
  for (const entry of allow) {
    const rel = entry.replace(/\/$/, '')
    const src = path.join(productRoot, rel)
    if (!fs.existsSync(src)) continue
    const dest = path.join(stageRoot, rel)
    if (fs.statSync(src).isDirectory()) copyDir(src, dest)
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }
  }
  for (const rootFile of ['package.json', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'README.md', 'mkdocs.yml']) {
    const src = path.join(productRoot, rootFile)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stageRoot, rootFile))
  }

  // Vendor private workspace packages declared as workspace:*.
  const stagedPkg = JSON.parse(fs.readFileSync(path.join(stageRoot, 'package.json'), 'utf8'))
  const deps = { ...(stagedPkg.dependencies || {}) }

  for (const entry of WORKSPACE_VENDOR_PACKAGES) {
    if (!deps[entry.name]) continue
    const packageRoot = path.join(packagesRoot, entry.dir)
    const sourcePkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    const vendorRel = `vendor/${entry.name}`
    const vendorAbs = path.join(stageRoot, vendorRel)
    fs.mkdirSync(vendorAbs, { recursive: true })
    copyDir(path.join(packageRoot, 'dist'), path.join(vendorAbs, 'dist'))

    // Nested workspace deps inside the vendored package also point at sibling vendors.
    const nestedDeps = { ...(sourcePkg.dependencies || {}) }
    for (const nested of WORKSPACE_VENDOR_PACKAGES) {
      if (nestedDeps[nested.name]) {
        nestedDeps[nested.name] = `file:../${nested.name}`
      }
    }

    const vendorManifest = {
      name: sourcePkg.name,
      version: sourcePkg.version,
      private: true,
      type: sourcePkg.type || 'module',
      main: sourcePkg.main,
      types: sourcePkg.types,
      exports: sourcePkg.exports,
      files: ['dist'],
      license: sourcePkg.license || 'MIT',
      sideEffects: sourcePkg.sideEffects ?? false,
      dependencies: nestedDeps,
    }
    fs.writeFileSync(path.join(vendorAbs, 'package.json'), `${JSON.stringify(vendorManifest, null, 2)}\n`)
    deps[entry.name] = `file:./${vendorRel}`
  }

  // Drop monorepo-only scripts that would re-run tsc without workspace context.
  const scripts = { ...(stagedPkg.scripts || {}) }
  delete scripts.prepack
  delete scripts.prepare

  const files = Array.isArray(stagedPkg.files) ? [...stagedPkg.files] : []
  if (!files.includes('vendor/')) files.push('vendor/')

  const nextPkg = {
    ...stagedPkg,
    dependencies: deps,
    scripts,
    files,
  }
  // Prefer not shipping monorepo dev tooling metadata into the install tree.
  delete nextPkg.devDependencies
  fs.writeFileSync(path.join(stageRoot, 'package.json'), `${JSON.stringify(nextPkg, null, 2)}\n`)

  fs.mkdirSync(packDestination, { recursive: true })
  const pack = run('npm', ['pack', '--pack-destination', packDestination], { cwd: stageRoot })
  const lines = (pack.stdout || '').trim().split('\n').filter(Boolean)
  const filename = lines[lines.length - 1]
  if (!filename?.endsWith('.tgz')) fail(`npm pack did not report a tarball: ${pack.stdout}`)
  const tarballPath = path.join(packDestination, filename)
  if (!fs.existsSync(tarballPath)) fail(`tarball missing after pack: ${tarballPath}`)
  console.log(tarballPath)
} finally {
  fs.rmSync(stageRoot, { recursive: true, force: true })
}
