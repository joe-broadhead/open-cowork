/**
 * Private realtime voice IPC scaffold (JOE-1096 / JOE-1097).
 *
 * Handlers are intentional stubs until Aurum STT + sibling TTS are wired in the
 * voice host. They never capture audio in the renderer and never claim readiness.
 */
import {
  isDesktopFeatureEnabled,
  VOICE_HOST_DEFERRED_REASON,
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

function currentStatus(): VoiceHostStatus {
  return voiceHostStatusForFeatures(getAppConfig().features)
}

function assertVoiceFeatureEnabled() {
  if (!isDesktopFeatureEnabled(getAppConfig().features, 'voice')) {
    throw new Error('Private voice is disabled. Set features.voice to true in open-cowork.config.json to opt in.')
  }
}

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

export function registerVoiceHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'voice:status', noIpcArgs, async () => currentStatus())

  registerIpcInvoke(
    context,
    'voice:session:start',
    optionalObjectArg<VoiceSessionStartInput>('voice session start input'),
    async (_event, input) => {
      assertVoiceFeatureEnabled()
      const normalized = normalizeStartInput(input as Record<string, unknown> | undefined)
      // Scaffold: refuse to open a live capture session until the host is real.
      throw new Error(
        `Voice session start is deferred: ${VOICE_HOST_DEFERRED_REASON}`
        + (normalized.openCodeSessionId ? ` (session ${normalized.openCodeSessionId})` : ''),
      )
    },
  )

  registerIpcInvoke(
    context,
    'voice:session:stop',
    optionalStringArg('voice session id'),
    async () => currentStatus(),
  )

  registerIpcInvoke(
    context,
    'voice:session:cancel',
    optionalStringArg('voice session id'),
    async () => currentStatus(),
  )
}

export type { VoiceHostStatus, VoiceSessionSnapshot, VoiceSessionStartInput }
export { voiceHostStatusForFeatures }
