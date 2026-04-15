export type PermissionAction = 'allow' | 'ask' | 'deny'

export type PermissionRuleMap = Record<string, PermissionAction>

export function buildManagedSkillRules(skillNames: string[]): PermissionRuleMap {
  return Object.fromEntries(
    Array.from(new Set(skillNames.filter(Boolean))).sort((a, b) => a.localeCompare(b)).map((name) => [name, 'allow' as const]),
  )
}

export function buildPermissionConfig(options: {
  skillRules?: PermissionRuleMap
  allowAllSkills?: boolean
  toolPatternsToDeny?: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  question?: PermissionAction
  task?: PermissionAction | PermissionRuleMap
  todoWrite?: PermissionAction
  web?: PermissionAction
  bash?: PermissionAction
  edit?: PermissionAction
}) {
  const webAccess = options.web || 'deny'
  const editAccess = options.edit || 'deny'
  const permission: Record<string, unknown> = {
    skill: options.allowAllSkills
      ? 'allow'
      : {
          '*': 'deny',
          ...(options.skillRules || {}),
        },
    'mcp__*': 'deny',
    question: options.question || 'deny',
    task: typeof options.task === 'string'
      ? options.task
      : options.task
        ? { '*': 'deny', ...options.task }
        : 'deny',
    todowrite: options.todoWrite || 'deny',
    codesearch: webAccess,
    webfetch: webAccess,
    websearch: webAccess,
    bash: options.bash || 'deny',
    edit: editAccess,
    write: editAccess,
    apply_patch: editAccess,
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
  }

  for (const pattern of options.toolPatternsToDeny || []) permission[pattern] = 'deny'
  for (const pattern of options.askPatterns || []) permission[pattern] = 'ask'
  for (const pattern of options.allowPatterns || []) permission[pattern] = 'allow'

  return permission
}
