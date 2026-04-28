import type { BrowserWindow, IpcMain } from 'electron'
import type {
  CapabilityTool,
  CapabilityToolEntry,
  CustomAgentConfig,
  DestructiveConfirmationRequest,
  RuntimeContextOptions,
  ScopedArtifactRef,
  SessionArtifactRequest,
  ToolListOptions,
} from '@open-cowork/shared'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { SessionRecord } from '../session-registry'

export type ScopedTarget = ScopedArtifactRef & { directory: string | null }

export type SessionClientContext = {
  client: OpencodeClient
  record: SessionRecord | null
}

export type SessionV2ClientContext = {
  client: OpencodeClient
  record: SessionRecord
  directory: string
}

export type IpcHandlerContext = {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  getMainWindow: () => BrowserWindow | null
  normalizeDirectory: (directory?: string | null) => string
  ensureSessionRecord: (sessionId: string) => SessionRecord | null
  resolvePrivateArtifactPath: (request: SessionArtifactRequest) => { root: string; source: string }
  grantProjectDirectory: (directory: string) => string
  resolveGrantedProjectDirectory: (directory?: string | null) => string | null
  resolveContextDirectory: (options?: RuntimeContextOptions) => string | null
  resolveScopedTarget: <T extends ScopedArtifactRef>(target: T) => T & { directory: string | null }
  buildCustomAgentPermission: (agent: CustomAgentConfig, options?: RuntimeContextOptions) => Promise<Record<string, unknown>>
  logHandlerError: (handler: string, err: unknown) => void
  describeDestructiveRequest: (request: DestructiveConfirmationRequest) => string
  consumeDestructiveConfirmation: (request: DestructiveConfirmationRequest, token?: string | null) => boolean
  reconcileIdleSession: (sessionId: string) => void
  getSessionClient: (sessionId: string) => Promise<SessionClientContext>
  getSessionV2Client: (sessionId: string) => Promise<SessionV2ClientContext>
  listRuntimeTools: (options?: ToolListOptions) => Promise<unknown[]>
  withDiscoveredBuiltInTools: (
    tools: CapabilityTool[],
    runtimeTools: unknown[],
    options?: RuntimeContextOptions,
  ) => Promise<CapabilityTool[]>
  listToolsFromMcpEntry: (entry: unknown) => Promise<CapabilityToolEntry[]>
  isLikelyMcpAuthError: (error: unknown) => boolean
  authenticateNewRemoteMcpIfNeeded: (name: string) => Promise<void>
  approvedSkillImportDirectories: Map<string, string>
  capabilityToolMethodCache: Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>
}
