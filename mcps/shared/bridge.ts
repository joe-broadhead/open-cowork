/**
 * Shared local-bridge HTTP client for the bundled bridge-backed MCP servers
 * (agents, workflows, knowledge, semantic-ui).
 *
 * Each MCP imports this module by relative path and `mcps/build.mjs`
 * (esbuild, bundle: true) inlines it into that MCP's dist bundle, so this
 * file must stay dependency-free and is not a workspace package of its own.
 */

export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 10_000

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface BridgeOptions {
  /** Environment variable holding the bridge base URL, e.g. OPEN_COWORK_AGENT_TOOL_URL. */
  urlEnvVar: string
  /** Environment variable holding the bridge bearer token, e.g. OPEN_COWORK_AGENT_TOOL_TOKEN. */
  tokenEnvVar: string
  /** Lowercase bridge noun for URL policy errors, e.g. 'agent bridge' or 'semantic UI bridge'. */
  bridgeName: string
  /** Capitalised label for request errors, e.g. 'Agent bridge' or 'Semantic UI bridge'. */
  bridgeLabel: string
  /**
   * Host policy for the bridge URL. Loopback-only MCPs (agents, workflows,
   * semantic-ui) keep the default `false`: the URL must be http:// on a
   * loopback host. The knowledge MCP passes `true`: its desktop runtime
   * points the URL at a loopback http bridge while its cloud runtime points
   * it at an https public URL (any host); http:// stays loopback-only either
   * way. Both values are runtime-set, never agent-set. This divergence is
   * intentional — do not change one MCP's policy to match another's.
   */
  allowNonLoopbackHttps?: boolean
  /** Request timeout override; defaults to DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number
}

export function createBridge<Path extends `/${string}`>(options: BridgeOptions) {
  const {
    urlEnvVar,
    tokenEnvVar,
    bridgeName,
    bridgeLabel,
    allowNonLoopbackHttps = false,
    timeoutMs = DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
  } = options

  function bridgeUrl() {
    const value = process.env[urlEnvVar]?.trim()
    if (!value) throw new Error(`${urlEnvVar} is not configured.`)
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`${urlEnvVar} must be a valid URL.`)
    }
    if (allowNonLoopbackHttps) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${urlEnvVar} must use http:// (local bridge) or https:// (cloud).`)
      }
      if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error(`${urlEnvVar} with http:// must point at the local ${bridgeName} (loopback).`)
      }
    } else {
      if (url.protocol !== 'http:') {
        throw new Error(`${urlEnvVar} must use http:// for the local bridge.`)
      }
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error(`${urlEnvVar} must point at the local ${bridgeName}.`)
      }
    }
    if (url.username || url.password) {
      throw new Error(`${urlEnvVar} must not include URL credentials.`)
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  }

  function bridgeToken() {
    const value = process.env[tokenEnvVar]?.trim()
    if (!value) throw new Error(`${tokenEnvVar} is not configured.`)
    if (value.length < 32) throw new Error(`${tokenEnvVar} is invalid.`)
    return value
  }

  async function postToBridge(path: Path, body: unknown = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetch(`${bridgeUrl()}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bridgeToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`${bridgeLabel} request timed out.`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { ok: false, error: text || `${bridgeLabel} returned invalid JSON.` }
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: unknown }).error)
        : `${bridgeLabel} returned HTTP ${response.status}.`
      throw new Error(error)
    }
    return parsed
  }

  return { bridgeUrl, bridgeToken, postToBridge }
}
