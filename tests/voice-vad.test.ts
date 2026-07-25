import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVadState,
  defaultConversationVadPolicy,
  isBargeInSpeech,
  tickVad,
  type VoiceVadPolicy,
} from '../apps/desktop/src/main/voice-vad.ts'
import { VOICE_PCM_SAMPLE_RATE } from '../apps/desktop/src/main/voice-pcm-buffer.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'
import { FakeVoiceStt } from '../apps/desktop/src/main/voice-stt.ts'
import {
  FakeVoiceTts,
  type VoiceTtsEngine,
  type VoiceTtsSpeakOptions,
  type VoiceTtsSynthResult,
  type VoiceTtsVoice,
} from '../apps/desktop/src/main/voice-tts.ts'
import type { VoiceHostEvent } from '../packages/shared/src/voice.ts'

function tone(frames: number, amplitude: number): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = amplitude
  return out
}

function silence(frames: number): Float32Array {
  return new Float32Array(frames)
}

test('default conversation VAD policy is energy-based with a hard listen cap', () => {
  const policy = defaultConversationVadPolicy()
  assert.ok(policy.speechRms > policy.silenceRms)
  assert.equal(policy.maxListenFrames, VOICE_PCM_SAMPLE_RATE * 30)
  assert.ok(policy.endSilenceFrames > policy.minSpeechFrames)
})

test('tickVad stays open during preroll silence and ends after speech + silence', () => {
  const policy: VoiceVadPolicy = {
    speechRms: 0.01,
    silenceRms: 0.005,
    minSpeechFrames: 100,
    endSilenceFrames: 200,
    maxListenFrames: 50_000,
    prerollFrames: 50,
  }
  let state = createVadState()

  let step = tickVad(state, silence(80), policy)
  assert.equal(step.shouldFinalize, false)
  assert.equal(step.state.speechActive, false)
  state = step.state

  step = tickVad(state, tone(120, 0.05), policy)
  assert.equal(step.state.speechActive, true)
  assert.equal(step.shouldFinalize, false)
  state = step.state

  step = tickVad(state, silence(250), policy)
  assert.equal(step.shouldFinalize, true)
  assert.equal(step.reason, 'silence')
  assert.equal(step.state.ended, true)
})

test('tickVad finalizes on max-listen timeout', () => {
  const policy: VoiceVadPolicy = {
    speechRms: 0.01,
    silenceRms: 0.005,
    minSpeechFrames: 10,
    endSilenceFrames: 10_000,
    maxListenFrames: 300,
    prerollFrames: 0,
  }
  let state = createVadState()
  let step = tickVad(state, tone(200, 0.05), policy)
  assert.equal(step.shouldFinalize, false)
  state = step.state
  step = tickVad(state, tone(200, 0.05), policy)
  assert.equal(step.shouldFinalize, true)
  assert.equal(step.reason, 'timeout')
  assert.equal(step.state.timedOut, true)
})

test('tickVad is idempotent after ended', () => {
  const policy: VoiceVadPolicy = {
    speechRms: 0.01,
    silenceRms: 0.005,
    minSpeechFrames: 10,
    endSilenceFrames: 10,
    maxListenFrames: 100,
    prerollFrames: 0,
  }
  let state = createVadState()
  state = tickVad(state, tone(50, 0.05), policy).state
  const ended = tickVad(state, silence(50), policy)
  assert.equal(ended.shouldFinalize, true)
  const again = tickVad(ended.state, tone(50, 0.05), policy)
  assert.equal(again.shouldFinalize, false)
  assert.equal(again.state.ended, true)
})

test('isBargeInSpeech uses a higher RMS gate than speech start', () => {
  const quiet = tone(320, 0.012)
  const loud = tone(320, 0.03)
  assert.equal(isBargeInSpeech(quiet), false)
  assert.equal(isBargeInSpeech(loud), true)
})

test('voice host continuous VAD auto-finalizes on max listen timeout', async () => {
  const events: VoiceHostEvent[] = []
  // Manual push only — avoid background sine that never ends.
  const capture = new FakeVoiceCapture({ intervalMs: 60_000, chunkFrames: 160 })
  const host = new VoiceHost({
    features: { voice: true },
    capture,
    stt: new FakeVoiceStt({ text: 'continuous timeout' }),
    tts: new FakeVoiceTts(),
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    partialsEnabled: false,
    vadPolicy: {
      speechRms: 0.01,
      silenceRms: 0.005,
      minSpeechFrames: 50,
      endSilenceFrames: 50_000,
      maxListenFrames: 400,
      prerollFrames: 0,
    },
  })

  const session = await host.startSession({ mode: 'conversation', continuousVad: true })
  assert.equal(session.continuousVad, true)
  assert.equal(host.getStatus().vad?.continuous, true)
  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'armed'))

  // Push enough loud frames to exceed maxListenFrames.
  for (let i = 0; i < 4; i += 1) {
    capture.push(tone(160, 0.05))
  }

  // Allow auto stopSession to complete.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !events.some((e) => e.type === 'final')) {
    await new Promise((r) => setTimeout(r, 20))
  }

  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'timeout'))
  const finals = events.filter((e) => e.type === 'final')
  assert.equal(finals.length, 1)
  assert.equal((finals[0] as { event: { text: string } }).event.text, 'continuous timeout')
  assert.equal(host.getStatus().sessionId, null)
  assert.equal(host.getStatus().vad?.continuous, false)
})

test('voice host continuous VAD auto-finalizes after speech then silence', async () => {
  const events: VoiceHostEvent[] = []
  const capture = new FakeVoiceCapture({ intervalMs: 60_000, chunkFrames: 160 })
  const host = new VoiceHost({
    features: { voice: true },
    capture,
    stt: new FakeVoiceStt({ text: 'hello continuous' }),
    tts: new FakeVoiceTts(),
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    partialsEnabled: false,
    vadPolicy: {
      speechRms: 0.01,
      silenceRms: 0.005,
      minSpeechFrames: 80,
      endSilenceFrames: 160,
      maxListenFrames: 50_000,
      prerollFrames: 0,
    },
  })

  await host.startSession({ mode: 'conversation', continuousVad: true })
  capture.push(tone(160, 0.05))
  capture.push(silence(200))

  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !events.some((e) => e.type === 'final')) {
    await new Promise((r) => setTimeout(r, 20))
  }

  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'speech_start'))
  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'speech_end'))
  const finals = events.filter((e) => e.type === 'final')
  assert.equal(finals.length, 1)
  assert.equal((finals[0] as { event: { text: string } }).event.text, 'hello continuous')
})

test('continuousVad is ignored outside conversation mode', async () => {
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture({ intervalMs: 60_000 }),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  const session = await host.startSession({ mode: 'ptt', continuousVad: true })
  assert.equal(session.continuousVad, false)
  assert.equal(host.getStatus().vad?.continuous, false)
  await host.cancel(session.id)
})

test('voice host barge-in during TTS cancels speak and emits vad barge_in', async () => {
  const events: VoiceHostEvent[] = []
  const capture = new FakeVoiceCapture({ intervalMs: 60_000, chunkFrames: 160 })

  class SlowCancellableTts implements VoiceTtsEngine {
    readonly backend = 'fake' as const
    readonly detail = 'slow fake tts'
    private cancelled = false
    private resolveWait: (() => void) | null = null

    isReady() {
      return true
    }
    async listVoices(): Promise<VoiceTtsVoice[]> {
      return [{ id: 'fake', name: 'Fake', language: 'en' }]
    }
    async synthesize(_text: string, _options?: VoiceTtsSpeakOptions): Promise<VoiceTtsSynthResult> {
      return {
        path: '/tmp/unused-tts.marker',
        format: 'marker',
        voiceId: 'fake',
        backend: 'fake',
        durationMs: 0,
      }
    }
    async speak(_text: string, _options?: VoiceTtsSpeakOptions) {
      this.cancelled = false
      await new Promise<void>((resolve) => {
        this.resolveWait = resolve
        // Hold open until cancel or timeout.
        setTimeout(() => {
          if (!this.cancelled) resolve()
        }, 2000).unref?.()
      })
    }
    async cancel() {
      this.cancelled = true
      this.resolveWait?.()
      this.resolveWait = null
    }
  }

  const tts = new SlowCancellableTts()
  const host = new VoiceHost({
    features: { voice: true },
    capture,
    stt: new FakeVoiceStt(),
    tts,
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    partialsEnabled: false,
    bargeInEnabled: true,
    vadPolicy: {
      speechRms: 0.01,
      silenceRms: 0.005,
      minSpeechFrames: 50,
      endSilenceFrames: 200,
      maxListenFrames: 50_000,
      prerollFrames: 0,
    },
  })

  const speakPromise = host.speak({ text: 'long reply that can be interrupted' })
  // Wait for barge-in monitor to arm.
  const armDeadline = Date.now() + 1000
  while (Date.now() < armDeadline && !host.getBargeInArmed()) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(host.getBargeInArmed(), true)
  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'armed'))

  // Loud speech while speaking → barge-in.
  capture.push(tone(320, 0.05))

  await speakPromise
  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'barge_in'))
  assert.ok(events.some((e) => e.type === 'vad' && e.event.reason === 'disarmed'))
  assert.equal(host.getBargeInArmed(), false)
  assert.equal(host.getStatus().phase, 'ready')
})
