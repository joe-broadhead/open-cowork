// Re-export from runtime-host so agent composition and desktop tests share one
// permission-inheritance implementation (wired into buildOpenCoworkAgentConfig).
export {
  assertPermissionInheritanceSafe,
  buildAgentPermissionMatrix,
  findPermissionInheritanceIssues,
  remoteApprovalFixtureMatrix,
  type AgentPermissionMatrixEntry,
  type PermissionInheritanceAction,
  type PermissionInheritanceAgentConfig,
  type PermissionInheritanceIssue,
  type SensitivePermissionKey,
} from '@open-cowork/runtime-host/permission-inheritance'
