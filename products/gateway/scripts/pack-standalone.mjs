#!/usr/bin/env node
/**
 * Build a standalone-installable cowork-gateway tarball from the monorepo.
 *
 * Workspace deps such as `@open-cowork/shared` are vendored under
 * `vendor/` and rewritten to `file:` dependencies so `npm install` of the
 * packed tarball works outside the pnpm workspace (JOE-914 smoke / release pack).
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
const sharedRoot = path.join(monorepoRoot, 'packages/shared')
const packDestination = path.resolve(process.argv[2] || path.join(productRoot, 'artifacts/pack'))

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
const sharedPkg = JSON.parse(fs.readFileSync(path.join(sharedRoot, 'package.json'), 'utf8'))

// Ensure shared + gateway dist exist.
run('pnpm', ['--filter', '@open-cowork/shared', 'build'], { cwd: monorepoRoot })
run('pnpm', ['--filter', 'cowork-gateway', 'build'], { cwd: monorepoRoot })

if (!fs.existsSync(path.join(sharedRoot, 'dist/index.js'))) {
  fail('packages/shared dist/index.js missing after build')
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
  const vendorRel = 'vendor/@open-cowork/shared'
  if (deps['@open-cowork/shared']) {
    const vendorAbs = path.join(stageRoot, vendorRel)
    fs.mkdirSync(vendorAbs, { recursive: true })
    copyDir(path.join(sharedRoot, 'dist'), path.join(vendorAbs, 'dist'))
    // Minimal package manifest for the vendored shared package.
    const vendorManifest = {
      name: sharedPkg.name,
      version: sharedPkg.version,
      private: true,
      type: sharedPkg.type || 'module',
      main: sharedPkg.main,
      types: sharedPkg.types,
      exports: sharedPkg.exports,
      files: ['dist'],
      license: sharedPkg.license || 'MIT',
      sideEffects: false,
    }
    fs.writeFileSync(path.join(vendorAbs, 'package.json'), `${JSON.stringify(vendorManifest, null, 2)}\n`)
    deps['@open-cowork/shared'] = `file:./${vendorRel}`
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
