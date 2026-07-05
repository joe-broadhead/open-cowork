import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import type { SessionRecord } from '@open-cowork/runtime-host/session-registry'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { getClientForDirectory, getRuntimeHomeDir, getV2ClientForDirectory } from '@open-cowork/runtime-host/runtime'
import { ensureRuntimeContextDirectory } from '@open-cowork/runtime-host/runtime-context'
import type {
  RuntimeContextOptions,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { getBrandName } from './config-loader.ts'
type RuntimeContextDependencies = {
  ensureSessionRecord: (sessionId: string) => SessionRecord | null
  resolveGrantedProjectDirectory: (directory?: string | null) => string | null
}

export function createIpcRuntimeContext(dependencies: RuntimeContextDependencies) {
  function resolveSessionRuntimeModel(sessionId: string) {
    const settings = getEffectiveSettings()
    const view = sessionEngine.getSessionView(sessionId)
    const latestModeledMessage = [...view.messages]
      .reverse()
      .find((message) => message.providerId || message.modelId) || null
    const record = dependencies.ensureSessionRecord(sessionId)

    return {
      provider: latestModeledMessage?.providerId || record?.providerId || settings.effectiveProviderId || '',
      model: latestModeledMessage?.modelId || record?.modelId || settings.effectiveModel || '',
      directory: record?.opencodeDirectory || getRuntimeHomeDir(),
    }
  }

  function resolveContextDirectory(options?: RuntimeContextOptions) {
    if (options?.sessionId) {
      const record = dependencies.ensureSessionRecord(options.sessionId)
      return record?.directory ? dependencies.resolveGrantedProjectDirectory(record.directory) : null
    }
    return dependencies.resolveGrantedProjectDirectory(options?.directory)
  }

  function resolveScopedTarget<T extends ScopedArtifactRef>(target: T): T & { directory: string | null } {
    if (target.scope === 'project') {
      const directory = dependencies.resolveGrantedProjectDirectory(target.directory)
      if (!directory) {
        throw new Error('Project scope requires an active project directory.')
      }
      return { ...target, directory }
    }
    return { ...target, directory: null }
  }

  async function getSessionClient(sessionId: string) {
    const record = dependencies.ensureSessionRecord(sessionId)
    if (!record) {
      throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)
    }
    const directory = record.opencodeDirectory || getRuntimeHomeDir()
    await ensureRuntimeContextDirectory(directory)
    const client = getClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return { client, record }
  }

  async function getSessionV2Client(sessionId: string) {
    const record = dependencies.ensureSessionRecord(sessionId)
    if (!record) {
      throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)
    }
    const directory = record.opencodeDirectory || getRuntimeHomeDir()
    await ensureRuntimeContextDirectory(directory)
    const client = getV2ClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return { client, record, directory }
  }

  return {
    resolveSessionRuntimeModel,
    resolveContextDirectory,
    resolveScopedTarget,
    getSessionClient,
    getSessionV2Client,
  }
}
