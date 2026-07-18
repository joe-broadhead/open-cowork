#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const imageRef = process.env.IMAGE_REF
if (!imageRef) {
  console.error('IMAGE_REF is required')
  process.exit(1)
}

const readToken = randomBytes(32).toString('hex')
const operatorToken = randomBytes(32).toString('hex')
const adminToken = randomBytes(32).toString('hex')
const volumeName = `opencode-gateway-smoke-${randomBytes(8).toString('hex')}`
let containerId = ''
let volumeCreated = false

try {
  run('docker', ['volume', 'create', volumeName])
  volumeCreated = true
  assertConfigVolumeWritable(volumeName)

  containerId = run('docker', [
    'run',
    '-d',
    '-p',
    '127.0.0.1::4097',
    '--mount',
    `type=volume,src=${volumeName},dst=/home/nonroot/.config/opencode-gateway`,
    '-e',
    'GATEWAY_HTTP_HOST=0.0.0.0',
    '-e',
    'GATEWAY_HTTP_PORT=4097',
    '-e',
    'OPENCODE_GATEWAY_ALLOW_NON_LOCAL_HTTP=true',
    '-e',
    `OPENCODE_GATEWAY_HTTP_READ_TOKEN=${readToken}`,
    '-e',
    `OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN=${operatorToken}`,
    '-e',
    `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN=${adminToken}`,
    '-e',
    'OPENCODE_GATEWAY_URL=http://127.0.0.1:4096',
    imageRef,
  ]).trim()

  const port = dockerPort(containerId)
  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl)

  const unauth = await request(`${baseUrl}/tasks`)
  if (unauth.status !== 401 && unauth.status !== 403) {
    throw new Error(`unauthenticated task list returned ${unauth.status}: ${unauth.body}`)
  }

  const readPost = await request(`${baseUrl}/tasks`, {
    method: 'POST',
    token: readToken,
    body: { title: 'read token must not mutate' },
  })
  if (readPost.status !== 403) {
    throw new Error(`read token mutation returned ${readPost.status}: ${readPost.body}`)
  }

  const operatorPost = await request(`${baseUrl}/tasks`, {
    method: 'POST',
    token: operatorToken,
    body: { title: 'docker auth smoke' },
  })
  if (operatorPost.status !== 200) {
    throw new Error(`operator task creation returned ${operatorPost.status}: ${operatorPost.body}`)
  }

  const shutdown = await request(`${baseUrl}/shutdown`, {
    method: 'POST',
    token: adminToken,
    body: {},
  })
  if (shutdown.status !== 200) {
    throw new Error(`admin shutdown returned ${shutdown.status}: ${shutdown.body}`)
  }

  spawnSync('docker', ['wait', containerId], { encoding: 'utf-8' })
} catch (error) {
  if (containerId) {
    const logs = spawnSync('docker', ['logs', containerId], { encoding: 'utf-8' })
    if (logs.stdout) process.stderr.write(logs.stdout)
    if (logs.stderr) process.stderr.write(logs.stderr)
  }
  console.error(error?.message || String(error))
  process.exitCode = 1
} finally {
  if (containerId) spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf-8' })
  if (volumeCreated) spawnSync('docker', ['volume', 'rm', '-f', volumeName], { encoding: 'utf-8' })
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf-8' })
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`)
  }
  return result.stdout
}

function dockerPort(containerId) {
  const output = run('docker', ['port', containerId, '4097/tcp']).trim()
  const first = output.split(/\r?\n/)[0] || ''
  const port = first.split(':').pop()
  if (!port) throw new Error(`could not resolve mapped Docker port from: ${output}`)
  return port
}

function assertConfigVolumeWritable(volumeName) {
  run('docker', [
    'run',
    '--rm',
    '--mount',
    `type=volume,src=${volumeName},dst=/home/nonroot/.config/opencode-gateway`,
    imageRef,
    '-e',
    [
      "const fs = require('node:fs')",
      "const file = '/home/nonroot/.config/opencode-gateway/smoke-write'",
      "fs.writeFileSync(file, 'ok')",
      "if (fs.readFileSync(file, 'utf8') !== 'ok') process.exit(2)",
    ].join('; '),
  ])
}

async function waitForHealth(baseUrl) {
  let last
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      last = await request(`${baseUrl}/health`, { token: readToken })
    } catch (error) {
      last = { status: 0, body: error?.message || String(error) }
    }
    if (last.status === 200) return
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`health did not become ready: ${last?.status} ${last?.body || ''}`)
}

async function request(url, options = {}) {
  const headers = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  let body
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body,
  })
  return {
    status: response.status,
    body: await response.text(),
  }
}
