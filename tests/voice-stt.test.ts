import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  AurumCliVoiceStt,
  FakeVoiceStt,
  hashTranscriptText,
  isAurumModelCached,
  sttLogMeta,
  writeWavFile,
} from '../apps/desktop/src/main/voice-stt.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'

test('writeWavFile emits valid RIFF mono 16-bit header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-wav-'))
  const path = join(dir, 't.wav')
  const samples = new Float32Array([0, 0.5, -0.5, 1])
  writeWavFile(path, samples, 16_000)
  const buf = readFileSync(path)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE')
  assert.equal(buf.readUInt16LE(22), 1) // mono
  assert.equal(buf.readUInt32LE(24), 16_000)
  assert.equal(buf.readUInt16LE(34), 16)
  assert.equal(buf.length, 44 + samples.length * 2)
  rmSync(dir, { recursive: true, force: true })
})

test('fake STT returns text and never needs model cache', async () => {
  const stt = new FakeVoiceStt({ text: 'dictate this' })
  assert.equal(stt.isReady(), true)
  const result = await stt.transcribePcm(new Float32Array(320))
  assert.equal(result.text, 'dictate this')
  assert.equal(result.backend, 'fake')
  const meta = sttLogMeta(result)
  assert.equal(meta.textChars, 'dictate this'.length)
  assert.equal('text' in meta, false)
})

test('Aurum CLI STT fails closed when local_only and model missing', async () => {
  const stt = new AurumCliVoiceStt({
    binPath: '/usr/bin/false',
    model: 'tiny-q5_1',
    cacheDir: join(tmpdir(), `no-cache-${Date.now()}`),
    localOnly: true,
    isModelCached: () => false,
  })
  assert.equal(stt.isReady(), false)
  await assert.rejects(
    () => stt.transcribePcm(new Float32Array(1600)),
    /local_only|not present/i,
  )
})

test('Aurum CLI STT invokes local provider only (never openrouter)', async () => {
  const calls: { cmd: string; args: string[] }[] = []
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    ee.stdout = new EventEmitter()
    ee.stderr = new EventEmitter()
    queueMicrotask(() => {
      ee.stdout.emit('data', 'hello world\n')
      ee.emit('close', 0)
    })
    return ee
  }) as unknown as typeof import('node:child_process').spawn

  const stt = new AurumCliVoiceStt({
    binPath: 'aurum',
    model: 'tiny-q5_1',
    localOnly: true,
    isModelCached: () => true,
    spawnImpl: fakeSpawn,
    cleanup: 'clean',
  })
  const result = await stt.transcribePcm(new Float32Array(800))
  assert.equal(result.text, 'hello world')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.cmd, 'aurum')
  assert.ok(calls[0]!.args.includes('--provider'))
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('--provider') + 1], 'local')
  assert.ok(!calls[0]!.args.some((a) => /openrouter/i.test(a)))
  assert.ok(calls[0]!.args.includes('--cleanup-provider'))
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('--cleanup-provider') + 1], 'rules')
})

test('voice host stop finalizes STT and emits text-only final event', async () => {
  const events: Array<{ type: string; text?: string }> = []
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture({ intervalMs: 5, chunkFrames: 200 }),
    stt: new FakeVoiceStt({ text: 'push to talk works' }),
    probeMicrophone: async () => 'granted',
    onEvent: (e) => {
      if (e.type === 'final') events.push({ type: 'final', text: e.event.text })
      if (e.type === 'status') events.push({ type: 'status' })
    },
  })

  assert.equal(host.getStatus().stt.ready, true)
  assert.equal(host.getStatus().stt.engine, 'aurum_local')

  const session = await host.startSession({ mode: 'ptt' })
  await new Promise((r) => setTimeout(r, 35))
  assert.ok((host.getStatus().capture?.frames || 0) > 0)

  const status = await host.stopSession(session.id)
  assert.equal(status.phase, 'ready')
  assert.equal(host.getLastTranscript(), 'push to talk works')
  assert.ok(events.some((e) => e.type === 'final' && e.text === 'push to talk works'))
  // No PCM leaked into event payload JSON
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, /"samples"/)
  assert.equal(hashTranscriptText('push to talk works').length, 64)
})

test('isAurumModelCached returns false for empty dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-aurum-empty-'))
  assert.equal(isAurumModelCached(dir, 'tiny-q5_1'), false)
  assert.equal(existsSync(dir), true)
  rmSync(dir, { recursive: true, force: true })
})
