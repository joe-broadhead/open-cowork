// Policy gate for HTTP MCP URLs.
//
// Without this, a user can configure an HTTP MCP pointing at any URL
// the Electron runtime can reach from the host — including AWS IMDS
// (169.254.169.254), internal corporate APIs, and localhost services.
// That's a classic SSRF channel: a prompt-injected agent could tell
// an MCP to issue requests that exfiltrate cloud metadata tokens or
// read internal dashboards.
//
// Legitimate downstream installs do sometimes need internal-network
// MCPs (on-prem corp tools at 10.*, local dev servers on 127.*), so
// the policy is opt-in via `CustomMcpConfig.allowPrivateNetwork`. The
// default posture is "public internet only."

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const LOOPBACK_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
])

const loopbackBlocks = new BlockList()
loopbackBlocks.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackBlocks.addAddress('::1', 'ipv6')

const linkLocalBlocks = new BlockList()
linkLocalBlocks.addSubnet('169.254.0.0', 16, 'ipv4')
linkLocalBlocks.addSubnet('fe80::', 10, 'ipv6')

const privateBlocks = new BlockList()
privateBlocks.addSubnet('10.0.0.0', 8, 'ipv4')
privateBlocks.addSubnet('172.16.0.0', 12, 'ipv4')
privateBlocks.addSubnet('192.168.0.0', 16, 'ipv4')
privateBlocks.addSubnet('fc00::', 7, 'ipv6')

const nonRoutableBlocks = new BlockList()
nonRoutableBlocks.addSubnet('0.0.0.0', 8, 'ipv4')
nonRoutableBlocks.addAddress('::', 'ipv6')

export type McpDnsResolver = (hostname: string) => Promise<Array<{ address: string; family?: number }>>

type McpUrlPolicyOptions = {
  allowPrivateNetwork?: boolean
}

export type McpUrlResolutionOptions = McpUrlPolicyOptions & {
  resolveHostname?: McpDnsResolver
}

type BlockedNetwork = {
  kind: 'loopback' | 'link-local' | 'private' | 'non-routable'
  address: string
}

function normalizeHostname(hostname: string) {
  const lower = hostname.toLowerCase()
  const withoutBrackets = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  const zoneIndex = withoutBrackets.indexOf('%')
  return zoneIndex >= 0 ? withoutBrackets.slice(0, zoneIndex) : withoutBrackets
}

function ipv4MappedAddress(hostname: string) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(hostname)
  return match?.[1] || null
}

function blockListAddressType(address: string) {
  const type = isIP(address)
  if (type === 4) return 'ipv4'
  if (type === 6) return 'ipv6'
  return null
}

function classifyBlockedNetwork(hostname: string): BlockedNetwork | null {
  if (LOOPBACK_HOSTS.has(hostname)) {
    return { kind: 'loopback', address: hostname }
  }

  const mapped = ipv4MappedAddress(hostname)
  const address = mapped || hostname
  const type = blockListAddressType(address)
  if (!type) return null

  if (loopbackBlocks.check(address, type)) {
    return { kind: 'loopback', address }
  }
  if (linkLocalBlocks.check(address, type)) {
    return { kind: 'link-local', address }
  }
  if (privateBlocks.check(address, type)) {
    return { kind: 'private', address }
  }
  if (nonRoutableBlocks.check(address, type)) {
    return { kind: 'non-routable', address }
  }
  return null
}

function rejectionReason(blocked: BlockedNetwork, source: 'literal' | 'resolved') {
  const prefix = source === 'resolved'
    ? `URL hostname resolves to a ${blocked.kind} address (${blocked.address}).`
    : `URL targets a ${blocked.kind} address.`

  if (blocked.kind === 'loopback') {
    return `${prefix} Enable "Allow private network" on the MCP if this is intentional.`
  }
  if (blocked.kind === 'link-local') {
    return `${prefix} Cloud metadata endpoints are blocked by default — enable "Allow private network" if you genuinely need it.`
  }
  if (blocked.kind === 'private') {
    return `${prefix} Enable "Allow private network" on the MCP to use corporate-internal endpoints.`
  }
  return `${prefix} Enable "Allow private network" only if this local target is intentional.`
}

async function defaultDnsResolver(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true })
}

export type McpUrlPolicyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

// Classify a URL and return either the parsed URL for the caller to
// use, or an explicit reason the URL was rejected. Callers decide
// whether to surface the reason to the user verbatim.
export function evaluateHttpMcpUrl(
  rawUrl: string,
  options?: McpUrlPolicyOptions,
): McpUrlPolicyResult {
  if (!rawUrl || !rawUrl.trim()) {
    return { ok: false, reason: 'URL is required.' }
  }

  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return { ok: false, reason: 'URL is not valid.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported URL protocol "${url.protocol}". Only http and https are allowed.` }
  }

  // WHATWG URL preserves IPv6 brackets in hostname; strip them so the
  // policy matchers below see the bare address.
  const hostname = normalizeHostname(url.hostname)

  if (options?.allowPrivateNetwork) {
    return { ok: true, url }
  }

  const blocked = classifyBlockedNetwork(hostname)
  if (blocked) {
    return { ok: false, reason: rejectionReason(blocked, 'literal') }
  }

  return { ok: true, url }
}

export async function evaluateHttpMcpUrlResolved(
  rawUrl: string,
  options: McpUrlResolutionOptions = {},
): Promise<McpUrlPolicyResult> {
  const staticVerdict = evaluateHttpMcpUrl(rawUrl, options)
  if (!staticVerdict.ok || options.allowPrivateNetwork) {
    return staticVerdict
  }

  const hostname = normalizeHostname(staticVerdict.url.hostname)
  if (blockListAddressType(hostname)) {
    return staticVerdict
  }

  const resolver = options.resolveHostname || defaultDnsResolver
  let records: Array<{ address: string; family?: number }>
  try {
    records = await resolver(hostname)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `Could not resolve MCP hostname "${hostname}": ${message}` }
  }

  if (records.length === 0) {
    return { ok: false, reason: `Could not resolve MCP hostname "${hostname}".` }
  }

  for (const record of records) {
    const address = normalizeHostname(record.address)
    const blocked = classifyBlockedNetwork(address)
    if (blocked) {
      return { ok: false, reason: rejectionReason(blocked, 'resolved') }
    }
  }

  return staticVerdict
}
