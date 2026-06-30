#!/usr/bin/env node
// Fast startup smoke for the cloud production bundle (no docker, no postgres).
//
// The bundle (apps/desktop/dist/cloud/open-cowork-cloud.mjs) is built with
// esbuild `packages:'external'`, so it keeps bare imports (ajv, pg, @aws-sdk/...)
// that Node resolves by walking node_modules up from dist/cloud. Under pnpm's
// isolated layout those deps are unreachable unless public-hoisted (.npmrc), so a
// regression there crashes the bundle at import with ERR_MODULE_NOT_FOUND. This
// boots the bundle in the all-in-one role (sqlite control plane — no external
// services), waits for the "open-cowork-cloud role=" ready line that only prints
// AFTER every module imports and startCloudApp resolves, then shuts it down.
// It fails fast on any module-resolution error or a pre-ready exit.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
const READY = 'open-cowork-cloud role='
const BOOT_TIMEOUT_MS = 30_000
const SHUTDOWN_GRACE_MS = 5_000

if (!existsSync(bundle)) {
  process.stderr.write(`[cloud-smoke] bundle not found at ${bundle}; run \`pnpm cloud:build\` first.\n`)
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'cloud-smoke-root-'))
const data = mkdtempSync(join(tmpdir(), 'cloud-smoke-data-'))
const cleanup = () => {
  for (const dir of [root, data]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// The all-in-one bundle uses node:sqlite, which on the pinned Node 22.x requires
// --experimental-sqlite (it is stable + flag-free only on Node 23.4+). Pass it so
// the smoke matches how the bundle must be launched on the supported runtime.
const child = spawn(process.execPath, ['--experimental-sqlite', bundle], {
  cwd: repoRoot,
  env: {
    ...process.env,
    OPEN_COWORK_CLOUD_ROOT: root,
    OPEN_COWORK_DATA_DIR: data,
    // all-in-one role on a sqlite control plane: boots with no external services.
    OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH: 'true',
    OPEN_COWORK_CLOUD_HOST: '127.0.0.1',
    OPEN_COWORK_CLOUD_PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
let settled = false

const bootTimer = setTimeout(() => {
  finish(false, `bundle did not print "${READY}" within ${BOOT_TIMEOUT_MS}ms`)
}, BOOT_TIMEOUT_MS)

function finish(ok, message) {
  if (settled) return
  settled = true
  clearTimeout(bootTimer)
  if (ok) {
    process.stdout.write('[cloud-smoke] OK: cloud bundle booted — all externals resolved, app started.\n')
    // We passed; shut the child down (SIGTERM -> graceful exit) then hard-kill if needed.
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const grace = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ }; cleanup(); process.exit(0) }, SHUTDOWN_GRACE_MS)
    grace.unref()
    child.once('exit', () => { clearTimeout(grace); cleanup(); process.exit(0) })
    return
  }
  process.stderr.write(`[cloud-smoke] FAIL: ${message}\n`)
  if (output.trim()) process.stderr.write(`--- bundle output ---\n${output.trim()}\n`)
  try { child.kill('SIGKILL') } catch { /* gone */ }
  cleanup()
  process.exit(1)
}

function onData(buf) {
  output += buf.toString()
  if (/ERR_MODULE_NOT_FOUND|Cannot find package|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(output)) {
    finish(false, 'bundle hit a module-resolution error (a cloud external is not resolvable from dist/cloud)')
    return
  }
  if (output.includes(READY)) finish(true)
}

child.stdout.on('data', onData)
child.stderr.on('data', onData)
child.on('error', (err) => finish(false, `failed to spawn the bundle: ${err.message}`))
child.on('exit', (code, signal) => {
  if (!settled) finish(false, `bundle exited (code ${code}, signal ${signal}) before printing "${READY}"`)
})
