#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = readJson('package.json')

const requiredFiles = [
  'bin/opencode-gateway',
  'dist/cli.js',
  'dist/mcp.js',
]
if (pkg.bin?.['cowork-gateway']) requiredFiles.push('bin/cowork-gateway')

const missing = requiredFiles.filter(file => !fs.existsSync(path.join(root, file)))
if (missing.length) fail(`missing package runtime artifact(s): ${missing.join(', ')}; run npm run build before packaging`)

if (!Array.isArray(pkg.files) || !pkg.files.includes('dist/') || !pkg.files.includes('bin/')) {
  fail('package.json files allowlist must include dist/ and bin/')
}

for (const binName of ['opencode-gateway', 'cowork-gateway']) {
  const binRel = pkg.bin?.[binName]
  if (!binRel) continue
  const bin = fs.readFileSync(path.join(root, binRel), 'utf-8')
  if (!bin.startsWith('#!/usr/bin/env node')) fail(`${binRel} must keep the node shebang`)
  if (!bin.includes("import('../dist/cli.js')")) fail(`${binRel} must import the built dist/cli.js entrypoint`)
}

const version = spawnSync(process.execPath, ['dist/cli.js', '--version'], { cwd: root, encoding: 'utf-8' })
if (version.status !== 0) fail(`dist/cli.js --version failed: ${version.stderr || version.stdout}`)
if (version.stdout.trim() !== pkg.version) fail(`dist/cli.js reports ${version.stdout.trim() || '<empty>'}, expected ${pkg.version}`)

console.error('pack ready: dist entrypoints, bin wrapper, and version metadata are aligned')

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf-8'))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
