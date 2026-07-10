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

test('envelope adapter rotates keys via kid + a previous-key ring (P2-1)', () => {
  const k1 = 'rotation-key-one-with-enough-entropy'
  const k2 = 'rotation-key-two-with-enough-entropy'

  const v1 = createEnvelopeSecretAdapter(k1)
  const cipher1 = v1.protect('secret-value', 'ctx')
  assert.equal(v1.reveal(cipher1, 'ctx'), 'secret-value')
  // New envelopes carry a kid.
  const envelope1 = JSON.parse(Buffer.from(cipher1.slice(CLOUD_SECRET_ENVELOPE_PREFIX.length), 'base64url').toString('utf8'))
  assert.equal(typeof envelope1.kid, 'string')

  // Rotate: k2 is current, k1 retained in the ring.
  const v2 = createEnvelopeSecretAdapter(k2, [k1])
  assert.equal(v2.reveal(cipher1, 'ctx'), 'secret-value') // old ciphertext still decrypts (kid k1 in ring)
  const cipher2 = v2.protect('new-secret', 'ctx')
  assert.equal(v2.reveal(cipher2, 'ctx'), 'new-secret') // new ciphertext sealed with k2

  // An adapter that dropped k1 cannot read the old ciphertext — and never silently uses the wrong key.
  assert.throws(() => createEnvelopeSecretAdapter(k2).reveal(cipher1, 'ctx'), /No cloud secret key available for kid/)
})

test('envelope adapter fails closed on a no-kid envelope (no legacy trial-decrypt) (P2-1)', () => {
  const k1 = 'legacy-key-one-with-enough-entropy'
  const k2 = 'legacy-key-two-with-enough-entropy'

  // Forge a pre-kid envelope: encrypt with k1, then strip the kid the adapter always stamps.
  const sealed = createEnvelopeSecretAdapter(k1).protect('legacy-secret')
  const envelope = JSON.parse(Buffer.from(sealed.slice(CLOUD_SECRET_ENVELOPE_PREFIX.length), 'base64url').toString('utf8'))
  delete envelope.kid
  const legacyCipher = CLOUD_SECRET_ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')

  // A no-kid envelope is rejected; there is no back-compat trial-decrypt.
  assert.throws(() => createEnvelopeSecretAdapter(k2, [k1]).reveal(legacyCipher), /missing a key id/)
})

test('createCloudSecretAdapterFromEnv loads previous keys for rotation (P2-1)', async () => {
  const k1 = 'env-rotation-key-one-with-entropy'
  const k2 = 'env-rotation-key-two-with-entropy'
  const cipher1 = createEnvelopeSecretAdapter(k1).protect('env-secret', 'ctx')

  const adapter = await createCloudSecretAdapterFromEnv({
    OPEN_COWORK_CLOUD_SECRET_KEY: k2,
    OPEN_COWORK_CLOUD_SECRET_KEY_PREVIOUS: k1,
  })
  assert.equal(adapter.reveal(cipher1, 'ctx'), 'env-secret')
})

test('AWS Secrets Manager ref rejects a region that would redirect the SigV4 host (P2)', async () => {
  await assert.rejects(
    () => resolveCloudSecretRef('aws-sm://my/secret?region=evil.com/%3F', { env: {} }),
    /region must be a valid region name/,
  )
  // A well-formed region still gets past the region check (then fails later for missing creds).
  await assert.rejects(
    () => resolveCloudSecretRef('aws-sm://my/secret?region=us-east-1', { env: {} }),
    /require AWS credentials/,
  )
})
