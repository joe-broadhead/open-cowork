// Privacy-first adoption telemetry.
//
// This is a deliberately *separate* channel from the local diagnostic
// logger in `./telemetry.ts`. The diagnostic logger writes rich, locally
// retained NDJSON (session ids, workflow ids, sanitized errors) that never
// leaves the machine unless a downstream fork opts into `telemetry.endpoint`.
//
// Adoption telemetry answers a different question — "is the product being
// used, and which surfaces?" — for maintainers and self-hosters who choose
// to share coarse, anonymous usage. It is OPT-IN (default off) and content
// free by construction: every event passes through a strict allowlist guard
// (`redactAdoptionEvent`) that drops any property not on a fixed schema and
// rejects any value that looks like prompt text, message content, a file
// path, a URL, or an email. There is no install id, no device id, and no
// free-form string field, so nothing that could identify a user or reveal
// their work can be transmitted even if a caller passes it in by mistake.
//
// The sink is configurable: self-hosters point `telemetry.adoption.endpoint`
// (or `OPEN_COWORK_ADOPTION_TELEMETRY_ENDPOINT`) at their own collector, or
// leave it unset / disabled to transmit nothing. Upstream ships disabled.

import { getAppConfig } from './config-loader-core.js'
import { getEffectiveSettings } from './settings.js'

export const ADOPTION_TELEMETRY_SCHEMA = 'adoption/v1'
const REMOTE_TIMEOUT_MS = 2000

// Coarse, content-free surfaces. Anything not in this set is dropped by the
// `surface` validator, so a caller can never smuggle a path or free text in
// through a surface field.
export const ADOPTION_SURFACES = [
  'home',
  'chat',
  'team',
  'tools',
  'playbooks',
  'settings',
  'admin',
  'artifacts',
  'knowledge',
  'channels',
  'onboarding',
] as const
export type AdoptionSurface = (typeof ADOPTION_SURFACES)[number]

const APPROVAL_DECISIONS = ['approved', 'denied'] as const
const RUN_TRIGGERS = ['manual', 'scheduled', 'webhook'] as const
const PLATFORMS = ['darwin', 'win32', 'linux'] as const

const MAX_COUNT = 1_000_000
const SEMVER_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/

type PropertyValidator = (value: unknown) => string | number | boolean | undefined

function enumValidator(allowed: readonly string[]): PropertyValidator {
  const set = new Set(allowed)
  return (value) => (typeof value === 'string' && set.has(value) ? value : undefined)
}

function countValidator(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 0 || value > MAX_COUNT) return undefined
  return value
}

function booleanValidator(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function semverValidator(value: unknown): string | undefined {
  return typeof value === 'string' && SEMVER_PATTERN.test(value) ? value : undefined
}

// Every property the adoption channel understands. A property is only ever
// emitted if (a) the event's schema lists it and (b) its validator returns a
// value. Validators return coarse primitives only (fixed enums, bounded
// integers, booleans, a strict semver) — there is intentionally no validator
// that accepts arbitrary text, so prompts / content / paths have no way
// through even when their key collides with an allowlisted one.
const PROPERTY_VALIDATORS: Record<string, PropertyValidator> = {
  surface: enumValidator(ADOPTION_SURFACES),
  decision: enumValidator(APPROVAL_DECISIONS),
  trigger: enumValidator(RUN_TRIGGERS),
  platform: enumValidator(PLATFORMS),
  count: countValidator,
  streamed: booleanValidator,
  appVersion: semverValidator,
}

// Per-event property allowlist. Keys absent here are dropped even if a
// validator exists for them, so each event stays scoped to coarse facts.
const EVENT_PROPERTIES: Record<string, readonly string[]> = {
  'app.launched': ['platform', 'appVersion'],
  'app.ready': [],
  'feature.opened': ['surface'],
  'session.started': ['streamed'],
  'approval.resolved': ['decision'],
  'workflow.run': ['trigger'],
  'onboarding.completed': [],
}

export const ADOPTION_EVENTS = Object.keys(EVENT_PROPERTIES)

export interface AdoptionEvent {
  schema: typeof ADOPTION_TELEMETRY_SCHEMA
  ts: string
  event: string
  props: Record<string, string | number | boolean>
}

export type RedactAdoptionResult =
  | { ok: true; event: AdoptionEvent; dropped: string[] }
  | { ok: false; reason: string; dropped: string[] }

export interface AdoptionTelemetryConfig {
  enabled: boolean
  endpoint?: string
  headers?: Record<string, string>
}

// The single choke point every adoption event flows through. It is a pure
// function so it can be exhaustively unit-tested offline: given an event name
// and an arbitrary bag of properties, it returns either a fully-allowlisted
// event or a rejection, and it can never return a property that was not both
// (a) listed for the event and (b) accepted by a coarse validator.
export function redactAdoptionEvent(
  event: string,
  rawProps: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): RedactAdoptionResult {
  const allowedKeys = EVENT_PROPERTIES[event]
  if (!allowedKeys) {
    return { ok: false, reason: `unknown adoption event: ${event}`, dropped: Object.keys(rawProps || {}) }
  }

  const props: Record<string, string | number | boolean> = {}
  const dropped: string[] = []
  const allowed = new Set(allowedKeys)

  for (const [key, value] of Object.entries(rawProps || {})) {
    const validator = allowed.has(key) ? PROPERTY_VALIDATORS[key] : undefined
    if (!validator) {
      dropped.push(key)
      continue
    }
    const validated = validator(value)
    if (validated === undefined) {
      dropped.push(key)
      continue
    }
    props[key] = validated
  }

  return {
    ok: true,
    event: {
      schema: ADOPTION_TELEMETRY_SCHEMA,
      ts: now().toISOString(),
      event,
      props,
    },
    dropped,
  }
}

export type AdoptionTransport = (event: AdoptionEvent, config: AdoptionTelemetryConfig) => void | Promise<void>

export interface AdoptionTelemetryDeps {
  getConfig: () => AdoptionTelemetryConfig
  transport?: AdoptionTransport
  now?: () => Date
  onDrop?: (event: string, dropped: string[]) => void
}

export interface AdoptionTelemetry {
  track: (event: string, props?: Record<string, unknown>) => void
  appLaunched: (props?: { platform?: string; appVersion?: string }) => void
  appReady: () => void
  featureOpened: (surface: AdoptionSurface) => void
  sessionStarted: (props?: { streamed?: boolean }) => void
  approvalResolved: (decision: 'approved' | 'denied') => void
  workflowRun: (trigger: 'manual' | 'scheduled' | 'webhook') => void
  onboardingCompleted: () => void
}

// Default network transport: fire-and-forget POST, short timeout, silent on
// any failure. Only reached when the caller's config is enabled AND has an
// endpoint, so a disabled or endpoint-less install performs no network I/O.
async function defaultTransport(event: AdoptionEvent, config: AdoptionTelemetryConfig): Promise<void> {
  if (!config.enabled || !config.endpoint) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS)
  try {
    await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      },
      body: JSON.stringify(event),
    })
  } catch {
    // Network / timeout / DNS failures must never surface to the caller.
  } finally {
    clearTimeout(timer)
  }
}

export function createAdoptionTelemetry(deps: AdoptionTelemetryDeps): AdoptionTelemetry {
  const transport = deps.transport ?? defaultTransport
  const now = deps.now ?? (() => new Date())

  function track(event: string, props?: Record<string, unknown>) {
    let config: AdoptionTelemetryConfig
    try {
      config = deps.getConfig()
    } catch {
      return
    }
    // Opt-in gate: do no work at all (not even redaction) unless the operator
    // has both enabled the channel and configured a sink.
    if (!config.enabled || !config.endpoint) return

    const redacted = redactAdoptionEvent(event, props, now)
    if (!redacted.ok) {
      deps.onDrop?.(event, redacted.dropped)
      return
    }
    if (redacted.dropped.length > 0) deps.onDrop?.(event, redacted.dropped)

    try {
      void transport(redacted.event, config)
    } catch {
      // Best-effort only.
    }
  }

  return {
    track,
    appLaunched: (props) => track('app.launched', props),
    appReady: () => track('app.ready'),
    featureOpened: (surface) => track('feature.opened', { surface }),
    sessionStarted: (props) => track('session.started', props),
    approvalResolved: (decision) => track('approval.resolved', { decision }),
    workflowRun: (trigger) => track('workflow.run', { trigger }),
    onboardingCompleted: () => track('onboarding.completed'),
  }
}

// Config resolution: app config first, env override on top. Env override is
// intended for self-hosters who cannot edit the packaged config file; either
// path can enable + point the sink, or leave it disabled to transmit nothing.
export function resolveAdoptionTelemetryConfig(
  fromConfig?: { enabled?: boolean; endpoint?: string; headers?: Record<string, string> },
  env: NodeJS.ProcessEnv = process.env,
): AdoptionTelemetryConfig {
  const envEnabledRaw = env.OPEN_COWORK_ADOPTION_TELEMETRY_ENABLED
  const envEnabled = envEnabledRaw === undefined ? undefined : envEnabledRaw === '1' || envEnabledRaw === 'true'
  const envEndpoint = env.OPEN_COWORK_ADOPTION_TELEMETRY_ENDPOINT?.trim() || undefined

  const enabled = envEnabled ?? fromConfig?.enabled ?? false
  const endpoint = envEndpoint ?? fromConfig?.endpoint

  return {
    enabled,
    // Only ever transmit over HTTPS. An http:// (non-loopback) endpoint is
    // treated as unset so coarse events can't be sent in the clear.
    endpoint: endpoint && /^https:\/\//.test(endpoint) ? endpoint : undefined,
    headers: fromConfig?.headers,
  }
}

function getRuntimeAdoptionConfig(): AdoptionTelemetryConfig {
  let fromConfig: { enabled?: boolean; endpoint?: string; headers?: Record<string, string> } | undefined
  try {
    fromConfig = getAppConfig().telemetry?.adoption
  } catch {
    fromConfig = undefined
  }
  const resolved = resolveAdoptionTelemetryConfig(fromConfig)
  // JOE-855: user privacy toggle gates transmission even when deploy config enables it.
  try {
    if (!getEffectiveSettings().privacyShareAnonymizedUsage) {
      return { ...resolved, enabled: false }
    }
  } catch {
    // If settings cannot load, fail closed (no adoption traffic).
    return { ...resolved, enabled: false }
  }
  return resolved
}

// Process-wide singleton wired to the real app config + network transport.
export const adoptionTelemetry: AdoptionTelemetry = createAdoptionTelemetry({
  getConfig: getRuntimeAdoptionConfig,
})
