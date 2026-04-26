import { z } from 'zod'

export const MAX_CHART_DATA_ROWS = 50_000
export const MAX_CUSTOM_SPEC_BYTES = 256 * 1024
export const MAX_CUSTOM_SPEC_ARRAY_ITEMS = 20_000
export const MAX_CUSTOM_SPEC_OBJECT_NODES = 10_000
export const MAX_CUSTOM_SPEC_DEPTH = 32

const BLOCKED_RESOURCE_KEYS = new Set(['url', 'href', 'src'])

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function validateInlineSpec(value: unknown): string | null {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return 'Spec must be JSON-serializable.'
  }
  if (typeof serialized !== 'string') {
    return 'Spec must be a JSON object.'
  }

  if (byteLength(serialized) > MAX_CUSTOM_SPEC_BYTES) {
    return `Spec exceeds ${MAX_CUSTOM_SPEC_BYTES} bytes.`
  }

  let arrayItems = 0
  let objectNodes = 0

  const visit = (entry: unknown, depth: number): string | null => {
    if (depth > MAX_CUSTOM_SPEC_DEPTH) {
      return `Spec exceeds maximum depth of ${MAX_CUSTOM_SPEC_DEPTH}.`
    }
    if (Array.isArray(entry)) {
      arrayItems += entry.length
      if (arrayItems > MAX_CUSTOM_SPEC_ARRAY_ITEMS) {
        return `Spec exceeds ${MAX_CUSTOM_SPEC_ARRAY_ITEMS} total array items.`
      }
      for (const item of entry) {
        const issue = visit(item, depth + 1)
        if (issue) return issue
      }
      return null
    }
    if (!entry || typeof entry !== 'object') return null

    objectNodes += 1
    if (objectNodes > MAX_CUSTOM_SPEC_OBJECT_NODES) {
      return `Spec exceeds ${MAX_CUSTOM_SPEC_OBJECT_NODES} object nodes.`
    }

    const record = entry as Record<string, unknown>
    const mark = record.mark
    if (typeof mark === 'string' && mark.toLowerCase() === 'image') {
      return 'Image marks are not allowed.'
    }
    if (mark && typeof mark === 'object') {
      const markType = (mark as Record<string, unknown>).type
      if (typeof markType === 'string' && markType.toLowerCase() === 'image') {
        return 'Image marks are not allowed.'
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (BLOCKED_RESOURCE_KEYS.has(key) && typeof child === 'string' && child.trim().length > 0) {
        return `External resource key "${key}" is not allowed; use inline values.`
      }
      const issue = visit(child, depth + 1)
      if (issue) return issue
    }
    return null
  }

  return visit(value, 0)
}

export const chartDataSchema = z.array(
  z.record(z.string(), z.unknown()),
).max(MAX_CHART_DATA_ROWS).describe(
  'Required inline data array. Include the full rows in every chart call, for example: [{"label":"A","value":12}]. Axis/color/size fields must exist on these row objects.',
)

export const vegaLiteSpecSchema = z.record(
  z.string(),
  z.unknown(),
).superRefine((value, ctx) => {
  const issue = validateInlineSpec(value)
  if (issue) {
    ctx.addIssue({
      code: 'custom',
      message: issue,
    })
  }
}).describe('Full Vega-Lite specification object')
