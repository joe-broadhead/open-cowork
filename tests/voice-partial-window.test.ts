import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VoicePartialClock,
  computeRms,
  dictationPartialPolicy,
} from '../apps/desktop/src/main/voice-partial-window.ts'
import { VOICE_PCM_SAMPLE_RATE } from '../apps/desktop/src/main/voice-pcm-buffer.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'
import type { VoiceSttEngine, VoiceSttResult } from '../apps/desktop/src/main/voice-stt.ts'

test('computeRms is zero for empty / silent and positive for signal', () => {
  assert.equal(computeRms(new Float32Array(0)), 0)
  assert.equal(computeRms(new Float32Array(100)), 0)
  const tone = new Float32Array(100)
  for (let i = 0; i < tone.length; i += 1) tone[i] = 0.1
  assert.ok(computeRms(tone) > 0.09)
})

test('dictation partial policy matches Aurum-ish defaults', () => {
  const policy = dictationPartialPolicy()
  assert.equal(policy.minFramesBeforePartial, VOICE_PCM_SAMPLE_RATE)
  assert.equal(policy.windowFrames, VOICE_PCM_SAMPLE_RATE * 15)
  assert.equal(policy.intervalMs, 1200)
  assert.ok(policy.minRms > 0)
})

test('VoicePartialClock gates on min frames, interval, and RMS', () => {
  const clock = new VoicePartialClock({
    minFramesBeforePartial: 100,
    windowFrames: 50,
    intervalMs: 1000,
    minRms: 0.01,
  })

  const quiet = new Float32Array(200)
  assert.equal(clock.takePartialSlice(quiet, 0), null)

  const loud = new Float32Array(200)
  for (let i = 0; i < loud.length; i += 1) loud[i] = 0.2
  const first = clock.takePartialSlice(loud, 0)
  assert.ok(first)
  assert.equal(first!.length, 50)

  // Interval gate
  assert.equal(clock.takePartialSlice(loud, 500), null)
  const second = clock.takePartialSlice(loud, 1001)
  assert.ok(second)

  // Too short
  const short = new Float32Array(50)
  for (let i = 0; i < short.length; i += 1) short[i] = 0.2
  clock.reset()
  assert.equal(clock.takePartialSlice(short, 0), null)
})

class ScriptedVoiceStt implements VoiceSttEngine {
  readonly backend = 'fake' as const
  readonly detail = 'scripted'
  readonly model = 'tiny-q5_1'
  private readonly texts: string[]
  private index = 0
  calls = 0
  lastFrames = 0

  constructor(texts: string[]) {
    this.texts = texts
  }

  isReady() {
    return true
  }

  async transcribePcm(samples: Float32Array): Promise<VoiceSttResult> {
    this.calls += 1
    this.lastFrames = samples.length
    const text = this.texts[Math.min(this.index, this.texts.length - 1)] ?? ''
    this.index += 1
    return {
      text,
      model: this.model,
      backend: 'fake',
      durationMs: 1,
      cleaned: true,
    }
  }
}

test('voice host emits partial events during listening (JOE-1102)', async () => {
  const events: Array<{ type?: string; event?: { text?: string; isFinal?: boolean } }> = []
  const stt = new ScriptedVoiceStt(['hello', 'hello world', 'hello world final'])
  const capture = new FakeVoiceCapture({ chunkFrames: 0, intervalMs: 60_000 })
  const host = new VoiceHost({
    features: { voice: true },
    capture,
    stt,
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e as typeof events[number]),
    partialPolicy: {
      minFramesBeforePartial: 100,
      windowFrames: 500,
      intervalMs: 50,
      minRms: 0.01,
    },
  })

  const session = await host.startSession({ mode: 'ptt' })
  // Loud enough PCM for the energy gate.
  const chunk = new Float32Array(400)
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = 0.2
  capture.push(chunk)

  // Allow partial loop ticks + STT microtasks.
  await new Promise((r) => setTimeout(r, 200))
  capture.push(chunk)
  await new Promise((r) => setTimeout(r, 200))

  const partials = events.filter((e) => e.type === 'partial')
  assert.ok(partials.length >= 1, `expected partial events, got ${JSON.stringify(events)}`)
  assert.equal(partials[0]!.event?.isFinal, false)
  assert.ok((partials[0]!.event?.text || '').length > 0)
  assert.equal(host.getLastPartialText(), partials[partials.length - 1]!.event?.text)
  assert.ok(stt.calls >= 1)

  const stopped = await host.stopSession(session.id)
  assert.equal(stopped.phase, 'ready')
  const finals = events.filter((e) => e.type === 'final')
  assert.equal(finals.length, 1)
  assert.equal(finals[0]!.event?.isFinal, true)
  assert.equal(host.getLastTranscript(), finals[0]!.event?.text)
  assert.equal(host.getLastPartialText(), null)
})

test('voice host can disable partials for finalize-only tests', async () => {
  const events: Array<{ type?: string }> = []
  const stt = new ScriptedVoiceStt(['only final'])
  const capture = new FakeVoiceCapture({ chunkFrames: 0, intervalMs: 60_000 })
  const host = new VoiceHost({
    features: { voice: true },
    capture,
    stt,
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    partialsEnabled: false,
    partialPolicy: {
      minFramesBeforePartial: 1,
      windowFrames: 100,
      intervalMs: 10,
      minRms: 0,
    },
  })

  const session = await host.startSession()
  const chunk = new Float32Array(200)
  for (let i = 0; i < chunk.length; i += 1) chunk[i] = 0.2
  capture.push(chunk)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(events.filter((e) => e.type === 'partial').length, 0)

  await host.stopSession(session.id)
  assert.equal(events.filter((e) => e.type === 'final').length, 1)
  assert.equal(host.getLastTranscript(), 'only final')
})
