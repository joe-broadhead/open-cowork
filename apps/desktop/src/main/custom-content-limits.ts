export const CUSTOM_AGENT_LIMITS = {
  descriptionBytes: 2 * 1024,
  instructionsBytes: 64 * 1024,
  avatarBytes: 256 * 1024,
  skillNames: 64,
  toolIds: 64,
  deniedToolPatterns: 128,
  optionsBytes: 32 * 1024,
  optionsDepth: 8,
} as const

export const CUSTOM_SKILL_LIMITS = {
  skillContentBytes: 100 * 1024,
  fileCount: 64,
  fileBytes: 256 * 1024,
  totalFileBytes: 1024 * 1024,
  pathDepth: 6,
} as const

export const CUSTOM_MCP_LIMITS = {
  labelBytes: 256,
  descriptionBytes: 2 * 1024,
  commandBytes: 1024,
  argBytes: 4 * 1024,
  args: 64,
  env: 64,
  headers: 64,
  keyBytes: 256,
  valueBytes: 8 * 1024,
  urlBytes: 4 * 1024,
} as const

export type CustomContentLimitIssue = {
  code: string
  message: string
}

type CustomAgentLimitInput = {
  description?: string | null
  instructions?: string | null
  avatar?: string | null
  skillNames?: string[] | null
  toolIds?: string[] | null
  deniedToolPatterns?: string[] | null
  options?: Record<string, unknown> | null
}

type CustomSkillFileInput = {
  path: string
  content: string
}

type CustomMcpLimitInput = {
  label?: string | null
  description?: string | null
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
}

export function textBytes(value: unknown) {
  return Buffer.byteLength(typeof value === 'string' ? value : '', 'utf8')
}

function jsonDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return Number.POSITIVE_INFINITY
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return 1 + Math.max(0, ...value.map((entry) => jsonDepth(entry, seen)))
    }
    return 1 + Math.max(0, ...Object.values(value).map((entry) => jsonDepth(entry, seen)))
  } finally {
    seen.delete(value)
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

export function validateCustomAgentContentLimits(agent: CustomAgentLimitInput): CustomContentLimitIssue[] {
  const issues: CustomContentLimitIssue[] = []
  pushBytesIssue(issues, 'description_too_large', 'Agent description', textBytes(agent.description), CUSTOM_AGENT_LIMITS.descriptionBytes)
  pushBytesIssue(issues, 'instructions_too_large', 'Agent instructions', textBytes(agent.instructions), CUSTOM_AGENT_LIMITS.instructionsBytes)
  pushBytesIssue(issues, 'avatar_too_large', 'Agent avatar', textBytes(agent.avatar), CUSTOM_AGENT_LIMITS.avatarBytes)
  pushCountIssue(issues, 'too_many_skills', 'Agent skills', agent.skillNames?.length || 0, CUSTOM_AGENT_LIMITS.skillNames)
  pushCountIssue(issues, 'too_many_tools', 'Agent tools', agent.toolIds?.length || 0, CUSTOM_AGENT_LIMITS.toolIds)
  pushCountIssue(issues, 'too_many_denied_tool_patterns', 'Agent denied tool patterns', agent.deniedToolPatterns?.length || 0, CUSTOM_AGENT_LIMITS.deniedToolPatterns)

  if (agent.options && typeof agent.options === 'object') {
    const depth = jsonDepth(agent.options)
    if (depth > CUSTOM_AGENT_LIMITS.optionsDepth) {
      issues.push({
        code: 'options_too_deep',
        message: `Agent options are too deeply nested (${depth}; limit ${CUSTOM_AGENT_LIMITS.optionsDepth}).`,
      })
    }
    try {
      pushBytesIssue(
        issues,
        'options_too_large',
        'Agent options',
        textBytes(JSON.stringify(agent.options)),
        CUSTOM_AGENT_LIMITS.optionsBytes,
      )
    } catch {
      issues.push({
        code: 'options_not_json_serializable',
        message: 'Agent options must be JSON-serializable.',
      })
    }
  }

  return issues
}

export function assertCustomAgentContentLimits(agent: CustomAgentLimitInput) {
  const issue = validateCustomAgentContentLimits(agent)[0]
  if (issue) throw new Error(issue.message)
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

export function validateCustomSkillFiles(files: CustomSkillFileInput[] = []): CustomContentLimitIssue[] {
  const issues: CustomContentLimitIssue[] = []
  pushCountIssue(issues, 'too_many_skill_files', 'Skill supporting files', files.length, CUSTOM_SKILL_LIMITS.fileCount)

  let totalBytes = 0
  const seenPaths = new Set<string>()
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/')
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

function validateStringRecord(
  issues: CustomContentLimitIssue[],
  value: Record<string, string> | null | undefined,
  label: string,
  maxEntries: number,
) {
  const entries = Object.entries(value || {})
  pushCountIssue(issues, `${label.toLowerCase()}_too_many_entries`, label, entries.length, maxEntries)
  for (const [key, entryValue] of entries) {
    pushBytesIssue(issues, `${label.toLowerCase()}_key_too_large`, `${label} key`, textBytes(key), CUSTOM_MCP_LIMITS.keyBytes)
    if (typeof entryValue !== 'string') {
      issues.push({
        code: `${label.toLowerCase()}_value_invalid`,
        message: `${label} values must be strings.`,
      })
    } else {
      pushBytesIssue(issues, `${label.toLowerCase()}_value_too_large`, `${label} value`, textBytes(entryValue), CUSTOM_MCP_LIMITS.valueBytes)
    }
  }
}

export function validateCustomMcpContentLimits(mcp: CustomMcpLimitInput): CustomContentLimitIssue[] {
  const issues: CustomContentLimitIssue[] = []
  pushBytesIssue(issues, 'mcp_label_too_large', 'MCP label', textBytes(mcp.label), CUSTOM_MCP_LIMITS.labelBytes)
  pushBytesIssue(issues, 'mcp_description_too_large', 'MCP description', textBytes(mcp.description), CUSTOM_MCP_LIMITS.descriptionBytes)
  pushBytesIssue(issues, 'mcp_command_too_large', 'MCP command', textBytes(mcp.command), CUSTOM_MCP_LIMITS.commandBytes)
  pushBytesIssue(issues, 'mcp_url_too_large', 'MCP URL', textBytes(mcp.url), CUSTOM_MCP_LIMITS.urlBytes)

  const args = Array.isArray(mcp.args) ? mcp.args : []
  pushCountIssue(issues, 'mcp_too_many_args', 'MCP args', args.length, CUSTOM_MCP_LIMITS.args)
  for (const arg of args) {
    pushBytesIssue(issues, 'mcp_arg_too_large', 'MCP argument', textBytes(arg), CUSTOM_MCP_LIMITS.argBytes)
  }

  validateStringRecord(issues, mcp.env, 'MCP env', CUSTOM_MCP_LIMITS.env)
  validateStringRecord(issues, mcp.headers, 'MCP headers', CUSTOM_MCP_LIMITS.headers)
  return issues
}

export function assertCustomMcpContentLimits(mcp: CustomMcpLimitInput) {
  const issue = validateCustomMcpContentLimits(mcp)[0]
  if (issue) throw new Error(issue.message)
}
