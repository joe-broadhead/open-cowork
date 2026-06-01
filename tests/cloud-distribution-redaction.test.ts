import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeForExport } from '../apps/desktop/src/main/log-sanitizer.ts'
import { sanitizeCloudObservabilityAttributes } from '../apps/desktop/src/main/cloud/observability.ts'
import { redactGatewayConfig, resolveGatewayConfig } from '../apps/gateway/dist/config.js'

test('cloud and gateway distribution diagnostics redact secrets, signed URLs, and local paths', () => {
  const rawByok = ['sk', 'distributionsecretvalue1234567890abcdef123456'].join('-')
  const gatewayToken = ['ocgw', 'distribution_secret_token_1234567890'].join('_')
  const telegramToken = ['123456', 'telegram-secret-token-abcdefghijklmnopqrstuvwxyz'].join(':')
  const objectStoreSecret = ['object-store-secret', 'abcdefghijklmnopqrstuvwxyz'].join('-')
  const signedUrlSecret = ['object-store-url', 'secret'].join('-')
  const bundle = [
    `OPEN_COWORK_GATEWAY_SERVICE_TOKEN=${gatewayToken}`,
    `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `OPEN_COWORK_CLOUD_OBJECT_STORE_SECRET_ACCESS_KEY=${objectStoreSecret}`,
    `OPEN_COWORK_CLOUD_BYOK=${rawByok}`,
    'artifact=https://bucket.s3.amazonaws.com/private/output.txt?X-Amz-Signature=abcdef&X-Amz-Credential=secret',
    'workspace=/Users/alice/acme-private-project',
    'linuxWorkspace=/home/bob/customer-repo',
  ].join('\n')

  const redactedBundle = sanitizeForExport(bundle)
  for (const forbidden of [
    rawByok,
    gatewayToken,
    telegramToken,
    objectStoreSecret,
    'X-Amz-Signature=abcdef',
    'alice',
    'acme-private-project',
    'bob',
    'customer-repo',
  ]) {
    assert.equal(redactedBundle.includes(forbidden), false, `diagnostics leaked ${forbidden}`)
  }
  assert.match(redactedBundle, /\[REDACTED_TOKEN\]/)
  assert.match(redactedBundle, /\[REDACTED_QUERY\]/)
  assert.match(redactedBundle, /\[REDACTED_HOME\]/)

  const gatewayConfig = resolveGatewayConfig({
    server: {
      adminToken: 'distribution-redaction-admin-token',
    },
    providers: [{
      id: 'telegram',
      kind: 'telegram',
      channelBindingId: 'telegram',
      credentials: {
        botToken: telegramToken,
      },
      settings: {
        deliveryUrl: `https://object-store.example.test/private/file.txt?token=${signedUrlSecret}`,
        localPath: '/Users/alice/acme-private-project',
      },
    }],
  }, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: gatewayToken,
  })
  const gatewayDiagnostics = JSON.stringify(redactGatewayConfig(gatewayConfig))
  assert.equal(gatewayDiagnostics.includes(gatewayToken), false)
  assert.equal(gatewayDiagnostics.includes(telegramToken), false)
  assert.equal(gatewayDiagnostics.includes(signedUrlSecret), false)
  assert.equal(gatewayDiagnostics.includes('acme-private-project'), false)

  assert.deepEqual(sanitizeCloudObservabilityAttributes({
    token: gatewayToken,
    object_store_url: 'https://bucket.s3.amazonaws.com/private/output.txt?X-Amz-Signature=abcdef',
    local_path: '/home/bob/customer-repo',
  }), {
    token: '[redacted]',
    object_store_url: 'https://bucket.s3.amazonaws.com/private/output.txt?[redacted]',
    local_path: '/home/[redacted]',
  })
})
