import { getEffectiveSettings, getIntegrationCredentialValue, type CoworkSettings } from '@open-cowork/runtime-host/settings'
import { resolveConfiguredMcpRuntimeEntry, type ResolvedRuntimeMcpEntry } from '@open-cowork/runtime-host/runtime-mcp'
import { evaluateHttpMcpUrlResolved, type McpDnsResolver } from '@open-cowork/runtime-host/mcp-url-policy'
import { credentialFieldIsVisible, type CapabilityToolEntry, type McpPreflightResult, sanitizeLogMessage } from '@open-cowork/shared'
import { getConfiguredMcpsFromConfig, type BundleMcp } from './config-loader.ts'
type FetchLike = typeof fetch

type McpPreflightDeps = {
  fetchImpl?: FetchLike
  listToolsFromMcpEntry: (entry: ResolvedRuntimeMcpEntry, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<CapabilityToolEntry[]>
  resolveHostname?: McpDnsResolver
  timeoutMs?: number
}

type AuthProbeResult =
  | { ok: true }
  | { ok: false; result: McpPreflightResult }

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BODY_CHARS = 1_000

function result(input: Omit<McpPreflightResult, 'ok'> & { ok?: boolean }): McpPreflightResult {
  return {
    ok: input.ok ?? input.status === 'ok',
    ...input,
  }
}

function responseBodyPreview(body: string) {
  const normalized = body.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return sanitizeLogMessage(normalized.slice(0, MAX_RESPONSE_BODY_CHARS))
}

async function readResponseBody(response: Response) {
  try {
    return responseBodyPreview(await response.text())
  } catch {
    return undefined
  }
}

function configuredMcpHelpText(mcp: BundleMcp) {
  return typeof mcp.credentialHelp === 'string' && mcp.credentialHelp.trim()
    ? mcp.credentialHelp.trim()
    : undefined
}

function configuredMcpHost(mcp: BundleMcp) {
  if (!mcp.url) return undefined
  try {
    return new URL(mcp.url).host
  } catch {
    return undefined
  }
}

function requiredCredentialKeys(mcp: BundleMcp, settings: CoworkSettings) {
  const credentials = mcp.credentials || []
  const credentialValues = Object.fromEntries(
    credentials.map((credential) => [
      credential.key,
      getIntegrationCredentialValue(settings, mcp.name, credential.key) || '',
    ]),
  )
  return credentials
    .filter((credential) => credentialFieldIsVisible(credential, credentialValues))
    .filter((credential) => credential.required !== false)
    .filter((credential) => !getIntegrationCredentialValue(settings, mcp.name, credential.key))
    .map((credential) => credential.label || credential.key)
}

function classifyProtocolError(name: string, host: string | undefined, error: unknown, helpText?: string): McpPreflightResult {
  const message = error instanceof Error ? error.message : String(error || '')
  const errorName = error instanceof Error ? error.name : ''
  const lower = `${errorName} ${message}`.toLowerCase()
  const safeMessage = responseBodyPreview(message)
  if (/401|unauthorized|invalid[_-]?token|missing authorization header|bad credentials/.test(lower)) {
    return result({
      status: 'auth_rejected',
      mcpName: name,
      host,
      message: `${name} rejected the saved token. Check that the token is valid, not revoked, and has the required scopes.`,
      helpText,
    })
  }
  if (/403|forbidden|sso|policy|organization|enterprise/.test(lower)) {
    return result({
      status: 'forbidden',
      mcpName: name,
      host,
      message: `${name} accepted the request but denied access. Check token scopes, SSO authorization, repository restrictions, or organization policy.`,
      helpText,
    })
  }
  if (/abort|aborted|enotfound|econnrefused|econnreset|etimedout|timeout|network|tls|certificate|proxy/.test(lower)) {
    return result({
      status: 'network_error',
      mcpName: name,
      host,
      message: `Could not reach ${host || name}. Check DNS, TLS certificates, VPN, proxy, or firewall settings.`,
      helpText,
    })
  }
  return result({
    status: 'protocol_error',
    mcpName: name,
    host,
    message: `${name} responded, but the MCP tool-list handshake failed: ${safeMessage || 'unknown protocol error'}`,
    helpText,
  })
}

async function runAuthProbe(
  mcp: BundleMcp,
  entry: ResolvedRuntimeMcpEntry,
  deps: Pick<McpPreflightDeps, 'fetchImpl' | 'timeoutMs'>,
): Promise<AuthProbeResult> {
  if (entry.type !== 'remote') return { ok: true }
  const url = new URL(entry.url)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (deps.fetchImpl || fetch)(url, {
      method: 'GET',
      headers: entry.headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    const responseBody = response.status >= 400 ? await readResponseBody(response) : undefined
    if (response.status === 401) {
      return {
        ok: false,
        result: result({
          status: 'auth_rejected',
          mcpName: mcp.name,
          host: url.host,
          httpStatus: response.status,
          responseBody,
          message: `${mcp.name} rejected the saved token with HTTP 401. Check that the token is valid and not revoked.`,
          helpText: configuredMcpHelpText(mcp),
        }),
      }
    }
    if (response.status === 403) {
      return {
        ok: false,
        result: result({
          status: 'forbidden',
          mcpName: mcp.name,
          host: url.host,
          httpStatus: response.status,
          responseBody,
          message: `${mcp.name} returned HTTP 403. Check token scopes, SSO authorization, repository restrictions, or organization policy.`,
          helpText: configuredMcpHelpText(mcp),
        }),
      }
    }
    if (response.status === 407 || response.status === 511) {
      return {
        ok: false,
        result: result({
          status: 'network_error',
          mcpName: mcp.name,
          host: url.host,
          httpStatus: response.status,
          responseBody,
          message: `${mcp.name} returned HTTP ${response.status}. Check proxy authentication, captive portal sign-in, or network policy on this machine.`,
          helpText: configuredMcpHelpText(mcp),
        }),
      }
    }
    if (response.status >= 500) {
      return {
        ok: false,
        result: result({
          status: 'http_error',
          mcpName: mcp.name,
          host: url.host,
          httpStatus: response.status,
          responseBody,
          message: `${mcp.name} returned HTTP ${response.status}. The remote MCP endpoint is reachable but unhealthy.`,
          helpText: configuredMcpHelpText(mcp),
        }),
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      result: result({
        status: 'network_error',
        mcpName: mcp.name,
        host: url.host,
        message: `Could not reach ${url.host}. Check DNS, TLS certificates, VPN, proxy, or firewall settings.`,
        responseBody: responseBodyPreview(error instanceof Error ? error.message : String(error || '')),
        helpText: configuredMcpHelpText(mcp),
      }),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function preflightConfiguredApiTokenMcp(
  name: string,
  deps: McpPreflightDeps,
): Promise<McpPreflightResult> {
  const mcp = getConfiguredMcpsFromConfig().find((entry) => entry.name === name)
  if (!mcp) {
    return result({
      status: 'not_found',
      mcpName: name,
      message: `No bundled MCP named "${name}" is configured.`,
    })
  }

  const helpText = configuredMcpHelpText(mcp)
  if (mcp.type !== 'remote' || mcp.authMode !== 'api_token') {
    return result({
      status: 'not_applicable',
      mcpName: name,
      message: `${name} does not use remote API-token authentication.`,
      helpText,
    })
  }
  if (!mcp.url) {
    return result({
      status: 'invalid_config',
      mcpName: name,
      message: `${name} is missing a remote MCP URL.`,
      helpText,
    })
  }

  const settings = getEffectiveSettings()
  const missing = requiredCredentialKeys(mcp, settings)
  if (missing.length > 0) {
    return result({
      status: 'missing_credentials',
      mcpName: name,
      host: configuredMcpHost(mcp),
      message: `Save ${missing.join(', ')} before testing ${name}.`,
      helpText,
    })
  }

  const urlVerdict = await evaluateHttpMcpUrlResolved(mcp.url, {
    allowPrivateNetwork: mcp.allowPrivateNetwork,
    resolveHostname: deps.resolveHostname,
  })
  if (!urlVerdict.ok) {
    return result({
      status: 'invalid_config',
      mcpName: name,
      message: urlVerdict.reason,
      helpText,
    })
  }

  const entry = resolveConfiguredMcpRuntimeEntry(name, settings)
  if (!entry || entry.type !== 'remote') {
    return result({
      status: 'invalid_config',
      mcpName: name,
      host: urlVerdict.url.host,
      message: `${name} is not ready to connect. Check its URL, credentials, and enablement state.`,
      helpText,
    })
  }

  const authProbe = await runAuthProbe(mcp, entry, deps)
  if (!authProbe.ok) return authProbe.result

  try {
    const methods = await deps.listToolsFromMcpEntry(entry, { timeoutMs: deps.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS })
    return result({
      status: 'ok',
      mcpName: name,
      host: urlVerdict.url.host,
      methodCount: methods.length,
      message: methods.length > 0
        ? `${name} connected and exposed ${methods.length} MCP method${methods.length === 1 ? '' : 's'}.`
        : `${name} connected, but it did not expose any MCP methods.`,
      helpText,
    })
  } catch (error) {
    return classifyProtocolError(name, urlVerdict.url.host, error, helpText)
  }
}
