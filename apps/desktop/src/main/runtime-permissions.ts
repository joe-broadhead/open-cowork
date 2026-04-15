import { buildManagedSkillRules, buildPermissionConfig } from './permission-config.ts'

export function buildCoworkRuntimePermissionConfig(options: {
  managedSkillNames: string[]
  allowPatterns: string[]
  askPatterns: string[]
  allowBash: boolean
  allowEdits: boolean
}) {
  return buildPermissionConfig({
    skillRules: buildManagedSkillRules(options.managedSkillNames),
    allowPatterns: options.allowPatterns,
    askPatterns: options.askPatterns,
    question: 'deny',
    task: 'deny',
    todoWrite: 'allow',
    web: 'allow',
    bash: options.allowBash ? 'allow' : 'deny',
    edit: options.allowEdits ? 'allow' : 'deny',
  })
}
