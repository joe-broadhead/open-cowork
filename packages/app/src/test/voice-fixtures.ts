import type {
  CoworkAPI,
  VoiceAssetStatusSnapshot,
  VoiceHostStatus,
} from '@open-cowork/shared'

export function createTestVoiceHostStatus(
  overrides: Partial<VoiceHostStatus> = {},
): VoiceHostStatus {
  return {
    enabled: true,
    phase: 'ready',
    captureMode: 'voice_host',
    stt: {
      engine: 'aurum_local',
      ready: true,
      detail: 'ready',
    },
    tts: {
      engine: 'system_os',
      ready: true,
      detail: 'ready',
    },
    permissions: {
      microphone: 'granted',
    },
    reason: null,
    sessionId: null,
    ...overrides,
  }
}

function createTestVoiceAssetsStatus(): VoiceAssetStatusSnapshot {
  return {
    stt: {
      model: 'tiny-q5_1',
      modelFile: 'tiny-q5_1.bin',
      ready: true,
      cacheDir: '/tmp/open-cowork-voice',
      modelPath: '/tmp/open-cowork-voice/tiny-q5_1.bin',
      integrity: 'ok',
      allowDownload: false,
      cliAvailable: true,
      detail: null,
    },
    tts: {
      ready: true,
      backend: 'fake',
      detail: null,
    },
    offlineReady: true,
  }
}

export function createTestVoiceApi(
  overrides: Partial<CoworkAPI['voice']> = {},
): CoworkAPI['voice'] {
  const readyStatus = createTestVoiceHostStatus()
  return {
    status: async () => readyStatus,
    startSession: async (input) => ({
      id: 'voice-test-session',
      openCodeSessionId: input?.openCodeSessionId ?? null,
      workspaceId: input?.workspaceId ?? 'local',
      mode: input?.mode ?? 'ptt',
      phase: 'listening',
      startedAt: '2026-01-01T00:00:00.000Z',
      continuousVad: input?.continuousVad,
    }),
    stopSession: async () => readyStatus,
    cancel: async () => readyStatus,
    speak: async () => readyStatus,
    cancelSpeak: async () => readyStatus,
    listVoices: async () => [],
    assetsStatus: async () => createTestVoiceAssetsStatus(),
    ensureAssets: async () => ({
      status: createTestVoiceAssetsStatus(),
      action: 'already_ready',
      detail: 'Voice assets are ready.',
    }),
    ...overrides,
  }
}
