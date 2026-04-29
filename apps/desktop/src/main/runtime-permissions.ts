import {
  buildManagedExternalDirectoryRules,
  buildManagedSkillRules,
  buildPermissionConfig,
  type PermissionAction,
} from './permission-config.ts'

export function buildCoworkRuntimePermissionConfig(options: {
  managedSkillNames: string[]
  allowPatterns: string[]
  askPatterns: string[]
  bash: PermissionAction
  fileWrite: PermissionAction
  task: PermissionAction
  web: PermissionAction
  webSearch: PermissionAction
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
    task: options.task,
    todoWrite: 'allow',
    web: options.web,
    webSearch: options.webSearch,
    bash: options.bash,
    edit: options.fileWrite,
  })
}
