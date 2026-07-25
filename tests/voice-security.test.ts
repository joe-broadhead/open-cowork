/**
 * JOE-1111 — private voice security gates.
 * Proves local_only fail-closed, log redaction (no PCM/transcript), and
 * non-local support matrix blocks. Greppable audit: docs/adr/private-realtime-voice.md.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VOICE_SECURITY_RESIDUAL_RISKS,
  VOICE_STT_LOG_ALLOWED_KEYS,
  VOICE_TTS_LOG_ALLOWED_KEYS,
  assertVoiceLogMetaKeys,
  payloadLooksFreeOfAudio,
  ttsLogMeta,
} from '../apps/desktop/src/main/voice-security.ts'
import {
  AurumCliVoiceStt,
  FakeVoiceStt,
  hashTranscriptText,
  sttLogMeta,
} from '../apps/desktop/src/main/voice-stt.ts'
import { FakeVoiceTts } from '../apps/desktop/src/main/voice-tts.ts'
import { FakeVoiceCapture } from '../apps/desktop/src/main/voice-capture.ts'
import { VoiceHost } from '../apps/desktop/src/main/voice-host.ts'
import { browserCloudWorkspaceSupport } from '../packages/app/src/browser/cowork-api-support.ts'
import { VOICE_WORKSPACE_SUPPORT_APIS } from '../packages/shared/src/voice.ts'
import {
  resolveRendererMediaPermission,
} from '../apps/desktop/src/main/voice-permission-policy.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const mainDir = join(root, 'apps/desktop/src/main')

function readMainVoiceSources(): { name: string; source: string }[] {
  return readdirSync(mainDir)
    .filter((name) => name.startsWith('voice-') && name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(join(mainDir, name), 'utf8') }))
}

test('sttLogMeta never includes transcript text (length only)', () => {
  const secret = 'user said something private about ACME-42'
  const meta = sttLogMeta({
    text: secret,
    model: 'tiny-q5_1',
    backend: 'fake',
    durationMs: 12,
    cleaned: true,
  })
  const check = assertVoiceLogMetaKeys(meta as Record<string, unknown>, VOICE_STT_LOG_ALLOWED_KEYS)
  assert.equal(check.ok, true)
  assert.equal(meta.textChars, secret.length)
  assert.equal('text' in meta, false)
  const json = JSON.stringify(meta)
  assert.doesNotMatch(json, /ACME-42/)
  assert.doesNotMatch(json, /private/)
  // Correlation hash is available without logging the body
  assert.equal(hashTranscriptText(secret).length, 64)
  assert.notEqual(hashTranscriptText(secret), hashTranscriptText('other'))
})

test('ttsLogMeta never includes spoken string', () => {
  const spoken = 'Assistant reply with secrets XYZ'
  const meta = ttsLogMeta({ text: spoken, backend: 'fake', bargedIn: false })
  const check = assertVoiceLogMetaKeys(meta as Record<string, unknown>, VOICE_TTS_LOG_ALLOWED_KEYS)
  assert.equal(check.ok, true)
  assert.equal(meta.chars, spoken.length)
  assert.doesNotMatch(JSON.stringify(meta), /XYZ|Assistant reply/)
})

test('payloadLooksFreeOfAudio rejects samples and typed arrays', () => {
  assert.equal(payloadLooksFreeOfAudio(JSON.stringify({ sampleRate: 16000, frames: 10 })), true)
  assert.equal(payloadLooksFreeOfAudio(JSON.stringify({ samples: [0.1, 0.2] })), false)
  assert.equal(payloadLooksFreeOfAudio('{"pcm":[1]}'), false)
  assert.equal(payloadLooksFreeOfAudio('Float32Array(320)'), false)
  assert.equal(
    payloadLooksFreeOfAudio(JSON.stringify({ type: 'final', text: 'hello there' }), { allowEventText: true }),
    true,
  )
  assert.equal(
    payloadLooksFreeOfAudio(JSON.stringify({ type: 'status', text: 'hello there' })),
    false,
  )
})

test('Aurum STT local_only fails closed without model (offline)', async () => {
  const stt = new AurumCliVoiceStt({
    binPath: '/usr/bin/false',
    model: 'tiny-q5_1',
    cacheDir: join(root, '.no-such-aurum-cache-joe-1111'),
    localOnly: true,
    isModelCached: () => false,
  })
  assert.equal(stt.isReady(), false)
  await assert.rejects(
    () => stt.transcribePcm(new Float32Array(1600)),
    /local_only|not present/i,
  )
})

test('Aurum STT default path never passes openrouter provider', async () => {
  const calls: string[][] = []
  const { EventEmitter } = await import('node:events')
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push(args)
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    ee.stdout = new EventEmitter()
    ee.stderr = new EventEmitter()
    queueMicrotask(() => {
      ee.stdout.emit('data', 'ok\n')
      ee.emit('close', 0)
    })
    return ee
  }) as unknown as typeof import('node:child_process').spawn

  const stt = new AurumCliVoiceStt({
    binPath: 'aurum',
    localOnly: true,
    isModelCached: () => true,
    spawnImpl: fakeSpawn,
  })
  await stt.transcribePcm(new Float32Array(400))
  assert.equal(calls.length, 1)
  const args = calls[0]!
  assert.equal(args[args.indexOf('--provider') + 1], 'local')
  assert.ok(!args.some((a) => /openrouter|openai|elevenlabs/i.test(a)))
})

test('voice host status JSON never smuggles PCM; logs use redacted meta shape', async () => {
  const host = new VoiceHost({
    features: { voice: true },
    capture: new FakeVoiceCapture({ intervalMs: 5, chunkFrames: 160 }),
    stt: new FakeVoiceStt({ text: 'classified utterance alpha' }),
    tts: new FakeVoiceTts(),
    probeMicrophone: async () => 'granted',
    partialsEnabled: false,
  })

  const session = await host.startSession({ mode: 'ptt' })
  await new Promise((r) => setTimeout(r, 25))
  const listening = host.getStatus()
  assert.equal(payloadLooksFreeOfAudio(JSON.stringify(listening), { allowEventText: false }), true)
  assert.doesNotMatch(JSON.stringify(listening), /classified utterance/)

  await host.stopSession(session.id)
  // Host may retain last transcript in memory for tests — must not appear on status.
  assert.equal(host.getLastTranscript(), 'classified utterance alpha')
  assert.doesNotMatch(JSON.stringify(host.getStatus()), /classified utterance/)

  await host.speak({ text: 'spoken classified beta' })
  assert.doesNotMatch(JSON.stringify(host.getStatus()), /spoken classified/)
})

test('browser cloud support matrix blocks all voice.* APIs', () => {
  const support = browserCloudWorkspaceSupport({})
  for (const api of VOICE_WORKSPACE_SUPPORT_APIS) {
    const entry = support.find((row) => row.api === api)
    assert.ok(entry, api)
    assert.equal(entry!.status, 'not_supported')
  }
})

test('renderer media permission stays denied for voice_host capture mode', () => {
  const denied = resolveRendererMediaPermission({
    features: { voice: true },
    captureMode: 'voice_host',
    permission: 'media',
  })
  assert.equal(denied.allowed, false)
})

test('preload surface has no lastTranscript / raw audio channels', () => {
  const preload = readFileSync(join(root, 'apps/desktop/src/preload/index.ts'), 'utf8')
  assert.doesNotMatch(preload, /lastTranscript|getHostPcm|rawAudio|voice:pcm/i)
  assert.match(preload, /'voice:status'/)
  assert.match(preload, /'voice:assets:status'/)
})

test('voice main sources never log OPENROUTER as default STT provider', () => {
  for (const { name, source } of readMainVoiceSources()) {
    // Clearing the key is fine; selecting openrouter as provider is not.
    if (/--provider['"]?\s*,\s*['"]openrouter|provider:\s*['"]openrouter/i.test(source)) {
      assert.fail(`${name} selects openrouter STT provider`)
    }
    // Log lines must use sttLogMeta / ttsLogMeta rather than raw result.text
    if (name === 'voice-host.ts') {
      assert.match(source, /sttLogMeta/)
      assert.match(source, /ttsLogMeta/)
      assert.doesNotMatch(source, /log\('voice',\s*`[^`]*\$\{[^}]*\.text/)
    }
  }
})

test('security residual risk register is non-empty and stable', () => {
  assert.ok(VOICE_SECURITY_RESIDUAL_RISKS.length >= 4)
  const ids = new Set(VOICE_SECURITY_RESIDUAL_RISKS.map((r) => r.id))
  assert.equal(ids.size, VOICE_SECURITY_RESIDUAL_RISKS.length)
  for (const risk of VOICE_SECURITY_RESIDUAL_RISKS) {
    assert.match(risk.id, /^R-VOICE-\d+$/)
    assert.ok(risk.summary.length > 10)
    assert.ok(risk.mitigation.length > 10)
  }
})

test('ADR documents JOE-1111 security audit notes', () => {
  const adr = readFileSync(join(root, 'docs/adr/private-realtime-voice.md'), 'utf8')
  assert.match(adr, /JOE-1111/)
  assert.match(adr, /Security audit|security audit/i)
  assert.match(adr, /local_only|textChars|never.*PCM|never.*transcript/i)
  assert.match(adr, /R-VOICE-/)
})
