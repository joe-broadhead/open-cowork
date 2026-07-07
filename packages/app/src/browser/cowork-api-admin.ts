// Browser (cloud web) implementation of the `CoworkAPI['admin']` surface (#896).
//
// Extracted from cowork-api.ts to keep that facade within its documented size
// budget. Talks to the SAME cloud control-plane /api routes the desktop transport
// calls, so the admin control plane is byte-identical across desktop and web.
// Secrets are never requested — BYOK/SSO responses carry metadata only.

import type { CoworkAPI } from '@open-cowork/shared'

type QueryValue = string | number | boolean | null | undefined

export type AdminRequest = <T = unknown>(
  path: string,
  options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
) => Promise<T>

function query(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function seg(value: string): string {
  return encodeURIComponent(value)
}

function unwrap<T>(payload: unknown, key: string, fallback: T): T {
  if (payload && typeof payload === 'object' && key in (payload as Record<string, unknown>)) {
    const value = (payload as Record<string, unknown>)[key]
    return (value ?? fallback) as T
  }
  return fallback
}

// The audit export streams JSON or CSV with a content-disposition filename — the
// standard transport JSON-parses every body, so read it raw here.
async function fetchAuditExport(path: string) {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin' })
  const content = await response.text()
  if (!response.ok) {
    throw new Error(`Audit export failed with status ${response.status}`)
  }
  const disposition = response.headers.get('content-disposition') || ''
  const match = /filename="?([^"]+)"?/.exec(disposition)
  return {
    content,
    contentType: response.headers.get('content-type') || 'application/json',
    filename: match ? match[1]! : 'audit-export.json',
  }
}

export function createBrowserAdminApi(request: AdminRequest): CoworkAPI['admin'] {
  return {
    access: async () => unwrap(await request('/api/admin/access'), 'access', {
      role: null,
      customRoleKey: null,
      permissions: [],
      email: null,
      ssoVerified: false,
    }),
    entitlements: () => request('/api/billing/entitlements'),
    overview: async () => unwrap(await request('/api/admin'), 'policy', null as never),
    members: {
      list: async (input) =>
        unwrap(await request(`/api/admin/members${query({ q: input?.query ?? undefined, limit: input?.limit ?? undefined })}`), 'members', []),
      invite: (input) =>
        request('/api/admin/members', { method: 'POST', body: { email: input.email, role: input.role ?? undefined } }),
      update: async (accountId, input) =>
        unwrap(await request(`/api/admin/members/${seg(accountId)}/update`, { method: 'POST', body: input }), 'member', null as never),
      assignRole: async (accountId, roleKey) =>
        unwrap(await request(`/api/admin/members/${seg(accountId)}/role`, { method: 'POST', body: { roleKey } }), 'member', null as never),
    },
    roles: {
      catalog: async () => unwrap(await request('/api/admin/permission-catalog'), 'permissions', []),
      list: async () => unwrap(await request('/api/admin/roles'), 'roles', []),
      create: async (input) => unwrap(await request('/api/admin/roles', { method: 'POST', body: input }), 'role', null as never),
      update: async (roleKey, input) =>
        unwrap(await request(`/api/admin/roles/${seg(roleKey)}/update`, { method: 'POST', body: input }), 'role', null as never),
      delete: async (roleKey) =>
        Boolean(unwrap(await request(`/api/admin/roles/${seg(roleKey)}`, { method: 'DELETE' }), 'deleted', false)),
    },
    policy: {
      get: () => request('/api/policy'),
      set: (input) => request('/api/policy', { method: 'PUT', body: input }),
    },
    providers: {
      listKeys: async () => unwrap(await request('/api/byok'), 'secrets', []),
      setKey: async (providerId, input) =>
        unwrap(await request(`/api/byok/${seg(providerId)}`, { method: 'POST', body: input }), 'secret', null as never),
      deleteKey: async (providerId) => {
        const payload = await request<Record<string, unknown>>(`/api/byok/${seg(providerId)}`, { method: 'DELETE' })
        return payload !== undefined && 'secret' in (payload as Record<string, unknown>)
      },
      sso: async () => unwrap(await request('/api/admin/sso'), 'sso', null),
    },
    usage: (limit) => request(`/api/usage/summary${query({ limit })}`),
    audit: {
      query: (filters) => request(`/api/admin/audit${query({
        actorId: filters?.actorId ?? undefined,
        actorType: filters?.actorType ?? undefined,
        action: filters?.action ?? undefined,
        targetType: filters?.targetType ?? undefined,
        targetId: filters?.targetId ?? undefined,
        result: filters?.result ?? undefined,
        from: filters?.from ?? undefined,
        to: filters?.to ?? undefined,
        limit: filters?.limit ?? undefined,
        cursor: filters?.cursor ?? undefined,
      })}`),
      export: (input) => {
        const format = input?.format === 'csv' ? 'csv' : 'json'
        return fetchAuditExport(`/api/admin/audit/export${query({
          actorId: input?.actorId ?? undefined,
          actorType: input?.actorType ?? undefined,
          action: input?.action ?? undefined,
          targetType: input?.targetType ?? undefined,
          targetId: input?.targetId ?? undefined,
          result: input?.result ?? undefined,
          from: input?.from ?? undefined,
          to: input?.to ?? undefined,
          format,
          unredacted: input?.unredacted ? 'true' : undefined,
        })}`)
      },
    },
  }
}
