export const VALID_OPENCODE_SKILL_NAME = {
  test: isValidOpenCodeSkillName,
} as const

export const CUSTOM_SKILL_LIMITS = {
  skillContentBytes: 100 * 1024,
  fileCount: 64,
  fileBytes: 256 * 1024,
  totalFileBytes: 1024 * 1024,
  pathDepth: 6,
} as const

export type CustomContentLimitIssue = {
  code: string
  message: string
}

export type CustomSkillFileInput = {
  path: string
  content: string
}

const MAX_SKILL_DESCRIPTION_LENGTH = 1024

type FrontmatterBlock = {
  content: string
  bodyStart: number
}

export function textBytes(value: unknown) {
  let bytes = 0
  for (const char of typeof value === 'string' ? value : '') {
    const code = char.codePointAt(0) || 0
    bytes += code <= 0x7f
      ? 1
      : code <= 0x7ff
        ? 2
        : code <= 0xffff
          ? 3
          : 4
  }
  return bytes
}

export function isValidOpenCodeSkillName(value: string) {
  if (value.length < 1 || value.length > 64) return false
  let previousWasHyphen = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isLowercaseLetter = code >= 97 && code <= 122
    const isDigit = code >= 48 && code <= 57
    const isHyphen = code === 45
    if (!isLowercaseLetter && !isDigit && !isHyphen) return false
    if (isHyphen && (index === 0 || index === value.length - 1 || previousWasHyphen)) return false
    previousWasHyphen = isHyphen
  }
  return true
}

function findLineEnd(content: string, start: number) {
  for (let index = start; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code === 10 || code === 13) return index
  }
  return content.length
}

function lineBreakLengthAt(content: string, index: number) {
  const code = content.charCodeAt(index)
  if (code === 13 && content.charCodeAt(index + 1) === 10) return 2
  return code === 10 || code === 13 ? 1 : 0
}

function readFrontmatterBlock(content: string): FrontmatterBlock | null {
  if (!content.startsWith('---')) return null
  const firstLineEnd = findLineEnd(content, 0)
  if (content.slice(0, firstLineEnd) !== '---') return null
  const firstBreakLength = lineBreakLengthAt(content, firstLineEnd)
  if (firstBreakLength === 0) return null

  const frontmatterStart = firstLineEnd + firstBreakLength
  let cursor = frontmatterStart
  while (cursor <= content.length) {
    const lineStart = cursor
    const lineEnd = findLineEnd(content, lineStart)
    const lineBreakLength = lineBreakLengthAt(content, lineEnd)
    if (content.slice(lineStart, lineEnd) === '---') {
      return {
        content: content.slice(frontmatterStart, lineStart),
        bodyStart: lineEnd + lineBreakLength,
      }
    }
    if (lineBreakLength === 0) return null
    cursor = lineEnd + lineBreakLength
  }
  return null
}

function forEachLine(content: string, visit: (line: string) => void) {
  let cursor = 0
  while (cursor <= content.length) {
    const lineEnd = findLineEnd(content, cursor)
    visit(content.slice(cursor, lineEnd))
    const lineBreakLength = lineBreakLengthAt(content, lineEnd)
    if (lineBreakLength === 0) return
    cursor = lineEnd + lineBreakLength
  }
}

function stripOuterQuotes(value: string) {
  let next = value
  const first = next[0]
  if (first === '\'' || first === '"') next = next.slice(1)
  const last = next[next.length - 1]
  if (last === '\'' || last === '"') next = next.slice(0, -1)
  return next
}

function parseSkillFrontmatter(content: string) {
  const block = readFrontmatterBlock(content)
  if (!block) return {}

  const result: Record<string, string> = {}
  forEachLine(block.content, (rawLine) => {
    if (!rawLine.trim()) return
    const separatorIndex = rawLine.indexOf(':')
    if (separatorIndex === -1) return
    const key = rawLine.slice(0, separatorIndex).trim()
    const value = stripOuterQuotes(rawLine.slice(separatorIndex + 1).trim())
    if (!key || !value) return
    result[key] = value
  })
  return result
}

function extractFrontmatterField(content: string, field: string) {
  return parseSkillFrontmatter(content)[field] || null
}

export function extractSkillFrontmatterName(content: string) {
  return extractFrontmatterField(content, 'name')
}

export function extractSkillFrontmatterDescription(content: string) {
  return extractFrontmatterField(content, 'description')
}

export function normalizeSkillBundleName(value: string) {
  let result = ''
  let previousWasHyphen = false
  for (const char of value.trim().toLowerCase()) {
    const code = char.charCodeAt(0)
    const isLowercaseLetter = code >= 97 && code <= 122
    const isDigit = code >= 48 && code <= 57
    const next = isLowercaseLetter || isDigit ? char : '-'
    if (next === '-') {
      if (!result || previousWasHyphen) continue
      previousWasHyphen = true
    } else {
      previousWasHyphen = false
    }
    result += next
    if (result.length >= 64) break
  }
  return result.endsWith('-') ? result.slice(0, -1) : result
}

export function validateOpenCodeSkillBundle(input: {
  name: string
  content: string
}): string[] {
  const issues: string[] = []
  const normalizedName = input.name.trim()
  const frontmatterName = extractSkillFrontmatterName(input.content)
  const description = extractSkillFrontmatterDescription(input.content)

  if (!VALID_OPENCODE_SKILL_NAME.test(normalizedName)) {
    issues.push('Skill bundle names must use 1-64 lowercase letters, numbers, and single hyphens only.')
  }

  if (!frontmatterName) {
    issues.push('SKILL.md must include a frontmatter name.')
  } else {
    if (!VALID_OPENCODE_SKILL_NAME.test(frontmatterName)) {
      issues.push('SKILL.md frontmatter name must use the OpenCode skill-name format.')
    }
    if (frontmatterName !== normalizedName) {
      issues.push('SKILL.md frontmatter name must exactly match the skill directory name.')
    }
  }

  if (!description) {
    issues.push('SKILL.md must include a frontmatter description.')
  } else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    issues.push(`SKILL.md description must be ${MAX_SKILL_DESCRIPTION_LENGTH} characters or fewer.`)
  }

  return issues
}

export function assertValidOpenCodeSkillName(name: string, sourceLabel: string) {
  const trimmed = name.trim()
  if (name === trimmed && VALID_OPENCODE_SKILL_NAME.test(trimmed)) return
  throw new Error(`${sourceLabel}: Skill bundle names must use 1-64 lowercase letters, numbers, and single hyphens only.`)
}

export function assertValidOpenCodeSkillBundle(input: {
  name: string
  content: string
}, sourceLabel: string) {
  const issues = validateOpenCodeSkillBundle(input)
  if (issues.length === 0) return
  throw new Error(`${sourceLabel}: ${issues[0]}`)
}

export function validateCustomSkillContent(content: string): CustomContentLimitIssue[] {
  const bytes = textBytes(content)
  return bytes > CUSTOM_SKILL_LIMITS.skillContentBytes
    ? [{
        code: 'skill_content_too_large',
        message: `Skill content is too large (${bytes} bytes; limit ${CUSTOM_SKILL_LIMITS.skillContentBytes} bytes).`,
      }]
    : []
}

export function assertCustomSkillContent(content: string) {
  const issue = validateCustomSkillContent(content)[0]
  if (issue) throw new Error(issue.message)
}

function pushCountIssue(
  issues: CustomContentLimitIssue[],
  code: string,
  label: string,
  actual: number,
  limit: number,
) {
  if (actual > limit) {
    issues.push({
      code,
      message: `${label} has too many entries (${actual}; limit ${limit}).`,
    })
  }
}

function pushBytesIssue(
  issues: CustomContentLimitIssue[],
  code: string,
  label: string,
  actual: number,
  limit: number,
) {
  if (actual > limit) {
    issues.push({
      code,
      message: `${label} is too large (${actual} bytes; limit ${limit} bytes).`,
    })
  }
}

export function validateCustomSkillFiles(files: CustomSkillFileInput[] = []): CustomContentLimitIssue[] {
  const issues: CustomContentLimitIssue[] = []
  pushCountIssue(issues, 'too_many_skill_files', 'Skill supporting files', files.length, CUSTOM_SKILL_LIMITS.fileCount)

  let totalBytes = 0
  const seenPaths = new Set<string>()
  for (const file of files) {
    const normalizedPath = file.path.split('\\').join('/')
    if (seenPaths.has(normalizedPath)) {
      issues.push({
        code: 'duplicate_skill_file',
        message: `Skill file is duplicated: ${normalizedPath}`,
      })
    }
    seenPaths.add(normalizedPath)

    const depth = normalizedPath.split('/').filter(Boolean).length
    if (depth > CUSTOM_SKILL_LIMITS.pathDepth) {
      issues.push({
        code: 'skill_file_too_deep',
        message: `Skill file path is too deep: ${normalizedPath}`,
      })
    }

    const bytes = textBytes(file.content)
    totalBytes += bytes
    pushBytesIssue(issues, 'skill_file_too_large', `Skill file ${normalizedPath}`, bytes, CUSTOM_SKILL_LIMITS.fileBytes)
  }

  pushBytesIssue(issues, 'skill_files_too_large', 'Skill supporting files', totalBytes, CUSTOM_SKILL_LIMITS.totalFileBytes)
  return issues
}

export function assertCustomSkillFiles(files: CustomSkillFileInput[] = []) {
  const issue = validateCustomSkillFiles(files)[0]
  if (issue) throw new Error(issue.message)
}

// The runtime owns the bundle directory name, so we canonicalize the
// frontmatter `name` field on write to keep the saved SKILL.md aligned
// with the bundle's actual directory.
export function writeSkillNameIntoFrontmatter(content: string, skillName: string) {
  const serialized = `name: ${skillName}`
  const block = readFrontmatterBlock(content)
  if (!block) {
    return `---\n${serialized}\n---\n\n${content.trimStart()}`
  }

  const rest = content.slice(block.bodyStart)
  const nextLines: string[] = []
  let replaced = false
  forEachLine(block.content, (line) => {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex !== -1 && line.slice(0, separatorIndex).trim() === 'name') {
      replaced = true
      nextLines.push(serialized)
      return
    }
    nextLines.push(line)
  })
  const nextFrontmatter = replaced
    ? nextLines.join('\n')
    : `${serialized}\n${block.content}`.trimEnd()

  return `---\n${nextFrontmatter}\n---${rest.startsWith('\n') || rest.startsWith('\r') ? '' : '\n'}${rest}`
}
