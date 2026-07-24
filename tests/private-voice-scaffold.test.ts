import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_SECONDARY_FEATURE_KEYS,
  desktopFeatureEnablementWarnings,
  isDesktopFeatureEnabled,
} from '../packages/shared/src/app-config.ts'
import {
  WORKSPACE_SUPPORT_APIS,
} from '../packages/shared/src/workspace.ts'
import {
  createDeferredVoiceHostStatus,
  VOICE_HOST_DEFERRED_REASON,
  VOICE_WORKSPACE_SUPPORT_APIS,
  voiceHostStatusForFeatures,
} from '../packages/shared/src/voice.ts'
import { browserCloudWorkspaceSupport } from '../packages/app/src/browser/cowork-api-support.ts'
import {
  isVoiceRelatedElectronPermission,
  OS_VOICE_PERMISSION_MATRIX,
  resolveRendererMediaPermission,
} from '../apps/desktop/src/main/voice-permission-policy.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('private voice: features.voice is secondary and default-off', () => {
  assert.ok((DESKTOP_SECONDARY_FEATURE_KEYS as readonly string[]).includes('voice'))
  assert.equal(isDesktopFeatureEnabled(undefined, 'voice'), false)
  assert.equal(isDesktopFeatureEnabled({}, 'voice'), false)
  assert.equal(isDesktopFeatureEnabled({ voice: true }, 'voice'), true)
  const warnings = desktopFeatureEnablementWarnings({ voice: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /Desktop Local/i)
  assert.match(warnings[0]!, /Aurum/i)
})

test('private voice: workspace support APIs include voice.* keys', () => {
  for (const api of VOICE_WORKSPACE_SUPPORT_APIS) {
    assert.ok(WORKSPACE_SUPPORT_APIS.includes(api), `missing ${api}`)
  }
})

test('private voice: browser cloud matrix marks voice not_supported', () => {
  const support = browserCloudWorkspaceSupport({})
  for (const api of VOICE_WORKSPACE_SUPPORT_APIS) {
    const entry = support.find((row) => row.api === api)
    assert.ok(entry, `browser support missing ${api}`)
    assert.equal(entry!.status, 'not_supported')
    assert.match(entry!.verdict?.reason || '', /Desktop Local|microphone/i)
  }
})

test('private voice: workspace-support store derives canVoice* flags', () => {
  const source = readFileSync(join(root, 'packages/app/src/stores/workspace-support.ts'), 'utf8')
  assert.match(source, /canVoiceCapture: mutation\('voice\.capture'\)/)
  assert.match(source, /canVoiceStt: mutation\('voice\.stt'\)/)
  assert.match(source, /canVoiceTts: mutation\('voice\.tts'\)/)
  assert.match(source, /canVoiceConversation: mutation\('voice\.conversation'\)/)
  assert.match(source, /voiceCapture: supportReason\(support, 'voice\.capture'/)
})

test('private voice: renderer media denied by default (voice host owns mic)', () => {
  assert.equal(isVoiceRelatedElectronPermission('media'), true)
  assert.equal(isVoiceRelatedElectronPermission('geolocation'), false)

  const denied = resolveRendererMediaPermission({
    features: { voice: true },
    captureMode: 'voice_host',
    permission: 'media',
  })
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /voice host/i)

  const stillDenied = resolveRendererMediaPermission({
    features: { voice: false },
    captureMode: 'renderer',
    permission: 'media',
  })
  assert.equal(stillDenied.allowed, false)

  const allowed = resolveRendererMediaPermission({
    features: { voice: true },
    captureMode: 'renderer',
    permission: 'media',
  })
  assert.equal(allowed.allowed, true)

  assert.ok(OS_VOICE_PERMISSION_MATRIX.some((row) => row.permission === 'microphone'))
  assert.ok(OS_VOICE_PERMISSION_MATRIX.every((row) => /not|n\/a|required/i.test(row.cloudWeb)))
})

test('private voice: host status scaffold stays deferred', () => {
  const off = voiceHostStatusForFeatures(undefined)
  assert.equal(off.enabled, false)
  assert.equal(off.phase, 'disabled')
  assert.equal(off.captureMode, 'voice_host')
  assert.equal(off.stt.engine, 'aurum_local')
  assert.equal(off.tts.engine, 'sibling')

  const on = voiceHostStatusForFeatures({ voice: true })
  assert.equal(on.enabled, true)
  assert.equal(on.phase, 'deferred')
  assert.match(on.reason || '', /scaffolded|not connected/i)

  const deferred = createDeferredVoiceHostStatus(VOICE_HOST_DEFERRED_REASON)
  assert.equal(deferred.phase, 'deferred')
  assert.equal(deferred.sessionId, null)
})

test('private voice: ADR and progressive disclosure docs present', () => {
  const adr = readFileSync(join(root, 'docs/adr/private-realtime-voice.md'), 'utf8')
  assert.match(adr, /Aurum/)
  assert.match(adr, /sibling/i)
  assert.match(adr, /features\.voice/)
  assert.match(adr, /Desktop Local/)
  assert.doesNotMatch(adr, /Aurum.*TTS as primary|TTS.*Aurum engine/)

  const progressive = readFileSync(join(root, 'docs/progressive-disclosure.md'), 'utf8')
  assert.match(progressive, /`voice`/)
  assert.match(progressive, /private-realtime-voice/)

  const mkdocs = readFileSync(join(root, 'mkdocs.yml'), 'utf8')
  assert.match(mkdocs, /private-realtime-voice\.md/)

  const register = readFileSync(join(root, 'docs/product-purity-register.md'), 'utf8')
  assert.match(register, /Private realtime voice/)
})

test('private voice: public default config does not enable features.voice', () => {
  const config = JSON.parse(readFileSync(join(root, 'open-cowork.config.json'), 'utf8')) as {
    features?: Record<string, boolean>
  }
  assert.notEqual(config.features?.voice, true)
})

test('private voice: IPC and preload channels are scaffolded', () => {
  const handlers = readFileSync(join(root, 'apps/desktop/src/main/ipc/voice-handlers.ts'), 'utf8')
  assert.match(handlers, /voice:status/)
  assert.match(handlers, /voice:session:start/)
  assert.match(handlers, /VOICE_HOST_DEFERRED_REASON/)

  const preload = readFileSync(join(root, 'apps/desktop/src/preload/index.ts'), 'utf8')
  assert.match(preload, /'voice:status'/)
  assert.match(preload, /'voice:session:start'/)
  assert.match(preload, /voice: \{/)

  const ipcHandlers = readFileSync(join(root, 'apps/desktop/src/main/ipc-handlers.ts'), 'utf8')
  assert.match(ipcHandlers, /registerVoiceHandlers/)
})
