import type { ImprovementCandidateDiff, MemoryPrivacyClassification } from '@open-cowork/shared'

const DREAM_CONSOLIDATION_TYPE = 'open_cowork.dream_consolidation'
const CONTRACT_VERSION = 1
const STRUCTURED_OUTPUT_RETRY_COUNT = 2
const MAX_CANDIDATES = 8
const MAX_TEXT = 2_000
const MAX_BODY = 8_000
const MAX_TAGS = 12
const MAX_TAG = 64
const MAX_MEMORY_ID = 512

type JsonRecord = Record<string, unknown>
type JsonSchema = Record<string, unknown>

type StructuredOutputFormat = {
  type: 'json_schema'
  schema: JsonSchema
  retryCount: number
}

export type DreamConsolidationCandidate = {
  operation: ImprovementCandidateDiff['operation']
  sourceMemoryEntryId: string | null
  title: string
  summary: string
  body: string
  tags: string[]
  privacy: MemoryPrivacyClassification
}

export type DreamConsolidationResult = {
  summary: string
  candidates: DreamConsolidationCandidate[]
}

const STRING_ARRAY_SCHEMA: JsonSchema = {
  type: 'array',
  maxItems: MAX_TAGS,
  items: { type: 'string', maxLength: MAX_TAG },
}

const DREAM_CONSOLIDATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: DREAM_CONSOLIDATION_TYPE },
    version: { const: CONTRACT_VERSION },
    summary: {
      type: 'string',
      maxLength: MAX_TEXT,
      description: 'Short rationale for the proposed memory improvements.',
    },
    candidates: {
      type: 'array',
      maxItems: MAX_CANDIDATES,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['create', 'update', 'delete'] },
          sourceMemoryEntryId: { type: ['string', 'null'], maxLength: MAX_MEMORY_ID },
          title: { type: 'string', maxLength: MAX_TEXT },
          summary: { type: 'string', maxLength: MAX_TEXT },
          body: { type: 'string', maxLength: MAX_BODY },
          tags: STRING_ARRAY_SCHEMA,
          privacy: { type: 'string', enum: ['public', 'internal', 'sensitive', 'restricted'] },
        },
        required: ['operation', 'sourceMemoryEntryId', 'title', 'summary', 'body', 'tags', 'privacy'],
      },
    },
  },
  required: ['type', 'version', 'summary', 'candidates'],
}

function extractJsonPayload(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  return fenced?.[1] || text
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(extractJsonPayload(text)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null
  } catch {
    return null
  }
}

function readString(value: unknown, maxLength = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function readPrivacy(value: unknown): MemoryPrivacyClassification {
  return value === 'public' || value === 'sensitive' || value === 'restricted' ? value : 'internal'
}

function readOperation(value: unknown): ImprovementCandidateDiff['operation'] | null {
  if (value === 'create' || value === 'update' || value === 'delete') return value
  return null
}

function readTags(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of value) {
    const tag = readString(item, MAX_TAG).toLowerCase()
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

function coerceDreamConsolidation(record: JsonRecord): DreamConsolidationResult | null {
  if (record.type !== DREAM_CONSOLIDATION_TYPE || record.version !== CONTRACT_VERSION) return null
  const summary = readString(record.summary)
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.slice(0, MAX_CANDIDATES).map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const candidate = entry as JsonRecord
      const operation = readOperation(candidate.operation)
      const title = readString(candidate.title)
      const candidateSummary = readString(candidate.summary)
      const body = readString(candidate.body, MAX_BODY)
      if (!operation || !title || !candidateSummary || (operation !== 'delete' && !body)) return null
      const sourceMemoryEntryId = readString(candidate.sourceMemoryEntryId, MAX_MEMORY_ID) || null
      return {
        operation,
        sourceMemoryEntryId,
        title,
        summary: candidateSummary,
        body,
        tags: readTags(candidate.tags),
        privacy: readPrivacy(candidate.privacy),
      }
    }).filter((entry): entry is DreamConsolidationCandidate => Boolean(entry))
    : []
  return {
    summary: summary || 'Dream consolidation completed.',
    candidates,
  }
}

export function dreamConsolidationOutputFormat(): StructuredOutputFormat {
  return {
    type: 'json_schema',
    schema: DREAM_CONSOLIDATION_SCHEMA,
    retryCount: STRUCTURED_OUTPUT_RETRY_COUNT,
  }
}

export function dreamConsolidationSchemaHint() {
  return [
    '{',
    `  "type": "${DREAM_CONSOLIDATION_TYPE}",`,
    `  "version": ${CONTRACT_VERSION},`,
    '  "summary": "short rationale",',
    '  "candidates": [',
    '    {',
    '      "operation": "create|update|delete",',
    '      "sourceMemoryEntryId": "memory id|null",',
    '      "title": "candidate memory title",',
    '      "summary": "short candidate summary",',
    '      "body": "full candidate memory body",',
    '      "tags": ["short-tag"],',
    '      "privacy": "public|internal|sensitive|restricted"',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

export function extractDreamConsolidationFromStructured(value: unknown): DreamConsolidationResult | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
  return record ? coerceDreamConsolidation(record) : null
}

export function extractDreamConsolidationFromAssistantText(text: string): DreamConsolidationResult | null {
  const record = parseJsonRecord(text)
  return record ? coerceDreamConsolidation(record) : null
}
