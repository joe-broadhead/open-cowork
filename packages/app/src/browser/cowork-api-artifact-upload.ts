// Browser artifact upload orchestration for the cloud CoworkAPI facade.
//
// Direct upload is deliberately an optional optimization. The buffered API
// remains the default, while the enabled path keeps one durable artifact
// identity across begin, provider POST, publication probes, and finalize
// retries.

import type { CoworkAPI, SessionArtifact } from '@open-cowork/shared'
import {
  unwrap,
  type BrowserCoworkApiTransport,
} from './cowork-api-transport'

type ArtifactUploadTransport = Pick<BrowserCoworkApiTransport, 'request' | 'endpoint' | 'withQuery'>

type BrowserArtifactUploadOptions = ArtifactUploadTransport & {
  directUploadEnabled: boolean
}

type PresignedUploadBegin = {
  transfer?: string
  artifactId?: string
  uploadUrl?: string
  uploadMethod?: string
  uploadFields?: Record<string, string>
  uploadExpiresAt?: string
}

// The server fences a finalization claim for up to 30 seconds. Stay on the same
// idempotency identity across that window so a concurrent winner can finish or
// the durable reconciler can make the reservation claimable again.
const DIRECT_UPLOAD_FINALIZE_RETRY_DELAYS_MS = [
  50,
  150,
  300,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  14_000,
] as const

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function retryableDirectUploadFinalizeError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status !== 'number'
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500
}

function isExactUnsupportedUpload(value: PresignedUploadBegin | null): boolean {
  return Boolean(
    value
    && value.transfer === 'unsupported'
    && Object.keys(value).length === 1,
  )
}

async function waitForDirectUploadFinalizeRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))
}

function validDirectUploadFields(value: Record<string, string> | undefined): value is Record<string, string> {
  if (!value || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 64) return false
  let bytes = 0
  for (const [key, field] of entries) {
    if (!key || key.length > 256 || typeof field !== 'string' || field.length > 16_384) return false
    bytes += key.length + field.length
  }
  return bytes <= 64 * 1024
}

function validDirectUploadUrl(value: string | undefined): value is string {
  try {
    const url = new URL(value || '')
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password
      && (globalThis.location?.protocol !== 'https:' || url.protocol === 'https:')
  } catch {
    return false
  }
}

export function createBrowserArtifactUpload({
  directUploadEnabled,
  request,
  endpoint,
  withQuery,
}: BrowserArtifactUploadOptions): CoworkAPI['artifact']['upload'] {
  return async (req): Promise<SessionArtifact> => {
    // Buffered upload is the default-safe path and preserves the renderer's
    // original API contract unchanged.
    const bufferedUpload = async (): Promise<SessionArtifact> =>
      unwrap(await request(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { method: 'POST', body: req }), 'artifact', null as never)

    // The server publishes this flag only after its durable cleanup owner is
    // attested. Keep the common path free of a duplicate buffer, hash, and RTT.
    if (!directUploadEnabled) return bufferedUpload()

    // When enabled, send bytes directly to object storage (begin -> provider
    // POST -> finalize). Only the exact credential-free unsupported response
    // permits buffered fallback: malformed responses may represent a durable
    // reservation and therefore fail closed.
    const uploadBytes = base64ToBytes(req.dataBase64)
    if (uploadBytes.byteLength === 0) return bufferedUpload()
    if (!globalThis.crypto?.randomUUID || !globalThis.crypto?.subtle) return bufferedUpload()
    const artifactId = globalThis.crypto.randomUUID()
    const checksumSha256 = await sha256Hex(uploadBytes)
    const abortDirectUpload = async (reason: string) => {
      try {
        await request(endpoint('sessionArtifactAbort', { sessionId: req.sessionId, artifactId }), {
          method: 'POST',
          body: { reason },
        })
      } catch {
        // Best-effort: the server-side expiry/reconciler remains authoritative cleanup.
      }
    }

    let begun: PresignedUploadBegin | null
    try {
      begun = unwrap<PresignedUploadBegin | null>(
        await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { transfer: 'presigned' }), {
          method: 'POST',
          body: {
            filename: req.filename,
            contentType: req.contentType ?? null,
            expectedSize: uploadBytes.byteLength,
            artifactId,
            checksumSha256,
            kind: req.kind ?? null,
            status: req.status ?? null,
            authorAgentId: req.authorAgentId ?? null,
            projectId: req.projectId ?? null,
            taskId: req.taskId ?? null,
            statusUpdatedBy: req.statusUpdatedBy ?? null,
            statusUpdatedAt: req.statusUpdatedAt ?? null,
          },
        }),
        'upload',
        null,
      )
    } catch (error) {
      await abortDirectUpload('direct_upload_begin_failed')
      throw error
    }
    if (isExactUnsupportedUpload(begun)) return bufferedUpload()

    const uploadExpiresAtMs = Date.parse(begun?.uploadExpiresAt || '')
    if (
      !begun
      || begun.transfer !== 'presigned'
      || begun.artifactId !== artifactId
      || !validDirectUploadUrl(begun.uploadUrl)
      || begun.uploadMethod !== 'POST'
      || !validDirectUploadFields(begun.uploadFields)
      || !Number.isFinite(uploadExpiresAtMs)
      || uploadExpiresAtMs <= Date.now()
    ) {
      await abortDirectUpload('direct_upload_contract_invalid')
      throw new Error('Direct artifact upload returned an invalid credential contract; retry the upload.')
    }

    let postOk: boolean
    try {
      const form = new FormData()
      for (const [key, value] of Object.entries(begun.uploadFields)) form.append(key, value)
      form.append('file', new Blob([uploadBytes as unknown as BlobPart], {
        type: req.contentType || 'application/octet-stream',
      }), req.filename)
      const postResponse = await fetch(begun.uploadUrl, {
        method: 'POST',
        body: form,
      })
      postOk = postResponse.ok
    } catch {
      postOk = false
    }
    if (!postOk) {
      await abortDirectUpload('direct_upload_failed')
      // A failed/CORS-hidden response does not prove the provider rejected the
      // bytes. Buffered retry could double-charge and create a second object.
      throw new Error('Direct artifact upload failed before finalization; retry the upload.')
    }

    // A finalize response can be lost after commit, while a retry can briefly
    // observe the durable claim as busy. Retry only finalize for this identity.
    const finalizePath = endpoint('sessionArtifactFinalize', { sessionId: req.sessionId, artifactId })
    const finalizeBody = {
      filename: req.filename,
      contentType: req.contentType ?? null,
      kind: req.kind ?? null,
      status: req.status ?? null,
      authorAgentId: req.authorAgentId ?? null,
      projectId: req.projectId ?? null,
      taskId: req.taskId ?? null,
      statusUpdatedBy: req.statusUpdatedBy ?? null,
      statusUpdatedAt: req.statusUpdatedAt ?? null,
    }
    let finalizeError: unknown = new Error('Direct artifact upload finalization failed.')
    const readPublishedArtifact = async (): Promise<SessionArtifact | null> => {
      try {
        // The collection route reads only the durable index. The item route
        // records a download, so it is not a safe publication probe.
        const published = unwrap<SessionArtifact[]>(
          await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { limit: 100 })),
          'artifacts',
          [],
        )
        return published.find((artifact) => artifact.id === artifactId) || null
      } catch {
        return null
      }
    }

    for (let attempt = 0; attempt <= DIRECT_UPLOAD_FINALIZE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return unwrap(
          await request(finalizePath, { method: 'POST', body: finalizeBody }),
          'artifact',
          null as never,
        )
      } catch (error) {
        finalizeError = error
        const delayMs = DIRECT_UPLOAD_FINALIZE_RETRY_DELAYS_MS[attempt]
        if (retryableDirectUploadFinalizeError(error)) {
          const published = await readPublishedArtifact()
          if (published) return published
        }
        if (
          delayMs === undefined
          || !retryableDirectUploadFinalizeError(error)
          || Date.now() + delayMs >= uploadExpiresAtMs
        ) break
        await waitForDirectUploadFinalizeRetry(delayMs)
      }
    }

    // If every retry response was lost, resolve a committed publication with
    // one final read; otherwise preserve the original finalize error.
    const published = await readPublishedArtifact()
    if (published) return published
    throw finalizeError
  }
}
