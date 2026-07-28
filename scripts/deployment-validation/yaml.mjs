import { readFileSync } from 'node:fs'

export class YamlValidationError extends Error {
  constructor(code, path, message) {
    super(`[${code}] ${path}: ${message}`)
    this.name = 'YamlValidationError'
    this.code = code
    this.path = path
  }
}

function yamlError(code, path, message) {
  return new YamlValidationError(code, path, message)
}

function stripComment(value) {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value.trimEnd()
}

function keyValueSeparator(value) {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === ':' && (index === value.length - 1 || /\s/.test(value[index + 1]))) {
      return index
    }
  }
  return -1
}

function splitKeyValue(value, path) {
  const index = keyValueSeparator(value)
  if (index >= 0) return [value.slice(0, index).trim(), value.slice(index + 1).trim()]
  throw yamlError('DEPLOY_YAML_PARSE_FAILED', path, 'expected a YAML mapping entry')
}

function parseScalar(value) {
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') {
    return value === '' ? undefined : null
  }
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) return JSON.parse(value)
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  ) {
    try {
      return JSON.parse(value)
    } catch {
      if (value === '[]') return []
      if (value === '{}') return {}
    }
  }
  return value
}

function tokenize(source, sourcePath) {
  const tokens = []
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index]
    if (/^[ \t]*\t/.test(original)) {
      throw yamlError(
        'DEPLOY_YAML_PARSE_FAILED',
        `${sourcePath}:${index + 1}`,
        'tabs are not allowed for YAML indentation',
      )
    }
    const content = stripComment(original)
    if (content.trim() === '' || content.trim() === '---' || content.trim() === '...') continue
    if (content.trimStart().startsWith('%')) continue
    if (
      content.trimStart().startsWith('<<:') ||
      /(?:^|[\s:[,{])(?:&|\*)[A-Za-z0-9_-]+(?:\s|$)/.test(content)
    ) {
      throw yamlError(
        'DEPLOY_YAML_UNSUPPORTED_REFERENCE',
        `${sourcePath}:${index + 1}`,
        'anchors, aliases, and merge keys are not supported by the deployment validator',
      )
    }
    const indent = content.length - content.trimStart().length
    tokens.push({ indent, text: content.trim(), line: index + 1, sourcePath })
  }
  return tokens
}

function parseBlock(tokens, start, indent) {
  const sequence = tokens[start]?.indent === indent && tokens[start].text.startsWith('-')
  const value = sequence ? [] : {}
  let index = start

  while (index < tokens.length && tokens[index].indent === indent) {
    const token = tokens[index]
    if (sequence !== token.text.startsWith('-')) {
      throw yamlError(
        'DEPLOY_YAML_PARSE_FAILED',
        `${token.sourcePath}:${token.line}`,
        'mixed YAML sequence and mapping',
      )
    }

    if (sequence) {
      const remainder = token.text.slice(1).trim()
      if (remainder === '') {
        if (!tokens[index + 1] || tokens[index + 1].indent <= indent) {
          value.push(null)
          index += 1
        } else {
          const nested = parseBlock(tokens, index + 1, tokens[index + 1].indent)
          value.push(nested.value)
          index = nested.index
        }
        continue
      }

      if (keyValueSeparator(remainder) < 0) {
        value.push(parseScalar(remainder))
        index += 1
        continue
      }

      const item = {}
      const [key, scalar] = splitKeyValue(remainder, `${token.sourcePath}:${token.line}`)
      if (scalar === undefined) {
        throw yamlError('DEPLOY_YAML_PARSE_FAILED', `${token.sourcePath}:${token.line}`, 'invalid YAML value')
      }
      if (scalar === '') {
        if (tokens[index + 1] && tokens[index + 1].indent > indent) {
          const nested = parseBlock(tokens, index + 1, tokens[index + 1].indent)
          item[key] = nested.value
          index = nested.index
        } else {
          item[key] = null
          index += 1
        }
      } else {
        item[key] = parseScalar(scalar)
        index += 1
      }
      if (tokens[index] && tokens[index].indent > indent) {
        const nested = parseBlock(tokens, index, tokens[index].indent)
        if (Array.isArray(nested.value)) {
          throw yamlError(
            'DEPLOY_YAML_PARSE_FAILED',
            `${tokens[index].sourcePath}:${tokens[index].line}`,
            'unexpected YAML sequence',
          )
        }
        for (const nestedKey of Object.keys(nested.value)) {
          if (Object.hasOwn(item, nestedKey)) {
            throw yamlError(
              'DEPLOY_YAML_DUPLICATE_KEY',
              `${tokens[index].sourcePath}:${tokens[index].line}`,
              `duplicate YAML key ${nestedKey}`,
            )
          }
        }
        Object.assign(item, nested.value)
        index = nested.index
      }
      value.push(item)
      continue
    }

    const [key, scalar] = splitKeyValue(token.text, `${token.sourcePath}:${token.line}`)
    if (Object.hasOwn(value, key)) {
      throw yamlError(
        'DEPLOY_YAML_DUPLICATE_KEY',
        `${token.sourcePath}:${token.line}`,
        `duplicate YAML key ${key}`,
      )
    }
    if (scalar === '') {
      const next = tokens[index + 1]
      const indentationlessSequence =
        next && next.indent === indent && next.text.startsWith('-')
      if (next && (next.indent > indent || indentationlessSequence)) {
        const nested = parseBlock(tokens, index + 1, tokens[index + 1].indent)
        value[key] = nested.value
        index = nested.index
      } else {
        value[key] = null
        index += 1
      }
    } else if (/^[|>][-+]?\d*$/.test(scalar)) {
      const blockIndent = tokens[index + 1]?.indent
      const block = []
      index += 1
      while (index < tokens.length && blockIndent !== undefined && tokens[index].indent >= blockIndent) {
        block.push(tokens[index].text)
        index += 1
      }
      value[key] = block.join(scalar.startsWith('>') ? ' ' : '\n')
    } else {
      value[key] = parseScalar(scalar)
      index += 1
    }
  }

  return { value, index }
}

export function parseYamlDocuments(source, sourcePath = '<yaml>') {
  const documentSources = source.split(/^---\s*$/m)
  const documents = []
  for (const documentSource of documentSources) {
    const trimmed = documentSource.trim()
    if (trimmed === '' || trimmed.split(/\r?\n/).every((line) => line.trimStart().startsWith('#'))) continue
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        documents.push(JSON.parse(trimmed))
      } catch (error) {
        throw yamlError(
          'DEPLOY_YAML_PARSE_FAILED',
          sourcePath,
          error instanceof Error ? error.message : String(error),
        )
      }
      continue
    }
    const tokens = tokenize(documentSource, sourcePath)
    if (tokens.length === 0) continue
    const parsed = parseBlock(tokens, 0, tokens[0].indent)
    if (parsed.index !== tokens.length) {
      const token = tokens[parsed.index]
      throw yamlError(
        'DEPLOY_YAML_PARSE_FAILED',
        `${sourcePath}:${token.line}`,
        'unsupported YAML indentation',
      )
    }
    documents.push(parsed.value)
  }
  return documents
}

export function loadYamlDocuments(path) {
  return parseYamlDocuments(readFileSync(path, 'utf8'), path)
}
