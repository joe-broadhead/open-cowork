import test from 'node:test'
import assert from 'node:assert/strict'
import { VoicePcmBuffer, VOICE_PCM_SAMPLE_RATE } from '../apps/desktop/src/main/voice-pcm-buffer.ts'
import {
  FakeVoiceCapture,
  buildFfmpegCaptureArgs,
} from '../apps/desktop/src/main/voice-capture.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'
import { FakeVoiceStt } from '../apps/desktop/src/main/voice-stt.ts'

test('voice pcm buffer rolls and reports host-only stats', () => {
  const buf = new VoicePcmBuffer(8)
  buf.push([0.1, 0.2, 0.3, 0.4, 0.5])
  assert.equal(buf.frameCount, 5)
  buf.push([0.6, 0.7, 0.8, 0.9, 1.0])
  assert.equal(buf.frameCount, 8)
  const snap = buf.snapshot()
  assert.equal(snap.length, 8)
  assert.ok(snap[0]! > 0)
  const stats = buf.stats()
  assert.equal(stats.sampleRate, VOICE_PCM_SAMPLE_RATE)
  assert.equal(stats.channels, 1)
  assert.equal(stats.frames, 8)
  assert.ok(stats.peak >= 0.9)
  buf.clear()
  assert.equal(buf.frameCount, 0)
})

test('ffmpeg capture args force mono 16k f32le pipe', () => {
  const mac = buildFfmpegCaptureArgs('darwin')
  assert.ok(mac.includes('avfoundation'))
  assert.ok(mac.includes('16000'))
  assert.ok(mac.includes('f32le'))
  assert.ok(mac.includes('pipe:1'))

  const linux = buildFfmpegCaptureArgs('linux')
  assert.ok(linux.includes('pulse'))
})

test('voice host captures PCM with fake backend without exposing samples on status', async () => {
  const fake = new FakeVoiceCapture({ chunkFrames: 160, intervalMs: 5 })
  const events: unknown[] = []
  const host = new VoiceHost({
    features: { voice: true },
    capture: fake,
    stt: new FakeVoiceStt({ text: 'capture test' }),
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    // Existing capture tests focus on PCM ownership; partials covered in voice-partial-window.
    partialsEnabled: false,
  })

  const idle = host.getStatus()
  assert.equal(idle.enabled, true)
  assert.equal(idle.phase, 'ready')
  assert.equal(idle.capture?.backend, 'fake')
  assert.equal(idle.stt.ready, true)

  const session = await host.startSession({ mode: 'ptt', openCodeSessionId: 'sess-1' })
  assert.equal(session.phase, 'listening')
  assert.equal(session.openCodeSessionId, 'sess-1')

  // Wait for a few synthetic chunks.
  await new Promise((r) => setTimeout(r, 40))
  const listening = host.getStatus()
  assert.equal(listening.phase, 'listening')
  assert.ok((listening.capture?.frames || 0) > 0)
  // Status must not smuggle PCM arrays / raw sample buffers.
  assert.equal('samples' in (listening.capture || {}), false)
  const statusJson = JSON.stringify(listening)
  assert.doesNotMatch(statusJson, /"samples"\s*:/)
  assert.doesNotMatch(statusJson, /ArrayBuffer|Float32Array/)

  const hostPcm = host.getHostPcmSnapshot()
  assert.ok(hostPcm)
  assert.ok(hostPcm!.length > 0)

  const stopped = await host.stopSession(session.id)
  assert.equal(stopped.phase, 'ready')
  assert.equal(stopped.sessionId, null)
  assert.equal(stopped.capture?.frames, 0)
  assert.equal(host.getHostPcmSnapshot(), null)

  assert.ok(events.some((e) => (e as { type?: string }).type === 'status'))
})

test('voice host refuses start when feature flag off', async () => {
  const host = new VoiceHost({
    features: {},
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
  })
  await assert.rejects(() => host.startSession(), /disabled/i)
})

test('voice host fails closed on denied microphone', async () => {
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'denied',
  })
  await assert.rejects(() => host.startSession(), /Microphone permission/i)
  assert.equal(host.getStatus().phase, 'error')
})

test('voice host cancel clears buffer mid-session', async () => {
  const fake = new FakeVoiceCapture({ intervalMs: 5, chunkFrames: 100 })
  const host = new VoiceHost({
    features: { voice: true },
    capture: fake,
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  const session = await host.startSession()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok((host.getStatus().capture?.frames || 0) > 0)
  await host.cancel(session.id)
  assert.equal(host.getStatus().sessionId, null)
  assert.equal(host.getHostPcmSnapshot(), null)
})
