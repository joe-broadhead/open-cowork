export const MAX_CHART_SPEC_BYTES = 256 * 1024
export const MAX_CHART_ARRAY_ITEMS = 20_000
export const MAX_CHART_OBJECT_NODES = 10_000
export const MAX_CHART_DEPTH = 32

const BLOCKED_RESOURCE_KEYS = new Set(['url', 'href', 'src'])

function encodedByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function blockedResourceError(detail: string) {
  return new Error(`Chart rendering only supports local inline specs: ${detail}`)
}

function blockedRenderError(detail: string) {
  return new Error(`Chart rendering rejected an unsafe or oversized spec: ${detail}`)
}

export function validateInlineChartSpec(value: unknown) {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw blockedRenderError('spec must be JSON-serializable')
  }

  if (typeof serialized !== 'string') {
    throw blockedRenderError('spec must be a JSON object')
  }

  const serializedBytes = encodedByteLength(serialized)
  if (serializedBytes > MAX_CHART_SPEC_BYTES) {
    throw blockedRenderError(`spec exceeds ${MAX_CHART_SPEC_BYTES} bytes`)
  }

  let arrayItems = 0
  let objectNodes = 0

  const visit = (entry: unknown, depth: number) => {
    if (depth > MAX_CHART_DEPTH) {
      throw blockedRenderError(`spec exceeds maximum depth of ${MAX_CHART_DEPTH}`)
    }

    if (Array.isArray(entry)) {
      arrayItems += entry.length
      if (arrayItems > MAX_CHART_ARRAY_ITEMS) {
        throw blockedRenderError(`spec exceeds ${MAX_CHART_ARRAY_ITEMS} total array items`)
      }
      for (const item of entry) {
        visit(item, depth + 1)
      }
      return
    }

    if (!entry || typeof entry !== 'object') return

    objectNodes += 1
    if (objectNodes > MAX_CHART_OBJECT_NODES) {
      throw blockedRenderError(`spec exceeds ${MAX_CHART_OBJECT_NODES} object nodes`)
    }

    const record = entry as Record<string, unknown>
    const mark = record.mark
    if (typeof mark === 'string' && mark.toLowerCase() === 'image') {
      throw blockedRenderError('image marks are not allowed')
    }
    if (mark && typeof mark === 'object') {
      const markType = (mark as Record<string, unknown>).type
      if (typeof markType === 'string' && markType.toLowerCase() === 'image') {
        throw blockedRenderError('image marks are not allowed')
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (BLOCKED_RESOURCE_KEYS.has(key) && typeof child === 'string' && child.trim().length > 0) {
        throw blockedResourceError(`${key}="${child}" is not allowed`)
      }
      visit(child, depth + 1)
    }
  }

  visit(value, 0)
}
