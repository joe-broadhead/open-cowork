import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'

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
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
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
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === ',') {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead] || '')) {
        lookahead += 1
      }
      const next = input[lookahead]
      if (next === '}' || next === ']') {
        continue
      }
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

export function readJsoncFile<T extends JsonObject = JsonObject>(path: string): T {
  if (!existsSync(path)) return {} as T
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return {} as T
  return parseJsoncText<T>(raw)
}

export function writeJsonFile(path: string, value: JsonObject) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function jsonConfigCandidates(path: string) {
  const extension = extname(path).toLowerCase()
  const base = extension === '.json' || extension === '.jsonc'
    ? path.slice(0, -extension.length)
    : path
  return [`${base}.jsonc`, `${base}.json`]
}

export function resolveExistingJsonConfigPath(path: string) {
  return jsonConfigCandidates(path).find((candidate) => existsSync(candidate)) || path
}

type TopLevelProperty = {
  key: string
  start: number
  end: number
  hasTrailingComma: boolean
}

function skipWhitespaceAndComments(text: string, index: number) {
  let cursor = index
  while (cursor < text.length) {
    const current = text[cursor]
    const next = text[cursor + 1]

    if (/\s/.test(current || '')) {
      cursor += 1
      continue
    }

    if (current === '/' && next === '/') {
      cursor += 2
      while (cursor < text.length && text[cursor] !== '\n') {
        cursor += 1
      }
      continue
    }

    if (current === '/' && next === '*') {
      cursor += 2
      while (cursor < text.length && !(text[cursor] === '*' && text[cursor + 1] === '/')) {
        cursor += 1
      }
      cursor += 2
      continue
    }

    break
  }
  return cursor
}

function parseJsonString(text: string, index: number) {
  let cursor = index + 1
  let escaped = false
  while (cursor < text.length) {
    const current = text[cursor]
    if (escaped) {
      escaped = false
    } else if (current === '\\') {
      escaped = true
    } else if (current === '"') {
      break
    }
    cursor += 1
  }
  if (cursor >= text.length) {
    throw new Error('Unterminated JSON string')
  }
  return {
    value: JSON.parse(text.slice(index, cursor + 1)) as string,
    end: cursor + 1,
  }
}

function scanValueBoundary(text: string, index: number, rootEnd: number) {
  let cursor = index
  let depthCurly = 0
  let depthBracket = 0
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  while (cursor < rootEnd) {
    const current = text[cursor]
    const next = text[cursor + 1]

    if (inLineComment) {
      if (current === '\n') inLineComment = false
      cursor += 1
      continue
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false
        cursor += 2
        continue
      }
      cursor += 1
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
      cursor += 1
      continue
    }

    if (current === '"') {
      inString = true
      cursor += 1
      continue
    }

    if (current === '/' && next === '/') {
      inLineComment = true
      cursor += 2
      continue
    }

    if (current === '/' && next === '*') {
      inBlockComment = true
      cursor += 2
      continue
    }

    if (current === '{') {
      depthCurly += 1
      cursor += 1
      continue
    }
    if (current === '}') {
      if (depthCurly === 0 && depthBracket === 0) return cursor
      depthCurly -= 1
      cursor += 1
      continue
    }
    if (current === '[') {
      depthBracket += 1
      cursor += 1
      continue
    }
    if (current === ']') {
      depthBracket -= 1
      cursor += 1
      continue
    }
    if (current === ',' && depthCurly === 0 && depthBracket === 0) {
      return cursor
    }

    cursor += 1
  }

  return rootEnd
}

function analyzeTopLevelProperties(text: string) {
  const rootStart = skipWhitespaceAndComments(text, 0)
  if (text[rootStart] !== '{') {
    throw new Error('Expected a top-level JSON object')
  }

  const rootEnd = text.lastIndexOf('}')
  if (rootEnd < rootStart) {
    throw new Error('Unterminated top-level JSON object')
  }

  const properties: TopLevelProperty[] = []
  let cursor = rootStart + 1

  while (cursor < rootEnd) {
    cursor = skipWhitespaceAndComments(text, cursor)
    if (cursor >= rootEnd || text[cursor] === '}') break
    const start = cursor
    const parsedKey = parseJsonString(text, cursor)
    cursor = skipWhitespaceAndComments(text, parsedKey.end)
    if (text[cursor] !== ':') {
      throw new Error('Expected ":" after property key')
    }
    cursor = skipWhitespaceAndComments(text, cursor + 1)
    const boundary = scanValueBoundary(text, cursor, rootEnd)
    const valueEnd = skipWhitespaceAndComments(text, boundary)
    const hasTrailingComma = text[valueEnd] === ','
    properties.push({
      key: parsedKey.value,
      start,
      end: hasTrailingComma ? valueEnd + 1 : valueEnd,
      hasTrailingComma,
    })
    cursor = hasTrailingComma ? valueEnd + 1 : valueEnd
  }

  const indentMatch = text.match(/\n([ \t]+)"/)
  return {
    rootStart,
    rootEnd,
    properties,
    indent: indentMatch?.[1] || '  ',
    newline: text.includes('\r\n') ? '\r\n' : '\n',
  }
}

function serializeTopLevelProperty(key: string, value: JsonObject, indent: string, newline: string) {
  const valueLines = JSON.stringify(value, null, 2).split('\n')
  if (valueLines.length === 1) {
    return `${indent}${JSON.stringify(key)}: ${valueLines[0]}`
  }
  return [
    `${indent}${JSON.stringify(key)}: ${valueLines[0]}`,
    ...valueLines.slice(1).map((line) => `${indent}${line}`),
  ].join(newline)
}

export function updateTopLevelObjectPropertyInJsonc(
  raw: string,
  key: string,
  value: JsonObject | null,
) {
  const { rootEnd, properties, indent, newline } = analyzeTopLevelProperties(raw)
  const existing = properties.find((property) => property.key === key)

  if (existing) {
    if (value === null) {
      return `${raw.slice(0, existing.start)}${raw.slice(existing.end)}`.replace(/,\s*}/g, `${newline}}`)
    }
    const replacement = serializeTopLevelProperty(key, value, indent, newline) + (existing.hasTrailingComma ? ',' : '')
    return `${raw.slice(0, existing.start)}${replacement}${raw.slice(existing.end)}`
  }

  if (value === null) return raw

  const serialized = serializeTopLevelProperty(key, value, indent, newline)
  if (properties.length === 0) {
    return `${raw.slice(0, rootEnd)}${newline}${serialized}${newline}${raw.slice(rootEnd)}`
  }

  const last = properties[properties.length - 1]
  const separator = last.hasTrailingComma ? '' : ','
  return `${raw.slice(0, last.end)}${separator}${newline}${serialized}${raw.slice(last.end)}`
}

export function writeTopLevelObjectPropertyFile(
  preferredPath: string,
  key: string,
  value: JsonObject | null,
) {
  const path = resolveExistingJsonConfigPath(preferredPath)
  if (!existsSync(path) || !readFileSync(path, 'utf-8').trim()) {
    if (value === null) return path
    writeJsonFile(path, { [key]: value })
    return path
  }

  const raw = readFileSync(path, 'utf-8')
  const next = updateTopLevelObjectPropertyInJsonc(raw, key, value)
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
  return path
}

