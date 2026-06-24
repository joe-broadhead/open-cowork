import {
  buildManagedExternalDirectoryRules,
  buildManagedSkillRules,
  buildPermissionConfig,
  type PermissionAction,
} from './permission-config.js'

export function buildCoworkRuntimePermissionConfig(options: {
  managedSkillNames: string[]
  allowPatterns: string[]
  askPatterns: string[]
  deniedPatterns?: string[]
  bash: PermissionAction
  fileWrite: PermissionAction
  task: PermissionAction
  web: PermissionAction
  webSearch: PermissionAction
  externalDirectory: PermissionAction
  projectDirectory?: string | null
}) {
  return buildPermissionConfig({
    skillRules: buildManagedSkillRules(options.managedSkillNames),
    externalDirectoryRules: buildManagedExternalDirectoryRules({
      skillNames: options.managedSkillNames,
      projectDirectory: options.projectDirectory,
      action: options.externalDirectory,
    }),
    allowPatterns: options.allowPatterns,
    askPatterns: options.askPatterns,
    deniedPatterns: options.deniedPatterns,
    question: 'deny',
    task: options.task,
    todoWrite: 'allow',
    web: options.web,
    webSearch: options.webSearch,
    bash: options.bash,
    edit: options.fileWrite,
  })
}
