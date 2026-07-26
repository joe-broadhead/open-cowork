import {
  FileGatewayWorkspaceCredentialStore,
  GatewayWorkspaceCredentialStoreError,
} from '../apps/desktop/src/main/gateway-workspace-credentials.ts'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

function withCredentialPath(
  prefix: string,
  run: (path: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const path = join(root, 'gateway-workspace-credentials.json')
  try {
    run(path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('gateway credential ciphertext survives transient decrypt failure and later recovers', () => {
  withCredentialPath('open-cowork-gateway-credential-decrypt-', (path) => {
    let decryptAvailable = true
    const secretStorage = {
      mode: 'encrypted' as const,
      encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        if (!decryptAvailable) throw new Error('simulated keychain denial')
        return encrypted.toString('utf8')
      },
    }
    const store = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })
    store.save({ workspaceId: 'gateway-1', token: 'original-token' })
    const originalCiphertext = readFileSync(path)

    decryptAvailable = false
    assert.deepEqual(store.getToken('gateway-1'), {
      status: 'unavailable',
      reason: 'decrypt-failed',
    })
    assert.deepEqual(readFileSync(path), originalCiphertext)
    assert.throws(
      () => store.save({ workspaceId: 'gateway-1', token: 'replacement-token' }),
      GatewayWorkspaceCredentialStoreError,
    )
    assert.deepEqual(readFileSync(path), originalCiphertext)

    decryptAvailable = true
    const recovered = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })
    const recoveredToken = recovered.getToken('gateway-1')
    assert.equal(recoveredToken.status, 'available')
    if (recoveredToken.status === 'available') {
      assert.equal(recoveredToken.token, 'original-token')
      assert.equal(Number.isFinite(Date.parse(recoveredToken.updatedAt)), true)
    }
  })
})

test('gateway credential store reports unavailable secure storage without touching bytes', () => {
  withCredentialPath('open-cowork-gateway-credential-unavailable-', (path) => {
    const ciphertext = Buffer.from('opaque-ciphertext')
    writeFileSync(path, ciphertext)
    const store = new FileGatewayWorkspaceCredentialStore({
      path,
      secretStorage: {
        mode: 'unavailable',
        encryptString: () => {
          throw new Error('must not encrypt')
        },
        decryptString: () => {
          throw new Error('must not decrypt')
        },
      },
    })

    assert.deepEqual(store.getToken('gateway-1'), {
      status: 'unavailable',
      reason: 'secure-storage-unavailable',
    })
    assert.deepEqual(store.clear('gateway-1'), {
      status: 'unavailable',
      reason: 'secure-storage-unavailable',
    })
    assert.deepEqual(readFileSync(path), ciphertext)
  })
})

test('confirmed unreadable reset quarantines ciphertext after permanent key loss', () => {
  withCredentialPath('open-cowork-gateway-credential-lost-key-reset-', (path) => {
    let keyAvailable = true
    const secretStorage = {
      mode: 'encrypted' as const,
      encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted: Buffer) => {
        if (!keyAvailable) throw new Error('simulated permanently lost key')
        return encrypted.toString('utf8')
      },
    }
    const store = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })
    store.save({ workspaceId: 'gateway-1', token: 'original-token' })
    const originalCiphertext = readFileSync(path)
    keyAvailable = false

    assert.deepEqual(store.getToken('gateway-1'), {
      status: 'unavailable',
      reason: 'decrypt-failed',
    })
    assert.deepEqual(readFileSync(path), originalCiphertext)
    assert.deepEqual(store.resetUnreadable(), { status: 'reset' })
    assert.equal(existsSync(path), false)
    const quarantined = readdirSync(dirname(path))
      .filter((entry) => entry.startsWith('gateway-workspace-credentials.json.corrupt-'))
    assert.equal(quarantined.length, 1)
    assert.deepEqual(readFileSync(join(dirname(path), quarantined[0]!)), originalCiphertext)
  })
})

test('gateway credential store preserves corrupt payloads and metadata for explicit recovery', () => {
  withCredentialPath('open-cowork-gateway-credential-corrupt-', (path) => {
    const secretStorage = {
      mode: 'encrypted' as const,
      encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
    }
    for (const [payload, reason] of [
      ['not-json', 'invalid-payload'],
      [JSON.stringify([{ workspaceId: 'gateway-1', token: '', updatedAt: 'invalid' }]), 'invalid-record'],
    ] as const) {
      writeFileSync(path, payload)
      const originalCiphertext = readFileSync(path)
      const store = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })

      assert.deepEqual(store.getToken('gateway-1'), { status: 'corrupt', reason })
      assert.deepEqual(store.clear('gateway-1'), { status: 'corrupt', reason })
      assert.throws(
        () => store.save({ workspaceId: 'gateway-1', token: 'replacement-token' }),
        GatewayWorkspaceCredentialStoreError,
      )
      assert.deepEqual(readFileSync(path), originalCiphertext)
    }
  })
})

test('gateway credential unreadable reset quarantines original bytes only after explicit invocation', () => {
  withCredentialPath('open-cowork-gateway-credential-reset-', (path) => {
    const corruptCiphertext = Buffer.from('decrypted-but-invalid-json')
    writeFileSync(path, corruptCiphertext)
    const secretStorage = {
      mode: 'encrypted' as const,
      encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
    }
    const store = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })

    assert.deepEqual(store.getToken('gateway-1'), {
      status: 'corrupt',
      reason: 'invalid-payload',
    })
    assert.deepEqual(readFileSync(path), corruptCiphertext)

    assert.deepEqual(store.resetUnreadable(), { status: 'reset' })
    assert.equal(existsSync(path), false)
    const quarantineDirectory = dirname(path)
    const quarantineFiles = readdirSync(quarantineDirectory)
      .filter((entry) => entry.startsWith('gateway-workspace-credentials.json.corrupt-'))
    assert.equal(quarantineFiles.length, 1)
    assert.deepEqual(
      readFileSync(join(quarantineDirectory, quarantineFiles[0]!)),
      corruptCiphertext,
    )
    assert.deepEqual(store.getToken('gateway-1'), { status: 'missing' })

    store.save({ workspaceId: 'gateway-1', token: 'replacement-token' })
    const replacement = store.getToken('gateway-1')
    assert.equal(replacement.status, 'available')
    if (replacement.status === 'available') {
      assert.equal(replacement.token, 'replacement-token')
    }
  })
})

test('gateway credential replacement is atomic and clear is explicit', () => {
  withCredentialPath('open-cowork-gateway-credential-atomic-', (path) => {
    let encryptionAvailable = true
    const secretStorage = {
      mode: 'encrypted' as const,
      encryptString: (plaintext: string) => {
        if (!encryptionAvailable) throw new Error('simulated encryption failure')
        return Buffer.from(plaintext, 'utf8')
      },
      decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
    }
    const store = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })
    store.save({ workspaceId: 'gateway-1', token: 'original-token' })
    const originalCiphertext = readFileSync(path)
    assert.deepEqual(store.resetUnreadable(), { status: 'readable' })
    assert.deepEqual(readFileSync(path), originalCiphertext)

    encryptionAvailable = false
    assert.throws(
      () => store.save({ workspaceId: 'gateway-1', token: 'replacement-token' }),
      /simulated encryption failure/,
    )
    assert.deepEqual(readFileSync(path), originalCiphertext)

    encryptionAvailable = true
    store.save({ workspaceId: 'gateway-1', token: 'replacement-token' })
    const restarted = new FileGatewayWorkspaceCredentialStore({ path, secretStorage })
    const replacement = restarted.getToken('gateway-1')
    assert.equal(replacement.status, 'available')
    if (replacement.status === 'available') assert.equal(replacement.token, 'replacement-token')

    assert.deepEqual(restarted.clear('gateway-1'), { status: 'cleared' })
    assert.deepEqual(
      new FileGatewayWorkspaceCredentialStore({ path, secretStorage }).getToken('gateway-1'),
      { status: 'missing' },
    )
  })
})
