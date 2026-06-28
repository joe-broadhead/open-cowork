import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserCoworkApi, createTransport } from './cowork-api.ts'

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

// F4 presigned artifact UPLOAD: the shim must take the direct-to-store fast path when the cloud
// advertises it (begin -> direct PUT -> finalize), and fall back to the buffered upload whenever
// the server can't presign or the direct PUT fails. The public upload(...) contract is unchanged.

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

  it('uses begin -> direct PUT -> finalize when the server advertises presigned upload', async () => {
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: {
            transfer: 'presigned',
            artifactId: 'art-1',
            uploadUrl: 'https://object-store.test/key?sig=put',
            uploadMethod: 'PUT',
            uploadHeaders: { 'content-type': 'text/plain' },
            uploadExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }
      if (url === 'https://object-store.test/key?sig=put') return jsonResponse(undefined, 200)
      if (url.endsWith('/artifacts/art-1/finalize')) return jsonResponse({ artifact: { id: 'art-1', filename: 'f.txt', cloudArtifactId: 'art-1', size: 5 } })
      if (url.endsWith('/artifacts') && method === 'POST') throw new Error('buffered upload must not run when presigned succeeds')
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({}).artifact.upload(uploadRequest)
    expect(result.id).toBe('art-1')

    // Direct PUT carried the RAW bytes (not base64) straight to the object store.
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toBe('https://object-store.test/key?sig=put')
    expect(put?.headers['content-type']).toBe('text/plain')
    expect(put?.body).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(put?.body as Uint8Array)).toBe('hello')

    // Finalize recorded the metadata; the buffered collection POST was never used.
    expect(calls.some((c) => c.url.endsWith('/artifacts/art-1/finalize') && c.method === 'POST')).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/artifacts') && c.method === 'POST')).toBe(false)
  })

  it('falls back to the buffered upload when the server signals unsupported', async () => {
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) return jsonResponse({ upload: { transfer: 'unsupported' } })
      if (url.endsWith('/artifacts') && method === 'POST') return jsonResponse({ artifact: { id: 'buffered-1', filename: 'f.txt' } })
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({}).artifact.upload(uploadRequest)
    expect(result.id).toBe('buffered-1')

    // No direct PUT, and the buffered collection POST carried the full base64 body.
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    const buffered = calls.find((c) => c.url.endsWith('/artifacts') && c.method === 'POST')
    expect((buffered?.body as { dataBase64?: string })?.dataBase64).toBe(uploadRequest.dataBase64)
  })

  it('falls back to the buffered upload when the direct PUT fails', async () => {
    const calls = installRecordingFetch((url, method) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ csrfToken: null })
      if (url.includes('/artifacts?transfer=presigned')) {
        return jsonResponse({
          upload: { transfer: 'presigned', artifactId: 'art-1', uploadUrl: 'https://object-store.test/key?sig=put', uploadMethod: 'PUT', uploadHeaders: {}, uploadExpiresAt: '2099-01-01T00:00:00.000Z' },
        })
      }
      if (url === 'https://object-store.test/key?sig=put') return jsonResponse({ error: 'denied' }, 403)
      if (url.endsWith('/artifacts/art-1/finalize')) throw new Error('finalize must not run when the PUT failed')
      if (url.endsWith('/artifacts') && method === 'POST') return jsonResponse({ artifact: { id: 'buffered-1', filename: 'f.txt' } })
      return jsonResponse({})
    })

    const result = await createBrowserCoworkApi({}).artifact.upload(uploadRequest)
    expect(result.id).toBe('buffered-1')
    expect(calls.some((c) => c.url.endsWith('/artifacts/art-1/finalize'))).toBe(false)
    expect(calls.some((c) => c.url.endsWith('/artifacts') && c.method === 'POST')).toBe(true)
  })
})
