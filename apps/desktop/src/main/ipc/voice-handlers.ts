/**
 * Private realtime voice IPC (JOE-1096 / JOE-1097).
 *
 * Capture + PCM live in VoiceHost (main). IPC returns status/session text only —
 * never raw audio. STT remains deferred until Aurum is wired (V1.2).
 */
import {
  isDesktopFeatureEnabled,
  voiceHostStatusForFeatures,
  type VoiceHostStatus,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
} from '@open-cowork/shared'
import { getAppConfig } from '@open-cowork/runtime-host/config'
import type { IpcHandlerContext } from './context.ts'
import {
  noIpcArgs,
  optionalObjectArg,
  optionalStringArg,
  registerIpcInvoke,
} from './schema.ts'
import { getVoiceHost } from '../voice-host.ts'

function normalizeStartInput(value: Record<string, unknown> | undefined): VoiceSessionStartInput {
  if (!value) return {}
  const openCodeSessionId = typeof value.openCodeSessionId === 'string' && value.openCodeSessionId.trim()
    ? value.openCodeSessionId.trim()
    : null
  const workspaceId = typeof value.workspaceId === 'string' && value.workspaceId.trim()
    ? value.workspaceId.trim()
    : null
  const mode = value.mode === 'conversation' || value.mode === 'ptt' ? value.mode : undefined
  return {
    ...(openCodeSessionId ? { openCodeSessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(mode ? { mode } : {}),
  }
}

function syncHostFeatures() {
  const host = getVoiceHost()
  host.setFeatures(getAppConfig().features)
  return host
}

function broadcastVoiceEvent(context: IpcHandlerContext, payload: unknown) {
  const win = context.getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('voice:event', payload)
  } catch {
    // window may be closing
  }
}

export function registerVoiceHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'voice:status', noIpcArgs, async () => {
    const voiceHost = syncHostFeatures()
    await voiceHost.refreshPermissions().catch(() => null)
    const status = voiceHost.getStatus()
    broadcastVoiceEvent(context, { type: 'status', status })
    return status
  })

  registerIpcInvoke(
    context,
    'voice:session:start',
    optionalObjectArg<VoiceSessionStartInput>('voice session start input'),
    async (_event, input) => {
      const voiceHost = syncHostFeatures()
      if (!isDesktopFeatureEnabled(getAppConfig().features, 'voice')) {
        throw new Error('Private voice is disabled. Set features.voice to true in open-cowork.config.json to opt in.')
      }
      const normalized = normalizeStartInput(input as Record<string, unknown> | undefined)
      const snapshot = await voiceHost.startSession(normalized)
      broadcastVoiceEvent(context, { type: 'status', status: voiceHost.getStatus() })
      return snapshot
    },
  )

  registerIpcInvoke(
    context,
    'voice:session:stop',
    optionalStringArg('voice session id'),
    async (_event, sessionId) => {
      const voiceHost = syncHostFeatures()
      const status = await voiceHost.stopSession(sessionId)
      broadcastVoiceEvent(context, { type: 'status', status })
      return status
    },
  )

  registerIpcInvoke(
    context,
    'voice:session:cancel',
    optionalStringArg('voice session id'),
    async (_event, sessionId) => {
      const voiceHost = syncHostFeatures()
      const status = await voiceHost.cancel(sessionId)
      broadcastVoiceEvent(context, { type: 'status', status })
      return status
    },
  )
}

export type { VoiceHostStatus, VoiceSessionSnapshot, VoiceSessionStartInput }
export { voiceHostStatusForFeatures }
