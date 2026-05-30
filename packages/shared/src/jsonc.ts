export type JsonObject = Record<string, unknown>

export function stripJsonComments(input: string) {
  let output = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false
        output += current
      }
      continue
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }

    if (current === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }

    output += current
  }

  return output
}

export function stripTrailingCommas(input: string) {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]

    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === ',') {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead] || '')) lookahead += 1
      const next = input[lookahead]
      if (next === '}' || next === ']') continue
    }

    output += current
  }

  return output
}

export function parseJsoncText<T extends JsonObject = JsonObject>(raw: string): T {
  const normalized = stripTrailingCommas(stripJsonComments(raw.trim()))
  const parsed = JSON.parse(normalized)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a top-level object')
  }
  return parsed as T
}

export function jsonConfigCandidates(path: string) {
  const lower = path.toLowerCase()
  const extension = lower.endsWith('.jsonc') ? '.jsonc' : lower.endsWith('.json') ? '.json' : ''
  const base = extension === '.json' || extension === '.jsonc'
    ? path.slice(0, -extension.length)
    : path
  return [`${base}.jsonc`, `${base}.json`]
}
