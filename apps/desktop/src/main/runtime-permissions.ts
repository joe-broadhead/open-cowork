import {
  buildManagedExternalDirectoryRules,
  buildManagedSkillRules,
  buildPermissionConfig,
} from './permission-config.ts'

export function buildCoworkRuntimePermissionConfig(options: {
  managedSkillNames: string[]
  allowPatterns: string[]
  askPatterns: string[]
  allowBash: boolean
  allowEdits: boolean
  projectDirectory?: string | null
}) {
  return buildPermissionConfig({
    skillRules: buildManagedSkillRules(options.managedSkillNames),
    externalDirectoryRules: buildManagedExternalDirectoryRules({
      skillNames: options.managedSkillNames,
      projectDirectory: options.projectDirectory,
    }),
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
