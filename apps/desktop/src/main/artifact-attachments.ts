import { basename, extname } from 'path'
import { readFileSync, statSync } from 'fs'
import type { SessionArtifactAttachment } from '@open-cowork/shared'
import { readChartArtifactSource } from './chart-artifacts.ts'

export const MAX_COMPOSER_ATTACHMENT_BYTES = 20 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.tsv': 'text/tab-separated-values',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

export function inferArtifactMime(source: string): string {
  const extension = extname(source).toLowerCase()
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream'
}

export function buildArtifactAttachmentPayload(source: string): SessionArtifactAttachment {
  const stats = statSync(source)
  if (stats.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
    throw new Error('Artifact is too large to attach to the thread.')
  }

  const mime = inferArtifactMime(source)
  const bytes = readFileSync(source)
  return {
    mime,
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    filename: basename(source),
    chart: mime === 'image/png' ? readChartArtifactSource(source) : null,
  }
}
