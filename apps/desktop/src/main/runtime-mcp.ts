import electron from 'electron'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import type { CustomMcpConfig } from '@open-cowork/shared'
import { getConfiguredMcpsFromConfig, type BundleMcp } from './config-loader.ts'
import { getIntegrationCredentialValue, getEffectiveSettings, type CoworkSettings } from './settings.ts'
import { getMachineSkillsDir } from './runtime-paths.ts'
import { getAdcPathIfAvailable, getCachedAccessToken } from './auth.ts'
import { log } from './logger.ts'
import { evaluateHttpMcpUrl } from './mcp-url-policy.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

function resourcePath(...segments: string[]) {
  if (electronApp?.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  const appPath = electronApp?.getAppPath?.() || process.cwd()
  return resolve(appPath, '..', '..', ...segments)
}

function mcpPath(name: string) {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  if (downstreamRoot) {
    const downstreamMcp = join(downstreamRoot, 'mcps', name, 'dist', 'index.js')
    if (existsSync(downstreamMcp)) return downstreamMcp
  }
  return resourcePath('mcps', name, 'dist', 'index.js')
}

export type ResolvedRuntimeMcpEntry =
  | {
    type: 'local'
    command: string[]
    environment?: Record<string, string>
  }
  | {
    type: 'remote'
    url: string
    headers?: Record<string, string>
  }

// Why a bundled MCP was skipped from `config.mcp` on this boot.
//
// - `not-configured`: the MCP declares a required credential (e.g.
//   Perplexity API key) and the user hasn't provided it. Spawning it
//   would just fail with a cryptic error from inside the MCP process,
//   so we don't register it.
// - `not-signed-in-google`: the MCP opts into app-level Google OAuth
//   and the user isn't signed in yet.
// - `disabled-by-user`: the user explicitly toggled this MCP off via
//   `integrationEnabled[name] = false`. Applies even when credentials
//   are present.
// - `awaiting-oauth-opt-in`: the MCP uses OAuth and the user hasn't
//   explicitly enabled it. We don't auto-enroll OAuth MCPs because
//   they'd otherwise sit in `needs_auth` forever, making the status
//   log noisy for integrations the user doesn't care about.
export type BuiltInMcpSkipReason =
  | 'not-configured'
  | 'not-signed-in-google'
  | 'disabled-by-user'
  | 'awaiting-oauth-opt-in'

export type BuiltInMcpResolution =
  | { status: 'ready'; entry: ResolvedRuntimeMcpEntry }
  | { status: 'skipped'; reason: BuiltInMcpSkipReason }
  | { status: 'invalid' }

// A bundled MCP is "user-enabled" when the user either explicitly
// toggled it on, or the defaults apply. Explicit-off always wins.
// Returns null when no explicit choice has been recorded — callers
// apply the implicit readiness heuristic in that case.
function getExplicitEnabledState(builtin: BundleMcp, settings: CoworkSettings): boolean | null {
  const explicit = settings.integrationEnabled?.[builtin.name]
  return typeof explicit === 'boolean' ? explicit : null
}

// All required credentials declared in `credentials[]` must have a
// non-empty stored value for the MCP to count as credential-ready.
// MCPs without a `credentials[]` block or without any `required: true`
// entries are trivially credential-ready.
function hasRequiredCredentials(builtin: BundleMcp, settings: CoworkSettings): boolean {
  for (const credential of builtin.credentials || []) {
    if (credential.required === false) continue
    const value = getIntegrationCredentialValue(settings, builtin.name, credential.key)
    if (!value) return false
  }
  return true
}

// OAuth MCPs must be explicitly enabled by the user. We don't want the
// status list to show `needs_auth` for every bundled OAuth integration
// by default — that reads as a failure for users who never planned to
// connect Atlassian or Amplitude. Users opt-in by toggling the
// integration on (triggering `integrationEnabled[name] = true`) and
// the SDK then surfaces the auth prompt.
function isOAuthMcp(builtin: BundleMcp): boolean {
  return builtin.authMode === 'oauth'
}

export function evaluateBuiltInMcp(builtin: BundleMcp, settings: CoworkSettings): BuiltInMcpResolution {
  const explicit = getExplicitEnabledState(builtin, settings)
  if (explicit === false) {
    return { status: 'skipped', reason: 'disabled-by-user' }
  }

  if (explicit !== true) {
    // No explicit user choice — apply implicit readiness heuristic.
    if (isOAuthMcp(builtin)) {
      return { status: 'skipped', reason: 'awaiting-oauth-opt-in' }
    }
    if (builtin.googleAuth && !getAdcPathIfAvailable()) {
      return { status: 'skipped', reason: 'not-signed-in-google' }
    }
    if (!hasRequiredCredentials(builtin, settings)) {
      return { status: 'skipped', reason: 'not-configured' }
    }
  } else {
    // Explicit enable — still skip if the prerequisites to actually
    // spawn aren't met. The UI should show a CTA (add key / sign in)
    // rather than letting the SDK emit confusing failures.
    if (builtin.googleAuth && !getAdcPathIfAvailable()) {
      return { status: 'skipped', reason: 'not-signed-in-google' }
    }
    if (!hasRequiredCredentials(builtin, settings)) {
      return { status: 'skipped', reason: 'not-configured' }
    }
  }

  const entry = buildBuiltInMcpEntry(builtin, settings)
  return entry ? { status: 'ready', entry } : { status: 'invalid' }
}

// If this MCP opted into Google auth and the app has a valid OAuth
// session on disk, return the env vars Google SDKs look for. Otherwise
// returns an empty object. Logs when skipping so downstream support has
// a breadcrumb for "my Sheets MCP can't authenticate".
//
// Two env vars are emitted:
//   - GOOGLE_APPLICATION_CREDENTIALS — path to the ADC file. Picked up
//     by `google-auth-library` and anything built on it (the Google
//     SDKs, `@ai-sdk/google-vertex`, etc.). Auto-refreshes the access
//     token from the refresh_token stored in the file.
//   - GOOGLE_WORKSPACE_CLI_TOKEN — the currently-cached access token.
//     Consumed by the `@googleworkspace/cli` binary, which does NOT
//     honor ADC and has its own token cache. With this env set it
//     skips the cache and uses the provided token directly. The caller
//     (bootRuntime) calls `refreshAccessToken()` before spawning so the
//     token is fresh at spawn time.
function googleAuthEnv(mcpName: string, googleAuth: boolean | undefined): Record<string, string> {
  if (!googleAuth) return {}
  const adcPath = getAdcPathIfAvailable()
  if (!adcPath) {
    log('mcp', `Skipping Google auth env for ${mcpName}: no active Google OAuth session`)
    return {}
  }
  const env: Record<string, string> = { GOOGLE_APPLICATION_CREDENTIALS: adcPath }
  const accessToken = getCachedAccessToken()
  if (accessToken) {
    env.GOOGLE_WORKSPACE_CLI_TOKEN = accessToken
  } else {
    log('mcp', `Skipping GOOGLE_WORKSPACE_CLI_TOKEN for ${mcpName}: no unexpired access token available`)
  }
  return env
}

function buildBuiltInMcpEntry(builtin: BundleMcp, settings: CoworkSettings): ResolvedRuntimeMcpEntry | null {
  if (builtin.type === 'local') {
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'local',
      command: builtin.command || ['node', mcpPath(builtin.packageName || builtin.name)],
    }
    const env: Record<string, string> = {}

    for (const envSetting of builtin.envSettings || []) {
      const value = getIntegrationCredentialValue(settings, builtin.name, envSetting.key)
      if (!value) continue
      env[envSetting.env] = value
    }

    if (builtin.name === 'skills') {
      env.OPEN_COWORK_CUSTOM_SKILLS_DIR = getMachineSkillsDir()
    }

    Object.assign(env, googleAuthEnv(builtin.name, builtin.googleAuth))

    if (Object.keys(env).length > 0) entry.environment = env
    return entry
  }

  if (builtin.url) {
    const headers: Record<string, string> = { ...(builtin.headers || {}) }

    for (const headerSetting of builtin.headerSettings || []) {
      const value = getIntegrationCredentialValue(settings, builtin.name, headerSetting.key)
      if (!value) continue
      headers[headerSetting.header] = `${headerSetting.prefix || ''}${value}`
    }

    const entry: ResolvedRuntimeMcpEntry = {
      type: 'remote',
      url: builtin.url,
    }
    if (Object.keys(headers).length > 0) entry.headers = headers
    return entry
  }

  return null
}

export function resolveConfiguredMcpRuntimeEntry(name: string, settings: CoworkSettings = getEffectiveSettings()): ResolvedRuntimeMcpEntry | null {
  const builtin = getConfiguredMcpsFromConfig().find((entry) => entry.name === name)
  if (!builtin) return null
  const resolution = evaluateBuiltInMcp(builtin, settings)
  return resolution.status === 'ready' ? resolution.entry : null
}

export function resolveCustomMcpRuntimeEntry(custom: CustomMcpConfig): ResolvedRuntimeMcpEntry | null {
  if (custom.type === 'stdio' && custom.command) {
    const env: Record<string, string> = { ...(custom.env || {}) }
    Object.assign(env, googleAuthEnv(custom.name, custom.googleAuth))
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'local',
      command: [custom.command, ...(custom.args || [])],
    }
    if (Object.keys(env).length > 0) entry.environment = env
    return entry
  }

  if (custom.type === 'http' && custom.url) {
    // Defense-in-depth: the URL policy also runs at save/test time, but
    // a tampered config file on disk (corruption, manual edit,
    // out-of-band write) would otherwise bypass the guard. Re-evaluate
    // here so the runtime NEVER spawns an HTTP MCP that fails the
    // policy, regardless of what's persisted.
    const verdict = evaluateHttpMcpUrl(custom.url, { allowPrivateNetwork: custom.allowPrivateNetwork })
    if (!verdict.ok) {
      log('mcp', `Rejecting HTTP MCP ${custom.name}: ${verdict.reason}`)
      return null
    }
    const entry: ResolvedRuntimeMcpEntry = {
      type: 'remote',
      url: custom.url,
    }
    if (custom.headers && Object.keys(custom.headers).length > 0) {
      entry.headers = custom.headers
    }
    return entry
  }

  return null
}
