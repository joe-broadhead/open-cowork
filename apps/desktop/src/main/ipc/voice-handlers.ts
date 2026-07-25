/**
 * Private realtime voice IPC (JOE-1096 / JOE-1097 / JOE-1108).
 *
 * Capture + PCM + STT + TTS live in VoiceHost (main). IPC returns status/text
 * only — never raw audio. STT: Aurum local_only. TTS: OS system speech sibling.
 */
import {
  isDesktopFeatureEnabled,
  voiceHostStatusForFeatures,
  type VoiceHostStatus,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
  type VoiceTtsSpeakInput,
} from '@open-cowork/shared'
import { getAppConfig } from '@open-cowork/runtime-host/config'
import type { IpcHandlerContext } from './context.ts'
import {
  noIpcArgs,
  objectArg,
  optionalObjectArg,
  optionalStringArg,
  registerIpcInvoke,
} from './schema.ts'
import { getVoiceHost } from '../voice-host.ts'
import { VOICE_TTS_MAX_TEXT_CHARS } from '../voice-tts.ts'

function normalizeStartInput(value: Record<string, unknown> | undefined): VoiceSessionStartInput {
  if (!value) return {}
  const openCodeSessionId = typeof value.openCodeSessionId === 'string' && value.openCodeSessionId.trim()
    ? value.openCodeSessionId.trim()
    : null
  const workspaceId = typeof value.workspaceId === 'string' && value.workspaceId.trim()
    ? value.workspaceId.trim()
    : null
  const mode = value.mode === 'conversation' || value.mode === 'ptt' ? value.mode : undefined
  const continuousVad = value.continuousVad === true
  return {
    ...(openCodeSessionId ? { openCodeSessionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(mode ? { mode } : {}),
    ...(continuousVad ? { continuousVad: true } : {}),
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

  registerIpcInvoke(
    context,
    'voice:tts:speak',
    objectArg<VoiceTtsSpeakInput>('voice tts speak input', (record, channel) => {
      const text = typeof record.text === 'string' ? record.text : ''
      if (!text.trim()) throw new Error(`${channel} requires non-empty text.`)
      if (Buffer.byteLength(text, 'utf8') > VOICE_TTS_MAX_TEXT_CHARS * 4) {
        throw new Error(`${channel} text is too large.`)
      }
      if (text.length > VOICE_TTS_MAX_TEXT_CHARS) {
        throw new Error(`${channel} text exceeds ${VOICE_TTS_MAX_TEXT_CHARS} characters.`)
      }
      const voiceId = typeof record.voiceId === 'string' && record.voiceId.trim()
        ? record.voiceId.trim()
        : null
      const rate = typeof record.rate === 'number' && Number.isFinite(record.rate)
        ? record.rate
        : null
      return { text, voiceId, rate }
    }),
    async (_event, input) => {
      const voiceHost = syncHostFeatures()
      if (!isDesktopFeatureEnabled(getAppConfig().features, 'voice')) {
        throw new Error('Private voice is disabled. Set features.voice to true in open-cowork.config.json to opt in.')
      }
      try {
        const status = await voiceHost.speak(input)
        broadcastVoiceEvent(context, { type: 'status', status })
        return status
      } catch (error) {
        broadcastVoiceEvent(context, { type: 'status', status: voiceHost.getStatus() })
        throw error
      }
    },
  )

  registerIpcInvoke(context, 'voice:tts:cancel', noIpcArgs, async () => {
    const voiceHost = syncHostFeatures()
    const status = await voiceHost.cancelSpeak()
    broadcastVoiceEvent(context, { type: 'status', status })
    return status
  })

  registerIpcInvoke(context, 'voice:tts:voices', noIpcArgs, async () => {
    const voiceHost = syncHostFeatures()
    return voiceHost.listTtsVoices()
  })
}

export type { VoiceHostStatus, VoiceSessionSnapshot, VoiceSessionStartInput }
export { voiceHostStatusForFeatures }
