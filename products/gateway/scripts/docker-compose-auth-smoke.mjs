#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const imageRef = process.env.IMAGE_REF || 'opencode-gateway:local'
const composeImage = 'opencode-gateway:local'
const project = `ogw-compose-smoke-${randomBytes(5).toString('hex')}`
const smokeRoot = path.join(homedir(), '.cache', 'opencode-gateway-compose-smoke')
mkdirSync(smokeRoot, { recursive: true, mode: 0o700 })
const secretDir = mkdtempSync(path.join(smokeRoot, 'secrets-'))
const readToken = randomBytes(32).toString('hex')
const operatorToken = randomBytes(32).toString('hex')
const adminToken = randomBytes(32).toString('hex')

const env = {
  ...process.env,
  OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE: path.join(secretDir, 'read-token'),
  OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE: path.join(secretDir, 'operator-token'),
  OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: path.join(secretDir, 'admin-token'),
}

try {
  writeFileSync(env.OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE, `${readToken}\n`, { mode: 0o600 })
  writeFileSync(env.OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE, `${operatorToken}\n`, { mode: 0o600 })
  writeFileSync(env.OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE, `${adminToken}\n`, { mode: 0o600 })
  if (imageRef !== composeImage) run('docker', ['tag', imageRef, composeImage])
  run('docker', ['compose', '-p', project, '-f', 'docker/docker-compose.yml', 'config', '--quiet'], { env })
  run('docker', ['compose', '-p', project, '-f', 'docker/docker-compose.yml', 'up', '-d', 'gateway'], { env })
  const containerId = run('docker', ['compose', '-p', project, '-f', 'docker/docker-compose.yml', 'ps', '-q', 'gateway'], { env }).trim()
  if (!containerId) throw new Error('compose gateway container was not created')
  const health = waitForHealthy(containerId)
  if (health !== 'healthy') {
    const logs = spawnSync('docker', ['logs', containerId], { encoding: 'utf-8' })
    if (logs.stdout) process.stderr.write(logs.stdout)
    if (logs.stderr) process.stderr.write(logs.stderr)
    throw new Error(`compose gateway healthcheck ended ${health}`)
  }
  console.log(`compose gateway health: ${health}`)
} catch (error) {
  console.error(error?.message || String(error))
  process.exitCode = 1
} finally {
  spawnSync('docker', ['compose', '-p', project, '-f', 'docker/docker-compose.yml', 'down', '-v'], { encoding: 'utf-8', env })
  rmSync(secretDir, { recursive: true, force: true })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options })
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`)
  }
  return result.stdout
}

function waitForHealthy(containerId) {
  const deadline = Date.now() + 90_000
  let last = 'unknown'
  while (Date.now() < deadline) {
    last = run('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId]).trim()
    if (last === 'healthy') return last
    if (last === 'unhealthy' || last === 'exited' || last === 'dead') return last
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  return last
}
