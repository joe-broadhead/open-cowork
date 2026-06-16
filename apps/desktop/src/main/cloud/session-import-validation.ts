import { CloudServiceError } from './cloud-service-error.ts'
import type { SessionImportItemCounts } from '@open-cowork/shared'

// Pure validators for the cloud session-import path: normalize the per-kind item
// counts to non-negative integers, and bound imported text to a max length.
// Extracted from session-service.ts; depends only on the shared item-counts type
// and the standalone CloudServiceError.

const SESSION_IMPORT_MAX_TEXT = 1_000_000

export function normalizeImportCounts(value: Partial<SessionImportItemCounts> | undefined): SessionImportItemCounts {
  const numberValue = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry) && entry > 0 ? Math.floor(entry) : 0
  return {
    messages: numberValue(value?.messages),
    artifacts: numberValue(value?.artifacts),
    attachments: numberValue(value?.attachments),
    projectSource: numberValue(value?.projectSource),
    excluded: numberValue(value?.excluded),
  }
}

export function boundedImportText(value: unknown, label: string, maxLength = SESSION_IMPORT_MAX_TEXT) {
  if (typeof value !== 'string') return ''
  if (value.length > maxLength) throw new CloudServiceError(400, `${label} exceeds ${maxLength} characters.`)
  return value
}
