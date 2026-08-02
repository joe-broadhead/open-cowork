import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserCoworkApi, createCloudTranscriptProjector, createTransport } from './cowork-api.ts'
import { useSessionStore } from '../stores/session.ts'

// Regression coverage for the CSRF P0: the browser shim must fetch the
// double-submit CSRF token from /auth/me and attach it as x-csrf-token on every
// mutation, or an authenticated cookie/OIDC cloud rejects all mutations 403.

type FetchCall = { url: string; method: string; headers: Record<string, string> }

function jsonResponse(body: unknown, status = 200) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (body ?? null),
    text: async () => text,
  } as unknown as Response
}

function installFetch(handler: (url: string, method: string) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const method = init?.method || 'GET'
    calls.push({ url: String(url), method, headers: { ...(init?.headers || {}) } })
    return handler(String(url), method)
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser shim CSRF transport', () => {
  it('fetches the token from /auth/me and attaches x-csrf-token on a mutation', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/auth/me') ? jsonResponse({ csrfToken: 'tok-123' }) : jsonResponse({ ok: true }),
    )
    const transport = createTransport({})

    await transport.request('/api/sessions', { method: 'POST', body: { name: 'x' } })

    expect(calls.some((c) => c.url.endsWith('/auth/me') && c.method === 'GET')).toBe(true)
    const mutation = calls.find((c) => c.method === 'POST')
    expect(mutation?.headers['x-csrf-token']).toBe('tok-123')
  })

  it('uses a bootstrap-supplied token without an extra /auth/me round-trip', async () => {
    const calls = installFetch(() => jsonResponse({ ok: true }))
    const transport = createTransport({ csrfToken: 'boot-tok' })

    await transport.request('/api/settings', { method: 'POST', body: {} })

    expect(calls.some((c) => c.url.endsWith('/auth/me'))).toBe(false)
    expect(calls.find((c) => c.method === 'POST')?.headers['x-csrf-token']).toBe('boot-tok')
  })

  it('sends no CSRF header when auth=none returns a null token (and does not error)', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/auth/me') ? jsonResponse({ csrfToken: null }) : jsonResponse({ ok: true }),
    )
    const transport = createTransport({})

    await expect(transport.request('/api/settings', { method: 'POST', body: {} })).resolves.toEqual({ ok: true })
    expect(calls.find((c) => c.method === 'POST')?.headers['x-csrf-token']).toBeUndefined()
  })

  it('refetches the token and retries once on a 403', async () => {
    let meCount = 0
    let postCount = 0
    const calls = installFetch((url) => {
      if (url.endsWith('/auth/me')) {
        meCount += 1
        return jsonResponse({ csrfToken: `tok-${meCount}` })
      }
      postCount += 1
      return postCount === 1 ? jsonResponse({ error: 'csrf' }, 403) : jsonResponse({ ok: true })
    })
    const transport = createTransport({})

    await expect(transport.request('/api/sessions', { method: 'POST', body: {} })).resolves.toEqual({ ok: true })
    expect(postCount).toBe(2)
    expect(meCount).toBe(2)
    // the retry carries the freshly-refetched token
    const retried = calls.filter((c) => c.method === 'POST')
    expect(retried[1]?.headers['x-csrf-token']).toBe('tok-2')
  })

  it('does not prefetch /auth/me for GET requests', async () => {
    const calls = installFetch((url) =>
      url.endsWith('/auth/me') ? jsonResponse({ csrfToken: 'tok' }) : jsonResponse({ items: [] }),
    )
    const transport = createTransport({})

    await transport.request('/api/workspace', { method: 'GET' })

    expect(calls.some((c) => c.url.endsWith('/auth/me'))).toBe(false)
  })
})

describe('browser shim authentication bootstrap', () => {
  it('fails closed to an auth-required public config when protected config returns 401', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/api/config')) return jsonResponse({ error: 'Cloud authentication is required.' }, 401)
      return jsonResponse({})
    })

    const api = createBrowserCoworkApi({ authRequired: true })
    const config = await api.app.config()

    expect(config.auth).toEqual({ mode: 'google-oauth', enabled: true })
    expect(config.branding.name).toBe('Open Cowork')
    expect(calls.map((call) => call.url)).toEqual(['/api/config'])
  })

  it('does not probe protected config after auth status establishes a signed-out browser', async () => {
    const calls = installFetch((url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ error: 'Cloud authentication is required.' }, 401)
      if (url.endsWith('/api/config')) throw new Error('protected config must not be requested while signed out')
      return jsonResponse({})
    })

    const api = createBrowserCoworkApi({ authRequired: true })

    await expect(api.auth.status()).resolves.toEqual({ authenticated: false, email: null })
    await expect(api.app.config()).resolves.toMatchObject({
      auth: { mode: 'google-oauth', enabled: true },
      branding: { name: 'Open Cowork' },
    })
    expect(calls.map((call) => call.url)).toEqual(['/auth/me'])
  })

  it('does not hide non-auth config failures behind a fabricated default config', async () => {
    installFetch((url) => {
      if (url.endsWith('/api/config')) return jsonResponse({ error: 'unavailable' }, 503)
      return jsonResponse({})
    })

    const api = createBrowserCoworkApi({ authRequired: true })

    await expect(api.app.config()).rejects.toMatchObject({ message: 'unavailable', status: 503 })
  })
})

describe('browser shim runtime health', () => {
  it('identifies the browser surface and propagates runtime endpoint failures', async () => {
    installFetch((url) => (
      url.endsWith('/api/runtime/status')
        ? jsonResponse({ error: 'runtime unavailable' }, 503)
        : jsonResponse({})
    ))

    const api = createBrowserCoworkApi({})

    await expect(api.app.metadata()).resolves.toEqual({
      version: '0.0.0',
      preview: false,
      surface: 'browser',
    })
    await expect(api.runtime.status()).rejects.toMatchObject({
      message: 'runtime unavailable',
      status: 503,
    })
  })
})

describe('browser shim workflow credential rotation', () => {
  it('posts to the Cloud rotation endpoint and returns the one-time reveal', async () => {
    const mutation = {
      workflow: {
        id: 'workflow/one',
        webhookUrl: 'https://cowork.example.test/webhooks/workflows/workflow%2Fone',
      },
      webhookSecretReveal: {
        workflowId: 'workflow/one',
        triggerId: 'webhook',
        secret: 'one-time-secret',
      },
    }
    const calls = installFetch((url) => (
      url.endsWith('/auth/me')
        ? jsonResponse({ csrfToken: null })
        : jsonResponse(mutation)
    ))

    const result = await createBrowserCoworkApi({}).workflows.regenerateWebhookSecret('workflow/one')

    expect(result).toEqual(mutation)
    expect(calls.some((call) => (
      call.url === '/api/workflows/workflow%2Fone/rotate-webhook-secret'
      && call.method === 'POST'
    ))).toBe(true)
  })
})

// Direct artifact upload: the shim must take the provider-enforced multipart POST path when the
// cloud advertises it (begin -> direct POST -> finalize), and preserve the buffered fallback.

type RecordedCall = { url: string; method: string; headers: Record<string, string>; body: unknown }

function installRecordingFetch(handler: (url: string, method: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = []
  const mock = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const method = init?.method || 'GET'
    let body: unknown = init?.body
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url: String(url), method, headers: { ...(init?.headers || {}) }, body })
    return handler(String(url), method)
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

describe('browser shim presigned artifact upload', () => {
  const uploadRequest = { sessionId: 's1', filename: 'f.txt', contentType: 'text/plain', dataBase64: btoa('hello') }

  it('sends an idempotency id and checksum, then uses multipart POST before finalize', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000001'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: {
              key: 'staging/art-1',
              policy: 'signed-policy',
              'Content-Type': 'text/plain',
            },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') return jsonResponse(undefined, 204)
      if (url.endsWith(`/artifacts/${artifactId}/finalize`)) return jsonResponse({ artifact: { id: artifactId, filename: 'f.txt', cloudArtifactId: artifactId, size: 5 } })
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload must not run when presigned succeeds')
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)
    expect(result.id).toBe(artifactId)

    const begin = calls.find((c) => c.url.includes('/artifacts?transfer=presigned'))
    expect(begin?.body).toEqual({
      filename: 'f.txt',
      contentType: 'text/plain',
      expectedSize: 5,
      artifactId,
      checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      kind: null,
      status: null,
      authorAgentId: null,
      projectId: null,
      taskId: null,
      statusUpdatedBy: null,
      statusUpdatedAt: null,
    })

    // Browser-managed multipart framing carries the signed fields verbatim and the raw file last.
    const post = calls.find((c) => c.url === 'https://object-store.test/' && c.method === 'POST')
    expect(post?.headers['content-type']).toBeUndefined()
    expect(post?.body).toBeInstanceOf(FormData)
    const form = post?.body as FormData
    expect(form.get('key')).toBe('staging/art-1')
    expect(form.get('policy')).toBe('signed-policy')
    expect(form.get('Content-Type')).toBe('text/plain')
    const file = form.get('file') as File
    expect(file.name).toBe('f.txt')
    expect(file.type).toBe('text/plain')
    expect(await file.text()).toBe('hello')

    // Finalize recorded the metadata; the buffered collection POST was never used.
    expect(calls.some((c) => c.url.endsWith(`/artifacts/${artifactId}/finalize`) && c.method === 'POST')).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/artifacts') && c.method === 'POST')).toBe(false)
  })

  it('retries finalization with the same artifact identity after a committed response is lost', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000005'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    let finalizeAttempts = 0
    let committed = false
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: { key: 'staging/art-5', policy: 'signed-policy' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') return jsonResponse(undefined, 204)
      if (url.endsWith(`/artifacts/${artifactId}/finalize`)) {
        finalizeAttempts += 1
        if (finalizeAttempts === 1) {
          committed = true
          throw new TypeError('connection closed after commit')
        }
        return jsonResponse({ artifact: { id: artifactId, filename: 'f.txt', cloudArtifactId: artifactId, size: 5 } })
      }
      if (url.includes('/sessions/s1/artifacts?limit=100') && method === 'GET') {
        return jsonResponse({
          artifacts: committed
            ? [{ id: artifactId, filename: 'f.txt', cloudArtifactId: artifactId, size: 5 }]
            : [],
        })
      }
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)

    expect(result.id).toBe(artifactId)
    expect(finalizeAttempts).toBe(1)
    expect(calls.filter((call) => call.url.includes('/sessions/s1/artifacts?limit=100'))).toHaveLength(1)
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}`) && call.method === 'GET')).toBe(false)
  })

  it('retries a concurrent finalization conflict without minting another upload', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000006'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    let finalizeAttempts = 0
    const calls = installRecordingFetch((url) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: { key: 'staging/art-6', policy: 'signed-policy' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') return jsonResponse(undefined, 204)
      if (url.endsWith(`/artifacts/${artifactId}/finalize`)) {
        finalizeAttempts += 1
        if (finalizeAttempts === 1) return jsonResponse({ error: 'Artifact upload finalization is already in progress.' }, 409)
        return jsonResponse({ artifact: { id: artifactId, filename: 'f.txt', cloudArtifactId: artifactId, size: 5 } })
      }
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)

    expect(result.id).toBe(artifactId)
    expect(finalizeAttempts).toBe(2)
    expect(calls.filter((call) => call.url.includes('/artifacts?transfer=presigned'))).toHaveLength(1)
    expect(calls.filter((call) => call.url === 'https://object-store.test/')).toHaveLength(1)
  })

  it('waits through a multi-second finalization claim without changing upload identity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
    try {
      const artifactId = '00000000-0000-4000-8000-000000000007'
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
      let finalizeAttempts = 0
      const calls = installRecordingFetch((url) => {
        if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
        if (url.includes('/artifacts?transfer=presigned')) {
          return jsonResponse({
            upload: {
              transfer: 'presigned',
              artifactId,
              uploadUrl: 'https://object-store.test/',
              uploadMethod: 'POST',
              uploadFields: { key: 'staging/art-7', policy: 'signed-policy' },
              uploadExpiresAt: '2026-08-02T12:05:00.000Z',
            },
          })
        }
        if (url === 'https://object-store.test/') return jsonResponse(undefined, 204)
        if (url.endsWith(`/artifacts/${artifactId}/finalize`)) {
          finalizeAttempts += 1
          if (finalizeAttempts < 7) return jsonResponse({ error: 'Artifact upload finalization is already in progress.' }, 409)
          return jsonResponse({ artifact: { id: artifactId, filename: 'f.txt', cloudArtifactId: artifactId, size: 5 } })
        }
        return jsonResponse({})
      })

      const uploaded = createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)
      // Let WebCrypto and the mocked fetch chain reach the first finalize call
      // before draining retry timers. Otherwise a fast runAllTimersAsync can
      // observe an empty timer queue and return before the retry is scheduled.
      await vi.waitFor(() => expect(finalizeAttempts).toBe(1))
      await vi.runAllTimersAsync()
      const result = await uploaded

      expect(result.id).toBe(artifactId)
      expect(finalizeAttempts).toBe(7)
      expect(calls.filter((call) => call.url.includes('/artifacts?transfer=presigned'))).toHaveLength(1)
      expect(calls.filter((call) => call.url === 'https://object-store.test/')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the buffered upload without decode, hashing, or negotiation when direct upload is not advertised', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) throw new Error('default-off uploads must not negotiate direct transfer')
      if (url.endsWith('/artifacts') && method === 'POST') return jsonResponse({ artifact: { id: 'buffered-1', filename: 'f.txt' } })
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({ artifactDirectUpload: false }).artifact.upload({
      ...uploadRequest,
      dataBase64: 'YWFh'.repeat(1024 * 1024),
    })
    expect(result.id).toBe('buffered-1')

    expect(digest).not.toHaveBeenCalled()
    expect(calls.some((call) => call.url.includes('/artifacts?transfer=presigned'))).toBe(false)
    expect(calls.some((c) => c.url.startsWith('https://object-store.test'))).toBe(false)
    const buffered = calls.find((c) => c.url.endsWith('/artifacts') && c.method === 'POST')
    expect((buffered?.body as { dataBase64?: string })?.dataBase64).toHaveLength(4 * 1024 * 1024)
  })

  it('routes an empty payload through buffered validation without requesting an upload URL', async () => {
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) throw new Error('empty uploads must not request direct transfer')
      if (url.endsWith('/artifacts') && method === 'POST') return jsonResponse({ error: 'Artifact dataBase64 is required.' }, 400)
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload({
      ...uploadRequest,
      dataBase64: '',
    })).rejects.toMatchObject({
      message: 'Artifact dataBase64 is required.',
      status: 400,
    })
    expect(calls.some((call) => call.url.includes('/artifacts?transfer=presigned'))).toBe(false)
    const buffered = calls.find((call) => call.url.endsWith('/artifacts') && call.method === 'POST')
    expect((buffered?.body as { dataBase64?: string })?.dataBase64).toBe('')
  })

  it('attempts cleanup and propagates presigned begin failures without buffered fallback', async () => {
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) return jsonResponse({ error: 'upload service unavailable' }, 503)
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload must not hide begin failures')
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)).rejects.toMatchObject({
      message: 'upload service unavailable',
      status: 503,
    })
    expect(calls.some((call) => call.url.endsWith('/artifacts') && call.method === 'POST')).toBe(false)
    const begin = calls.find((call) => call.url.includes('/artifacts?transfer=presigned'))
    const artifactId = (begin?.body as { artifactId?: string })?.artifactId
    expect(artifactId).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))).toBe(true)
  })

  it('falls back before reservation when direct-upload readiness becomes unsupported', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000009'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({ upload: { transfer: 'unsupported' } })
      }
      if (url.endsWith('/artifacts') && method === 'POST') {
        return jsonResponse({ artifact: { id: 'buffered-after-readiness-drift', filename: 'f.txt' } })
      }
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) throw new Error('unsupported transfer has no reservation to abort')
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)

    expect(result.id).toBe('buffered-after-readiness-drift')
    expect(calls.some((call) => call.url.endsWith('/artifacts') && call.method === 'POST')).toBe(true)
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))).toBe(false)
  })

  it('fails closed when an unsupported response is polluted with reservation data', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000010'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'unsupported',
            artifactId,
            uploadUrl: 'https://object-store.test/',
          },
        })
      }
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) {
        return jsonResponse({ upload: { outcome: 'cleanup_pending' } })
      }
      if (url.endsWith('/artifacts') && method === 'POST') {
        throw new Error('polluted unsupported response must not trigger buffered upload')
      }
      return jsonResponse({})
    })

    await expect(
      createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest),
    ).rejects.toThrow(/invalid credential contract/i)
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/artifacts') && call.method === 'POST')).toBe(false)
  })

  it('aborts and surfaces a retryable error when the direct POST may have committed', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000002'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: { key: 'staging/art-1', policy: 'signed-policy' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') return jsonResponse({ error: 'denied' }, 403)
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) return jsonResponse({ upload: { outcome: 'aborted' } })
      if (url.endsWith(`/artifacts/${artifactId}/finalize`)) throw new Error('finalize must not run when the POST failed')
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload would double-charge the reservation')
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)).rejects.toThrow(
      'Direct artifact upload failed before finalization',
    )
    expect(calls.some((c) => c.url.endsWith(`/artifacts/${artifactId}/finalize`))).toBe(false)
    expect(calls.some((c) => c.url.endsWith('/artifacts') && c.method === 'POST')).toBe(false)
    const directIndex = calls.findIndex((call) => call.url === 'https://object-store.test/')
    const abortIndex = calls.findIndex((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))
    expect(directIndex).toBeGreaterThan(-1)
    expect(abortIndex).toBeGreaterThan(directIndex)
    expect(calls[abortIndex]?.body).toEqual({ reason: 'direct_upload_failed' })
  })

  it('aborts and rejects when the server returns a malformed minted credential', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000003'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') throw new Error('malformed contract must not reach object storage')
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) return jsonResponse({ upload: { outcome: 'aborted' } })
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload would double-charge the reservation')
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)).rejects.toThrow(
      'invalid credential contract',
    )
    const abortIndex = calls.findIndex((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))
    const bufferedIndex = calls.findIndex((call) => call.url.endsWith('/artifacts') && call.method === 'POST')
    expect(calls.some((call) => call.url === 'https://object-store.test/')).toBe(false)
    expect(abortIndex).toBeGreaterThan(-1)
    expect(bufferedIndex).toBe(-1)
  })

  it('does not fall back after an unknown non-presigned direct-upload response', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000008'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'buffered',
            artifactId,
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: { key: 'staging/art-8', policy: 'signed-policy' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) return jsonResponse({ upload: { outcome: 'aborted' } })
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload would double-charge the reservation')
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)).rejects.toThrow(
      'invalid credential contract',
    )
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/artifacts') && call.method === 'POST')).toBe(false)
  })

  it('aborts and rejects a presigned response that changes the client idempotency identity', async () => {
    const artifactId = '00000000-0000-4000-8000-000000000004'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(artifactId)
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId: '00000000-0000-4000-8000-999999999999',
            uploadUrl: 'https://object-store.test/',
            uploadMethod: 'POST',
            uploadFields: { key: 'staging/other', policy: 'signed-policy' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/') throw new Error('mismatched identity must not reach object storage')
      if (url.endsWith(`/artifacts/${artifactId}/abort`)) return jsonResponse({ upload: { outcome: 'aborted' } })
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload would double-charge the reservation')
      return jsonResponse({})
    })

    await expect(createBrowserCoworkApi({ artifactDirectUpload: true }).artifact.upload(uploadRequest)).rejects.toThrow(
      'invalid credential contract',
    )
    expect(calls.some((call) => call.url === 'https://object-store.test/')).toBe(false)
    expect(calls.some((call) => call.url.endsWith(`/artifacts/${artifactId}/abort`))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/artifacts') && call.method === 'POST')).toBe(false)
  })
})

describe('browser shim workspace support', () => {
  function supportEntry(support: Awaited<ReturnType<ReturnType<typeof createBrowserCoworkApi>['workspace']['support']>>, api: string) {
    return support.find((entry) => entry.api === api)
  }

  it('reports cloud-web feature gates and browser-only limitations accurately', async () => {
    installRecordingFetch((url) => {
      if (url.endsWith('/api/config')) {
        return jsonResponse({
          features: {
            chat: false,
            artifacts: true,
            threadIndex: false,
            agents: false,
            customSkills: false,
            customMcps: false,
          },
        })
      }
      return jsonResponse({})
    })

    const support = await createBrowserCoworkApi({}).workspace.support()

    expect(supportEntry(support, 'sessions.create')?.status).toBe('blocked_by_policy')
    expect(supportEntry(support, 'sessions.create')?.verdict?.reason).toMatch(/chat is disabled/i)
    expect(supportEntry(support, 'sessions.fileSnippet')?.status).toBe('not_supported')
    expect(supportEntry(support, 'sessions.diff')?.status).toBe('not_supported')
    expect(supportEntry(support, 'localFiles')?.status).toBe('not_supported')
    expect(supportEntry(support, 'machineRuntimeConfig')?.status).toBe('not_supported')
    expect(supportEntry(support, 'threads.search')?.status).toBe('blocked_by_policy')
    expect(supportEntry(support, 'capabilities.catalog')?.status).toBe('blocked_by_policy')
    expect(supportEntry(support, 'artifacts.download')?.status).toBe('supported')
    expect(supportEntry(support, 'artifacts.reveal')?.status).toBe('not_supported')
    expect(supportEntry(support, 'artifacts.reveal')?.context?.artifacts.reveal).toBe('none')
  })
})

// Tranche H / PERF-2: cloud `assistant.message` SSE events route through the renderer's
// batched sessionPatch path (the same incremental session-view-reducer the desktop uses)
// so the transcript advances LIVE and folds many tokens into one reducer pass, rather than
// a full-view rebuild per event. The projector accumulates the deltas by PLAIN concat —
// identical to the cloud projection's append fold (reduceCloudSessionProjectionEvent) — and
// emits full-text REPLACE patches, so the rendered transcript is byte-identical to the
// canonical /view regardless of how deltas were chunked or coalesced upstream (PERF-1).

// The full SSE data envelope the per-session stream delivers:
// { sessionId, sequence, type, payload: { messageId, content, mode } }.
function sseRecord(messageId: string, content: string, sequence: number, mode?: 'append') {
  return {
    sessionId: 'ses_1',
    sequence,
    type: 'assistant.message',
    payload: { messageId, content, ...(mode ? { mode } : {}) },
  }
}

describe('cloud assistant.message → sessionPatch projection', () => {
  beforeEach(() => {
    useSessionStore.setState(useSessionStore.getInitialState(), true)
  })

  it('projects an append delta to a full-text replace patch keyed by message id', () => {
    const projector = createCloudTranscriptProjector()
    expect(projector.patchFor(sseRecord('m1', 'Hi', 7, 'append'), 'ses_1', null)).toEqual({
      type: 'message_text',
      sessionId: 'ses_1',
      workspaceId: null,
      messageId: 'm1',
      segmentId: 'm1',
      content: 'Hi',
      mode: 'replace',
      role: 'assistant',
      eventAt: 7,
    })
  })

  it('accumulates consecutive deltas into the growing full message text', () => {
    const projector = createCloudTranscriptProjector()
    expect(projector.patchFor(sseRecord('m1', 'Hel', 1, 'append'), 'ses_1', null)?.content).toBe('Hel')
    expect(projector.patchFor(sseRecord('m1', 'lo', 2, 'append'), 'ses_1', null)?.content).toBe('Hello')
    // A snapshot (no mode) adopts the canonical text verbatim.
    expect(projector.patchFor(sseRecord('m1', 'Hello world', 3), 'ses_1', null)?.content).toBe('Hello world')
  })

  it('drops no-op and unkeyed events', () => {
    const projector = createCloudTranscriptProjector()
    expect(projector.patchFor(sseRecord('m1', '', 9, 'append'), 'ses_1', null)).toBeNull()
    expect(projector.patchFor({ sessionId: 'ses_1', sequence: 1, payload: { content: 'x', mode: 'append' } }, 'ses_1', null)).toBeNull()
    expect(projector.patchFor(sseRecord('m1', 'x', 1, 'append'), '', null)).toBeNull()
  })

  it('streams append deltas into a byte-identical transcript via the renderer reducer', () => {
    useSessionStore.getState().setCurrentSession('ses_1')
    const projector = createCloudTranscriptProjector()
    // Boundary-overlapping deltas ('Hel'+'lo' share an 'l') would be mangled by the
    // desktop's overlap-merge append heuristic; the full-text replace projection avoids it.
    const tokens = ['Hel', 'lo', ' ', 'wor', 'ld']
    const patches = tokens
      .map((content, index) => projector.patchFor(sseRecord('m1', content, index + 1, 'append'), 'ses_1', null))
      .filter((patch): patch is NonNullable<typeof patch> => patch !== null)

    useSessionStore.getState().applySessionPatches(patches)

    const message = useSessionStore.getState().currentView.messages.at(-1)
    expect(message?.content).toBe(tokens.join(''))
    expect(message?.role).toBe('assistant')
  })

  it('is order-independent and resyncs to a full snapshot byte-identically', () => {
    useSessionStore.getState().setCurrentSession('ses_1')
    const projector = createCloudTranscriptProjector()
    const patches = ['Hel', 'lo']
      .map((content, index) => projector.patchFor(sseRecord('m1', content, index + 1, 'append'), 'ses_1', null))
      .filter((patch): patch is NonNullable<typeof patch> => patch !== null)
    // Apply the streamed replaces out of arrival order: the reducer orders by eventAt, so
    // the most complete (highest-sequence) text still wins.
    useSessionStore.getState().applySessionPatches([patches[1]!, patches[0]!])
    expect(useSessionStore.getState().currentView.messages.at(-1)?.content).toBe('Hello')

    const snapshot = projector.patchFor(sseRecord('m1', 'Hello world', 5), 'ses_1', null)
    useSessionStore.getState().applySessionPatch(snapshot!)
    expect(useSessionStore.getState().currentView.messages.at(-1)?.content).toBe('Hello world')
  })

  it('forgets a session accumulator so a re-opened stream does not resume stale text', () => {
    const projector = createCloudTranscriptProjector()
    expect(projector.patchFor(sseRecord('m1', 'Hel', 1, 'append'), 'ses_1', null)?.content).toBe('Hel')
    projector.forget('ses_1')
    // After forget, an append for the same message id starts fresh instead of concatenating.
    expect(projector.patchFor(sseRecord('m1', 'lo', 2, 'append'), 'ses_1', null)?.content).toBe('lo')
  })
})

// #905: the browser bridge opens a per-session SSE EventSource on activation. Without a
// bound, every thread ever viewed leaked a client connection and a server subscription.
describe('cloud per-session SSE stream lifecycle (#905)', () => {
  class MockEventSource {
    static instances: MockEventSource[] = []
    readonly url: string
    closed = false
    onmessage: ((event: MessageEvent) => void) | null = null
    constructor(url: string) {
      this.url = url
      MockEventSource.instances.push(this)
    }
    addEventListener() {}
    close() {
      this.closed = true
    }
  }

  beforeEach(() => {
    MockEventSource.instances = []
    installFetch(() => jsonResponse({ view: {} }))
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)
  })

  it('caps concurrently open per-session streams and closes the least-recently-activated on overflow', async () => {
    const api = createBrowserCoworkApi({})
    const total = 40
    for (let i = 0; i < total; i++) await api.session.activate(`ses_${i}`)

    const open = MockEventSource.instances.filter((source) => !source.closed)
    const closed = MockEventSource.instances.filter((source) => source.closed)
    // Bounded: activating far more than the cap never leaves more than the cap open.
    expect(open.length).toBeLessThanOrEqual(24)
    expect(open.length).toBeGreaterThan(0)
    // Every stream beyond the cap was explicitly closed (not leaked).
    expect(closed.length).toBe(total - open.length)
    // The survivors are the most-recently-activated sessions.
    expect(open.map((source) => source.url).some((url) => url.includes(`ses_${total - 1}`))).toBe(true)
    expect(closed.map((source) => source.url).some((url) => url.includes('ses_0'))).toBe(true)
  })

  it('re-activating an already-tracked session opens no new stream', async () => {
    const api = createBrowserCoworkApi({})
    await api.session.activate('ses_a')
    await api.session.activate('ses_b')
    const before = MockEventSource.instances.length
    await api.session.activate('ses_a')
    await api.session.activate('ses_b')
    expect(MockEventSource.instances.length).toBe(before)
    expect(MockEventSource.instances.every((source) => !source.closed)).toBe(true)
  })
})
