import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import {
  FakeVoiceTts,
  SystemOsVoiceTts,
  UnavailableVoiceTts,
  createDefaultVoiceTts,
  VOICE_TTS_MAX_TEXT_CHARS,
} from '../apps/desktop/src/main/voice-tts.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { FakeVoiceStt } from '../apps/desktop/src/main/voice-stt.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'

test('fake TTS synthesizes a local marker file without cloud', async () => {
  const tts = new FakeVoiceTts()
  assert.equal(tts.isReady(), true)
  const result = await tts.synthesize('hello private voice')
  assert.equal(result.backend, 'fake')
  assert.equal(result.format, 'marker')
  assert.ok(existsSync(result.path))
  assert.equal(readFileSync(result.path, 'utf8'), 'hello private voice')
  rmSync(result.path, { force: true })
  try {
    rmSync(result.path.replace(/[/\\][^/\\]+$/, ''), { recursive: true, force: true })
  } catch {
    // ignore
  }

  await tts.speak('spoken once')
  assert.deepEqual(tts.spoken, ['spoken once'])
})

test('fake TTS rejects empty and oversized text', async () => {
  const tts = new FakeVoiceTts()
  await assert.rejects(() => tts.speak('   '), /empty/i)
  await assert.rejects(() => tts.synthesize('x'.repeat(VOICE_TTS_MAX_TEXT_CHARS + 1)), /exceeds/i)
})

test('unavailable TTS fails closed', async () => {
  const tts = new UnavailableVoiceTts('no engine')
  assert.equal(tts.isReady(), false)
  await assert.rejects(() => tts.speak('hi'), /no engine/)
})

test('system OS TTS is ready on macOS when say exists', () => {
  const tts = new SystemOsVoiceTts('darwin')
  if (platform() === 'darwin') {
    assert.equal(tts.isReady(), true)
    assert.match(tts.detail, /macOS|say/i)
  }
  const linux = new SystemOsVoiceTts('linux')
  assert.equal(linux.isReady(), false)
})

test('system OS TTS synthesizes AIFF on macOS (local only)', async () => {
  if (platform() !== 'darwin') {
    // Other platforms remain deferred until a local backend ships.
    return
  }
  const tts = new SystemOsVoiceTts('darwin')
  assert.equal(tts.isReady(), true)
  const result = await tts.synthesize('Open Cowork private TTS probe.')
  assert.equal(result.backend, 'system_os')
  assert.equal(result.format, 'aiff')
  assert.ok(existsSync(result.path))
  const bytes = readFileSync(result.path)
  assert.ok(bytes.length > 100)
  // FORM/AIFF magic
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'FORM')
  rmSync(result.path, { force: true })
  try {
    rmSync(result.path.replace(/[/\\][^/\\]+$/, ''), { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('createDefaultVoiceTts picks system on macOS else unavailable', () => {
  const tts = createDefaultVoiceTts()
  if (platform() === 'darwin') {
    assert.equal(tts.backend, 'system_os')
    assert.equal(tts.isReady(), true)
  } else {
    assert.ok(tts.backend === 'unavailable' || tts.backend === 'system_os')
  }
})

test('voice host speak uses sibling TTS and never exposes audio on status', async () => {
  const tts = new FakeVoiceTts()
  const events: Array<{ type?: string }> = []
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    tts,
    probeMicrophone: async () => 'granted',
    onEvent: (e) => events.push(e),
    partialsEnabled: false,
  })

  const idle = host.getStatus()
  assert.equal(idle.tts.engine, 'system_os')
  assert.equal(idle.tts.ready, true)

  const status = await host.speak({ text: 'Read this aloud locally.' })
  assert.equal(status.phase, 'ready')
  assert.deepEqual(tts.spoken, ['Read this aloud locally.'])
  assert.ok(events.some((e) => e.type === 'status'))
  const json = JSON.stringify(status)
  assert.doesNotMatch(json, /"samples"\s*:/)
  assert.doesNotMatch(json, /ArrayBuffer|Float32Array|\.aiff|\.wav/)
})

test('voice host refuses speak when feature off or capture active', async () => {
  const tts = new FakeVoiceTts()
  const host = new VoiceHost({
    features: {},
    tts,
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  await assert.rejects(() => host.speak({ text: 'nope' }), /disabled/i)

  const hostOn = new VoiceHost({
    features: { voice: true },
    tts,
    capture: new FakeVoiceCapture({ intervalMs: 60_000, chunkFrames: 0 }),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  await hostOn.startSession({ mode: 'ptt' })
  await assert.rejects(() => hostOn.speak({ text: 'busy' }), /capture session/i)
  await hostOn.cancel()
})

test('voice host cancelSpeak is best-effort', async () => {
  const tts = new FakeVoiceTts()
  const host = new VoiceHost({
    features: { voice: true },
    tts,
    capture: new FakeVoiceCapture(),
    stt: new FakeVoiceStt(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })
  const status = await host.cancelSpeak()
  assert.equal(status.phase, 'ready')
})
