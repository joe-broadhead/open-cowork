import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

function runSetup(args: string[]) {
  return spawnSync(process.execPath, ['scripts/gateway-appliance-setup.mjs', ...args], {
    encoding: 'utf8',
  })
}

test('gateway appliance setup renders remote Telegram polling env', () => {
  const result = runSetup([
    '--mode', 'remote',
    '--cloud-url', 'https://cloud.example.test',
    '--service-token', 'gateway-service-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--print',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OPEN_COWORK_CLOUD_BASE_URL=https:\/\/cloud\.example\.test/)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_SERVICE_TOKEN=gateway-service-token/)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel/)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_TELEGRAM_MODE=polling/)
  assert.match(result.stdout, /docker-compose\.gateway-remote\.yml/)
})

test('gateway appliance setup requires HTTPS public URL and admin token for Telegram webhook', () => {
  const missingAdmin = runSetup([
    '--mode', 'remote',
    '--cloud-url', 'https://cloud.example.test',
    '--service-token', 'gateway-service-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--telegram-mode', 'webhook',
    '--telegram-webhook-secret', 'telegram-webhook-secret',
    '--public-url', 'https://gateway.example.test',
    '--print',
  ])
  assert.notEqual(missingAdmin.status, 0)
  assert.match(missingAdmin.stderr, /--admin-token is required/)

  const insecure = runSetup([
    '--mode', 'remote',
    '--cloud-url', 'https://cloud.example.test',
    '--service-token', 'gateway-service-token',
    '--telegram-bot-token', 'telegram-bot-token',
    '--telegram-mode', 'webhook',
    '--telegram-webhook-secret', 'telegram-webhook-secret',
    '--public-url', 'http://gateway.example.test',
    '--admin-token', 'gateway-admin-token',
    '--print',
  ])
  assert.notEqual(insecure.status, 0)
  assert.match(insecure.stderr, /must be HTTPS/)
})

test('gateway appliance setup renders local all-in-one env without commercial billing inputs', () => {
  const result = runSetup([
    '--mode', 'local',
    '--provider', 'fake',
    '--print',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OPEN_COWORK_CLOUD_BASE_URL=http:\/\/open-cowork-cloud:8787/)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true/)
  assert.match(result.stdout, /docker-compose\.cloud-gateway\.yml/)
  assert.doesNotMatch(result.stdout, /stripe/i)
})

test('gateway appliance setup scopes Telegram webhook validation to Telegram provider', () => {
  const result = runSetup([
    '--mode', 'local',
    '--provider', 'fake',
    '--telegram-mode', 'webhook',
    '--print',
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true/)
  assert.match(result.stdout, /OPEN_COWORK_GATEWAY_HOST=127\.0\.0\.1/)
})
