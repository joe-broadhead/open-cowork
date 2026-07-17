#!/usr/bin/env node
/**
 * Download checksum-verified time-keep release binaries for packaging.
 *
 * Source: https://github.com/joe-broadhead/time-keep (public)
 * Pin: third_party/time-keep/VERSION
 *
 * Usage:
 *   node scripts/fetch-time-keep-binaries.mjs
 *   node scripts/fetch-time-keep-binaries.mjs --platform darwin-arm64
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const vendorRoot = join(repoRoot, 'third_party', 'time-keep')
const platformsRoot = join(vendorRoot, 'platforms')
const VERSION = readFileSync(join(vendorRoot, 'VERSION'), 'utf8').trim()
const REPO = 'joe-broadhead/time-keep'

/** @type {Record<string, { asset: string, binaryName: string }>} */
const PLATFORM_ASSETS = {
  'darwin-arm64': { asset: 'time-keep-macos-arm64', binaryName: 'time-keep' },
  'darwin-x64': { asset: 'time-keep-macos-x86_64', binaryName: 'time-keep' },
  'linux-x64': { asset: 'time-keep-linux-x86_64', binaryName: 'time-keep' },
  'win32-x64': { asset: 'time-keep-windows-x86_64', binaryName: 'time-keep.exe' },
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

function parseArgs(argv) {
  const only = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform' && argv[i + 1]) {
      only.push(argv[i + 1])
      i += 1
    }
  }
  return { only }
}

async function download(url, dest) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'open-cowork-fetch-time-keep' },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`)
  }
  await pipeline(response.body, createWriteStream(dest))
}

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function expectedShaFromFile(shaPath) {
  const text = readFileSync(shaPath, 'utf8').trim()
  const match = text.match(/^([a-f0-9]{64})\b/i)
  if (!match) throw new Error(`Unrecognized checksum file: ${text.slice(0, 80)}`)
  return match[1].toLowerCase()
}

function findBinary(root, binaryName) {
  const direct = join(root, binaryName)
  if (existsSync(direct)) return direct
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = join(root, entry.name, binaryName)
    if (existsSync(nested)) return nested
  }
  return null
}

async function fetchPlatform(key) {
  const spec = PLATFORM_ASSETS[key]
  if (!spec) throw new Error(`Unsupported platform key: ${key}. Supported: ${Object.keys(PLATFORM_ASSETS).join(', ')}`)

  const outDir = join(platformsRoot, key)
  const outBinary = join(outDir, spec.binaryName)
  const stampPath = join(outDir, '.version')
  if (existsSync(outBinary) && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === VERSION) {
    process.stdout.write(`[time-keep] cached ${key} ${VERSION}\n`)
    return outBinary
  }

  mkdirSync(outDir, { recursive: true })
  const tmpDir = join(outDir, '.tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  const tarName = `${spec.asset}.tar.gz`
  const shaName = `${spec.asset}.sha256`
  const baseUrl = `https://github.com/${REPO}/releases/download/${VERSION}`
  const tarPath = join(tmpDir, tarName)
  const shaPath = join(tmpDir, shaName)

  process.stdout.write(`[time-keep] downloading ${tarName} (${VERSION})\n`)
  await download(`${baseUrl}/${tarName}`, tarPath)
  await download(`${baseUrl}/${shaName}`, shaPath)

  const expected = expectedShaFromFile(shaPath)
  const actual = sha256File(tarPath)
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${tarName}: expected ${expected}, got ${actual}`)
  }

  execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir], { stdio: 'pipe' })

  const found = findBinary(tmpDir, spec.binaryName)
  if (!found) {
    throw new Error(`Could not find ${spec.binaryName} inside ${tarName}`)
  }

  renameSync(found, outBinary)
  if (process.platform !== 'win32') {
    chmodSync(outBinary, 0o755)
  }
  writeFileSync(stampPath, `${VERSION}\n`)
  rmSync(tmpDir, { recursive: true, force: true })
  process.stdout.write(`[time-keep] installed ${outBinary}\n`)
  return outBinary
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2))
  const keys = only.length > 0
    ? only
    : Object.keys(PLATFORM_ASSETS).filter((key) => {
      if (key === platformKey()) return true
      if (process.platform === 'darwin' && key.startsWith('darwin-')) return true
      if (process.platform === 'linux' && key.startsWith('linux-')) return true
      if (process.platform === 'win32' && key.startsWith('win32-')) return true
      return false
    })

  mkdirSync(platformsRoot, { recursive: true })
  for (const key of keys) {
    await fetchPlatform(key)
  }
}

main().catch((error) => {
  process.stderr.write(`[time-keep] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
