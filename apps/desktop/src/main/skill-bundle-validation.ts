export const VALID_OPENCODE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_DESCRIPTION_LENGTH = 1024

function parseSkillFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match?.[1]) return {}

  const result: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const separatorIndex = rawLine.indexOf(':')
    if (separatorIndex === -1) continue
    const key = rawLine.slice(0, separatorIndex).trim()
    const value = rawLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!key || !value) continue
    result[key] = value
  }
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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
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

export function assertValidOpenCodeSkillBundle(input: {
  name: string
  content: string
}, sourceLabel: string) {
  const issues = validateOpenCodeSkillBundle(input)
  if (issues.length === 0) return
  throw new Error(`${sourceLabel}: ${issues[0]}`)
}

// The runtime owns the bundle directory name, so we canonicalize the
// frontmatter `name` field on write to keep the saved SKILL.md aligned
// with the bundle's actual directory.
export function writeSkillNameIntoFrontmatter(content: string, skillName: string) {
  const serialized = `name: ${skillName}`
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!frontmatterMatch) {
    return `---\n${serialized}\n---\n\n${content.replace(/^[\s]+/, '')}`
  }

  const frontmatter = frontmatterMatch[1]
  const rest = content.slice(frontmatterMatch[0].length)
  const lines = frontmatter.split(/\r?\n/)
  let replaced = false
  const nextLines = lines.map((line) => {
    if (/^\s*name\s*:/.test(line)) {
      replaced = true
      return serialized
    }
    return line
  })
  const nextFrontmatter = replaced
    ? nextLines.join('\n')
    : `${serialized}\n${frontmatter}`.replace(/\n+$/, '')

  return `---\n${nextFrontmatter}\n---${rest.startsWith('\n') || rest.startsWith('\r') ? '' : '\n'}${rest}`
}
