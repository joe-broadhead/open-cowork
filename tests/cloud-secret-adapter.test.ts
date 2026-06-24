import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLOUD_SECRET_ENVELOPE_PREFIX,
  CLOUD_SECRET_PLAINTEXT_PREFIX,
  createCloudSecretAdapterFromEnv,
  createEnvelopeSecretAdapter,
  createEnvSecretAdapter,
  createPlaintextSecretAdapter,
  createUnavailableSecretAdapter,
  resolveCloudSecretRef,
  validateCloudSecretKeyMaterial,
  type CloudSecretStoreHttpClient,
} from '@open-cowork/cloud-server/secret-adapter'

test('cloud envelope secret adapter encrypts and decrypts with context binding', () => {
  const adapter = createEnvelopeSecretAdapter('test-key-material')
  const stored = adapter.protect('sk-test', 'tenant-1:openai')

  assert.equal(stored.startsWith(CLOUD_SECRET_ENVELOPE_PREFIX), true)
  assert.equal(adapter.reveal(stored, 'tenant-1:openai'), 'sk-test')
  assert.throws(() => adapter.reveal(stored, 'tenant-2:openai'))
})

test('cloud secret key validation rejects weak production envelope material', () => {
  for (const weak of [
    '',
    'short-secret',
    'change-me-for-local-dev-change-me',
    'x'.repeat(32),
    'abcd'.repeat(12),
    '0123456789abcdefghijklmnopqrstuvwxyz',
  ]) {
    assert.equal(validateCloudSecretKeyMaterial(weak).valid, false, weak)
  }

  const strong = 'K7p9Qw2Lm4Vz8Rx6Tu3Na5Yh1Bc0FgDsJkAePiRoUqW'
  assert.equal(validateCloudSecretKeyMaterial(strong).valid, true)
})

test('cloud plaintext secret adapter keeps an explicit non-encrypted envelope', () => {
  const adapter = createPlaintextSecretAdapter()
  const stored = adapter.protect('local-dev-secret')

  assert.equal(stored.startsWith(CLOUD_SECRET_PLAINTEXT_PREFIX), true)
  assert.equal(adapter.reveal(stored), 'local-dev-secret')
})

test('cloud env secret adapter fails closed when no key is configured', () => {
  const adapter = createEnvSecretAdapter('OPEN_COWORK_TEST_SECRET_KEY', {})

  assert.equal(adapter.mode, 'unavailable')
  assert.throws(() => adapter.protect('secret'), /not configured/)
})

test('cloud secret adapter can load envelope key material from env refs', async () => {
  const adapter = await createCloudSecretAdapterFromEnv({
    OPEN_COWORK_CLOUD_SECRET_KEY_REF: 'env:OPEN_COWORK_TEST_REMOTE_SECRET',
    OPEN_COWORK_TEST_REMOTE_SECRET: 'remote-key-material',
  })
  const stored = adapter.protect('sk-test', 'tenant-1')

  assert.equal(stored.startsWith(CLOUD_SECRET_ENVELOPE_PREFIX), true)
  assert.equal(adapter.reveal(stored, 'tenant-1'), 'sk-test')
})

test('cloud secret adapter rejects weak env or ref keys when production validation is required', async () => {
  await assert.rejects(
    () => createCloudSecretAdapterFromEnv({
      OPEN_COWORK_CLOUD_SECRET_KEY: 'x'.repeat(32),
    }, { requireStrongKeyMaterial: true }),
    /too weak/,
  )

  await assert.rejects(
    () => createCloudSecretAdapterFromEnv({
      OPEN_COWORK_CLOUD_SECRET_KEY_REF: 'env:WEAK_REMOTE',
      WEAK_REMOTE: 'change-me-for-local-dev-change-me',
    }, { requireStrongKeyMaterial: true }),
    /too weak/,
  )
})

test('cloud secret refs resolve GCP Secret Manager payloads', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudSecretStoreHttpClient>[1] }> = []
  const fetcher: CloudSecretStoreHttpClient = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          payload: {
            data: Buffer.from('gcp-key-material').toString('base64'),
          },
        }
      },
    }
  }

  assert.equal(await resolveCloudSecretRef(
    'gcp-sm://projects/project-1/secrets/open-cowork/versions/latest',
    {
      fetch: fetcher,
      gcpAccessTokenProvider: () => 'gcp-token',
    },
  ), 'gcp-key-material')
  assert.equal(requests[0]?.url, 'https://secretmanager.googleapis.com/v1/projects/project-1/secrets/open-cowork/versions/latest:access')
  assert.equal(requests[0]?.init?.headers?.authorization, 'Bearer gcp-token')
})

test('cloud secret refs resolve Azure Key Vault payloads', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudSecretStoreHttpClient>[1] }> = []
  const fetcher: CloudSecretStoreHttpClient = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return { value: 'azure-key-material' }
      },
    }
  }

  assert.equal(await resolveCloudSecretRef(
    'azure-kv://open-cowork-vault/secrets/cloud-secret/v1',
    {
      fetch: fetcher,
      azureAccessTokenProvider: () => 'azure-token',
    },
  ), 'azure-key-material')
  assert.equal(requests[0]?.url, 'https://open-cowork-vault.vault.azure.net/secrets/cloud-secret/v1?api-version=7.4')
  assert.equal(requests[0]?.init?.headers?.authorization, 'Bearer azure-token')
})

test('cloud secret refs only send Azure tokens to Azure Key Vault secret URLs', async () => {
  let tokenRequested = false
  const fetcher: CloudSecretStoreHttpClient = async () => {
    throw new Error('fetch should not be called for invalid Azure refs')
  }

  for (const ref of [
    'https://attacker.example.test/secrets/cloud-secret',
    'https://vault-name.vault.azure.net.evil.example/secrets/cloud-secret',
    'https://token@vault-name.vault.azure.net/secrets/cloud-secret',
    'https://vault-name.vault.azure.net/keys/cloud-secret',
    'https://vault-name.vault.azure.net/secrets/cloud-secret?redirect=https://attacker.example.test',
    'azure-kv://token@vault-name/secrets/cloud-secret',
    'azure-kv://vault-name/secrets/cloud-secret?redirect=https://attacker.example.test',
    'azure-kv://vault-name/secrets/cloud-secret#fragment',
  ]) {
    await assert.rejects(
      () => resolveCloudSecretRef(ref, {
        fetch: fetcher,
        azureAccessTokenProvider: () => {
          tokenRequested = true
          return 'azure-token'
        },
      }),
      /Azure Key Vault/,
      ref,
    )
  }

  assert.equal(tokenRequested, false)
})

test('cloud secret refs resolve AWS Secrets Manager payloads with signed requests', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudSecretStoreHttpClient>[1] }> = []
  const fetcher: CloudSecretStoreHttpClient = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return { SecretString: 'aws-key-material' }
      },
    }
  }

  assert.equal(await resolveCloudSecretRef('aws-sm://open-cowork/cloud-secret?region=us-east-1', {
    fetch: fetcher,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    awsCredentialsProvider: () => ({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'aws-secret-key',
      sessionToken: 'session-token',
    }),
  }), 'aws-key-material')

  assert.equal(requests[0]?.url, 'https://secretsmanager.us-east-1.amazonaws.com/')
  assert.match(requests[0]?.init?.headers?.authorization || '', /AWS4-HMAC-SHA256 Credential=AKIA_TEST\/20260101\/us-east-1\/secretsmanager\/aws4_request/)
  assert.equal(requests[0]?.init?.headers?.['x-amz-target'], 'secretsmanager.GetSecretValue')
  assert.equal(requests[0]?.init?.headers?.['x-amz-security-token'], 'session-token')
  assert.equal(requests[0]?.init?.body, JSON.stringify({ SecretId: 'open-cowork/cloud-secret' }))
})

test('cloud unavailable secret adapter rejects all operations', () => {
  const adapter = createUnavailableSecretAdapter('no store')

  assert.throws(() => adapter.protect('secret'), /no store/)
  assert.throws(() => adapter.reveal('secret'), /no store/)
})
