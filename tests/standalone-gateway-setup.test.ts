import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
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
      '--output', output,
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Wrote .* mode 0600/)
    assert.match(result.stdout, /pnpm --filter @open-cowork\/standalone-gateway doctor/)
    assert.doesNotMatch(result.stdout, /gateway-admin-token/)
    assert.doesNotMatch(result.stdout, /telegram-bot-token/)
    assert.equal((statSync(output).mode & 0o777), 0o600)
    const env = readFileSync(output, 'utf8')
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN=gateway-admin-token/)
    assert.match(env, /OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN=telegram-bot-token/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('standalone gateway setup refuses public OpenCode URLs', () => {
  const result = runSetup([
    '--admin-token', 'gateway-admin-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--opencode-url', 'https://opencode.example.test',
    '--output', '.env.standalone-gateway',
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must point at loopback or private network OpenCode/)
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
