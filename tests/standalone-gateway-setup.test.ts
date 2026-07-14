import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function runSetup(args: string[]) {
  return spawnSync(process.execPath, ['scripts/standalone-gateway-setup.mjs', ...args], {
    encoding: 'utf8',
  })
}

test('standalone gateway setup writes deployable env without echoing secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-standalone-setup-'))
  const output = join(dir, '.env.standalone-gateway')
  try {
    const result = runSetup([
      '--admin-token', 'gateway-admin-token',
      '--telegram-bot-token', 'telegram-bot-token',
      '--opencode-url', 'http://127.0.0.1:4096',
      '--runtime-root', '/var/lib/open-cowork/standalone-gateway',
      '--output', output,
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Wrote .* mode 0600/)
    assert.match(result.stdout, /pnpm --filter @open-cowork\/standalone-gateway doctor/)
    assert.doesNotMatch(result.stdout, /gateway-admin-token/)
    assert.doesNotMatch(result.stdout, /telegram-bot-token/)
    const outputFd = openSync(output, 'r')
    let env = ''
    try {
      assert.equal((fstatSync(outputFd).mode & 0o777), 0o600)
      env = readFileSync(outputFd, 'utf8')
    } finally {
      closeSync(outputFd)
    }
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN=gateway-admin-token/)
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN=telegram-bot-token/)
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS=false/)
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS=/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone gateway setup refuses public OpenCode URLs', () => {
  const result = runSetup([
    '--admin-token', 'gateway-admin-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--opencode-url', 'https://opencode.example.test',
    '--runtime-root', '/var/lib/open-cowork/standalone-gateway',
    '--output', '.env.standalone-gateway',
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must point at loopback or private network OpenCode/)
})

test('standalone gateway setup validates literal IPv4 and IPv6 before private-range classification', () => {
  for (const url of [
    'http://127.1.2.3:4096',
    'http://10.0.0.1:4096',
    'http://172.31.0.1:4096',
    'http://192.168.1.1:4096',
    'http://100.64.0.1:4096',
    'http://[::1]:4096',
    'http://[fd00::1]:4096',
    'http://[fe80::1]:4096',
    'http://[::ffff:127.0.0.1]:4096',
    'http://[::ffff:10.0.0.1]:4096',
  ]) {
    const result = runSetup(['--opencode-url', url, '--print'])
    assert.equal(result.status, 0, `${url}: ${result.stderr}`)
  }

  for (const url of [
    'https://127.attacker.example',
    'https://10.attacker.example',
    'https://192.168.attacker.example',
    'https://fc-attacker.example',
    'https://[::ffff:8.8.8.8]',
  ]) {
    const result = runSetup(['--opencode-url', url, '--print'])
    assert.notEqual(result.status, 0, url)
    assert.match(result.stderr, /must point at loopback or private network OpenCode/)
  }
})

test('standalone gateway setup refuses to print provided secrets by default', () => {
  const result = runSetup([
    '--admin-token', 'gateway-admin-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--print',
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Refusing to print secret arguments/)
})
