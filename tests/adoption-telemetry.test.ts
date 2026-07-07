import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADOPTION_TELEMETRY_SCHEMA,
  createAdoptionTelemetry,
  redactAdoptionEvent,
  resolveAdoptionTelemetryConfig,
  type AdoptionEvent,
  type AdoptionTelemetryConfig,
} from '@open-cowork/runtime-host/adoption-telemetry'

// A fake, structurally-valid API key built at runtime so it never sits in
// source as a literal (which the repo's secret scanner would flag).
const FAKE_API_KEY = `sk-ant-${'a'.repeat(24)}`

// Values that must NEVER appear in a transmitted adoption payload. If any of
// these substrings survive the guard, the "content-free" contract is broken.
const FORBIDDEN_SUBSTRINGS = [
  'my secret prompt',
  'the quick brown fox jumped over the lazy dog',
  '/Users/joe/secret.txt',
  '/home/alice/.ssh/id_rsa',
  'C:\\Users\\joe\\Documents',
  'joseph.broadhead.dev@gmail.com',
  FAKE_API_KEY,
  'file body contents here',
]

const MALICIOUS_PROPS: Record<string, unknown> = {
  // Free-form content fields — none are on any event allowlist.
  prompt: 'my secret prompt',
  message: 'the quick brown fox jumped over the lazy dog',
  content: 'file body contents here',
  filePath: '/Users/joe/secret.txt',
  path: '/home/alice/.ssh/id_rsa',
  windowsPath: 'C:\\Users\\joe\\Documents',
  email: 'joseph.broadhead.dev@gmail.com',
  apiKey: FAKE_API_KEY,
  // Allowlisted keys carrying illegal (path/free-text) values — must be dropped.
  surface: '/Users/joe/secret.txt',
  decision: 'the quick brown fox jumped over the lazy dog',
  count: 'joseph.broadhead.dev@gmail.com',
}

function assertNoForbiddenContent(serialized: string) {
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `adoption payload leaked forbidden content: ${forbidden}`,
    )
  }
}

test('redactAdoptionEvent rejects unknown events and drops every unknown property', () => {
  const rejected = redactAdoptionEvent('secret.exfiltration', MALICIOUS_PROPS)
  assert.equal(rejected.ok, false)

  const result = redactAdoptionEvent('feature.opened', MALICIOUS_PROPS)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // `feature.opened` only allows a coarse `surface` enum. Every malicious key
  // (and the path-valued surface) must be dropped, leaving an empty props bag.
  assert.deepEqual(result.event.props, {})
  assert.equal(result.event.schema, ADOPTION_TELEMETRY_SCHEMA)
  assertNoForbiddenContent(JSON.stringify(result.event))
})

test('redactAdoptionEvent keeps only allowlisted coarse values', () => {
  const feature = redactAdoptionEvent('feature.opened', { surface: 'chat', prompt: 'leak me' })
  assert.equal(feature.ok, true)
  if (feature.ok) assert.deepEqual(feature.event.props, { surface: 'chat' })

  const approval = redactAdoptionEvent('approval.resolved', { decision: 'approved', reason: '/Users/joe' })
  assert.equal(approval.ok, true)
  if (approval.ok) assert.deepEqual(approval.event.props, { decision: 'approved' })

  const launch = redactAdoptionEvent('app.launched', {
    platform: 'darwin',
    appVersion: '1.2.3',
    hostname: 'joes-macbook.local',
  })
  assert.equal(launch.ok, true)
  if (launch.ok) assert.deepEqual(launch.event.props, { platform: 'darwin', appVersion: '1.2.3' })

  // Out-of-range / wrong-typed coarse values are dropped, not clamped.
  const badCount = redactAdoptionEvent('feature.opened', { surface: 'not-a-surface' })
  assert.equal(badCount.ok, true)
  if (badCount.ok) assert.deepEqual(badCount.event.props, {})
})

test('emitter transmits only when opted in and never leaks content or paths', () => {
  const captured: AdoptionEvent[] = []
  const enabled: AdoptionTelemetryConfig = { enabled: true, endpoint: 'https://collector.example.com/ingest' }

  const telemetry = createAdoptionTelemetry({
    getConfig: () => enabled,
    transport: (event) => {
      captured.push(event)
    },
  })

  // Even the low-level `track` — the only path that accepts arbitrary props —
  // routes through the guard, so injected content cannot reach the transport.
  telemetry.track('feature.opened', MALICIOUS_PROPS)
  telemetry.track('session.started', { streamed: true, transcript: 'my secret prompt' })
  telemetry.approvalResolved('denied')
  telemetry.appLaunched({ platform: 'linux', appVersion: '9.9.9' })
  // Unknown event is dropped before transport.
  telemetry.track('secret.exfiltration', MALICIOUS_PROPS)

  assert.equal(captured.length, 4)
  assertNoForbiddenContent(JSON.stringify(captured))
  assert.deepEqual(captured[0]?.props, {})
  assert.deepEqual(captured[1]?.props, { streamed: true })
  assert.deepEqual(captured[2]?.props, { decision: 'denied' })
  assert.deepEqual(captured[3]?.props, { platform: 'linux', appVersion: '9.9.9' })
})

test('emitter is inert when disabled or endpoint-less (opt-in default off)', () => {
  const disabled: AdoptionTelemetryConfig[] = [
    { enabled: false, endpoint: 'https://collector.example.com/ingest' },
    { enabled: true },
    { enabled: false },
  ]

  for (const config of disabled) {
    let calls = 0
    const telemetry = createAdoptionTelemetry({
      getConfig: () => config,
      transport: () => {
        calls += 1
      },
    })
    telemetry.appLaunched({ platform: 'darwin', appVersion: '1.0.0' })
    telemetry.featureOpened('admin')
    telemetry.track('feature.opened', MALICIOUS_PROPS)
    assert.equal(calls, 0, `disabled/endpoint-less config must not transmit: ${JSON.stringify(config)}`)
  }
})

test('config resolution defaults off and honors env overrides + https-only sink', () => {
  assert.deepEqual(resolveAdoptionTelemetryConfig(undefined, {}), {
    enabled: false,
    endpoint: undefined,
    headers: undefined,
  })

  // Config opts in.
  const fromConfig = resolveAdoptionTelemetryConfig(
    { enabled: true, endpoint: 'https://c.example.com/i', headers: { Authorization: 'Bearer x' } },
    {},
  )
  assert.equal(fromConfig.enabled, true)
  assert.equal(fromConfig.endpoint, 'https://c.example.com/i')

  // Env override wins over config and disables.
  const envDisabled = resolveAdoptionTelemetryConfig(
    { enabled: true, endpoint: 'https://c.example.com/i' },
    { OPEN_COWORK_ADOPTION_TELEMETRY_ENABLED: '0' },
  )
  assert.equal(envDisabled.enabled, false)

  // A non-https endpoint is refused so coarse events can't be sent in the clear.
  const insecure = resolveAdoptionTelemetryConfig(
    { enabled: true, endpoint: 'http://insecure.example.com/i' },
    {},
  )
  assert.equal(insecure.endpoint, undefined)

  // Env endpoint override applies.
  const envEndpoint = resolveAdoptionTelemetryConfig(
    { enabled: true },
    { OPEN_COWORK_ADOPTION_TELEMETRY_ENDPOINT: 'https://self-host.example.com/collect' },
  )
  assert.equal(envEndpoint.endpoint, 'https://self-host.example.com/collect')
})
