/// <reference types="node" />
/**
 * Shared loopback / RFC1918 / CGNAT private host policy (audit 2026-07-18).
 * Used by OpenCode endpoint guards and webhook SSRF checks.
 *
 * Cloud instance-metadata endpoints (IMDS) are never private-safe for
 * OpenCode/private HTTP endpoints (audit 2026-07-21 SEC-4 / P2-1).
 */
import { BlockList, isIP } from 'node:net'

const privateAddresses = new BlockList()
privateAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
// Tailnet / carrier-grade NAT
privateAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
privateAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
privateAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
privateAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
privateAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
privateAddresses.addAddress('::1', 'ipv6')
privateAddresses.addSubnet('fc00::', 7, 'ipv6')
privateAddresses.addSubnet('fe80::', 10, 'ipv6')

const PRIVATE_DNS_SUFFIXES = ['.internal', '.local', '.lan', '.private', '.localhost'] as const

/** Always-blocked cloud instance-metadata hostnames (case-insensitive). */
const CLOUD_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
])

/** Always-blocked cloud instance-metadata IP literals. */
const CLOUD_METADATA_IPS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack IMDSv4
  'fd00:ec2::254', // AWS IMDSv6
])

export type PrivateHostPolicyOptions = {
  /** Allow non-IP hostnames ending in private DNS suffixes (e.g. host.docker.internal). */
  allowPrivateDns?: boolean
  /** Extra hostnames treated as private (lowercased). */
  extraHosts?: readonly string[]
  /**
   * When true (default for {@link assertPrivateHttpEndpoint}), refuse cloud
   * instance-metadata hosts even if they fall in link-local private ranges.
   */
  denyCloudMetadata?: boolean
}

export function normalizeHostname(hostname: string): string {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
}

/**
 * True when the host is a known cloud instance-metadata endpoint (IMDS).
 * Covers well-known hostnames, the IPv4 link-local metadata address, AWS IMDSv6,
 * and IPv4-mapped / NAT64 embeddings of 169.254.169.254.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return false
  if (CLOUD_METADATA_HOSTNAMES.has(host)) return true
  if (CLOUD_METADATA_IPS.has(host)) return true

  // IPv4-mapped IPv6: :ffff:169.254.169.254 or :ffff:a9fe:a9fe
  const mapped = host.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i) || host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped?.[1] && CLOUD_METADATA_IPS.has(mapped[1])) return true
  const mappedHex = host.match(/^:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16)
    const lo = Number.parseInt(mappedHex[2]!, 16)
    const a = (hi >> 8) & 0xff
    const b = hi & 0xff
    const c = (lo >> 8) & 0xff
    const d = lo & 0xff
    if (CLOUD_METADATA_IPS.has(`${a}.${b}.${c}.${d}`)) return true
  }

  // Decimal / integer IPv4 form of 169.254.169.254 = 2852039166
  if (/^\d+$/.test(host)) {
    try {
      const n = BigInt(host)
      if (n === 2852039166n) return true
    } catch {
      // ignore
    }
  }

  return false
}

export function isLoopbackOrPrivateHost(
  hostname: string,
  options: PrivateHostPolicyOptions = {},
): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return false
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === 'host.docker.internal') {
    return true
  }
  if (options.extraHosts?.some((entry) => normalizeHostname(entry) === host)) return true

  const ipVersion = isIP(host)
  if (ipVersion) {
    return privateAddresses.check(host, ipVersion === 4 ? 'ipv4' : 'ipv6')
  }

  if (options.allowPrivateDns) {
    if (host.endsWith('.localhost')) return true
    return PRIVATE_DNS_SUFFIXES.some((suffix) => host.endsWith(suffix))
  }
  return false
}

export function assertPrivateHttpEndpoint(
  baseUrl: string,
  options: PrivateHostPolicyOptions & {
    purpose?: string
    allowWildcardBind?: boolean
  } = {},
): URL {
  const purpose = options.purpose || 'endpoint'
  const denyCloudMetadata = options.denyCloudMetadata !== false
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (error) {
    throw new Error(
      `${purpose} must be a valid URL: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${purpose} must use HTTP or HTTPS.`)
  }
  if (url.username || url.password) {
    throw new Error(`${purpose} must not embed credentials.`)
  }
  const host = normalizeHostname(url.hostname)
  if (!options.allowWildcardBind && (host === '0.0.0.0' || host === '::')) {
    throw new Error(`${purpose} must not be bound to a wildcard address.`)
  }
  if (denyCloudMetadata && isCloudMetadataHost(host)) {
    throw new Error(
      `${purpose} refuses cloud instance-metadata hosts (e.g. 169.254.169.254); OpenCode and private endpoints must not target IMDS.`,
    )
  }
  if (!isLoopbackOrPrivateHost(host, options)) {
    throw new Error(`${purpose} refuses public hosts; use loopback/private networking.`)
  }
  return url
}
