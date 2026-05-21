import type { UpdateReleaseSourceDescriptor } from '@open-cowork/shared'
import type { UpdateReleaseSourceConfig } from '../config-types.ts'
import { normalizeUpdateSourceUrl } from './update-release-source-generic.ts'

export type GcsReleaseSourceConfig = Extract<UpdateReleaseSourceConfig, { kind: 'gcs' }>

const GCS_BUCKET_PATTERN = /^(?=.{3,222}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9][a-z0-9._-]*[a-z0-9]$/

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/%2F/gi, '/')
}

export function normalizeGcsPrefix(prefix?: string | null) {
  const trimmed = prefix?.trim().replace(/^\/+|\/+$/g, '') || ''
  if (!trimmed) return ''
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  return segments.map(encodePathSegment).join('/')
}

export function gcsReleaseBaseUrl(input: { bucket: string; prefix?: string | null; channel: string }) {
  const bucket = input.bucket.trim()
  if (!GCS_BUCKET_PATTERN.test(bucket)) return null
  const prefix = normalizeGcsPrefix(input.prefix)
  if (prefix === null) return null
  const path = [bucket, prefix, input.channel].filter(Boolean).join('/')
  return `https://storage.googleapis.com/${path}/`
}

export function gcsReleaseSourceDescriptor(input: {
  label: string
  channel: string
  authKind: 'google-oauth' | 'signed-url-broker'
}): UpdateReleaseSourceDescriptor {
  return {
    kind: 'gcs',
    label: input.label,
    channel: input.channel,
    requiresAuth: true,
    authKind: input.authKind,
  }
}

export function normalizeBrokerProviderPayload(
  value: unknown,
  options: { allowLocalHttp?: boolean } = {},
): {
  providerUrl: string
  requestHeaders: Record<string, string>
} | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const providerUrl = typeof record.providerUrl === 'string'
    ? normalizeUpdateSourceUrl(record.providerUrl, { allowLocalHttp: options.allowLocalHttp })
    : null
  if (!providerUrl) return null
  const requestHeaders = record.requestHeaders && typeof record.requestHeaders === 'object' && !Array.isArray(record.requestHeaders)
    ? Object.fromEntries(
        Object.entries(record.requestHeaders as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0),
      )
    : {}
  return { providerUrl, requestHeaders }
}
