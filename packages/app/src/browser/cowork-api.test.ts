import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from './cowork-api.ts'

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
