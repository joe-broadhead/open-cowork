/// <reference types="node" />
/**
 * Shared loopback / RFC1918 / CGNAT private host policy (audit 2026-07-18).
 * Used by OpenCode endpoint guards and webhook SSRF checks.
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

export type PrivateHostPolicyOptions = {
  /** Allow non-IP hostnames ending in private DNS suffixes (e.g. host.docker.internal). */
  allowPrivateDns?: boolean
  /** Extra hostnames treated as private (lowercased). */
  extraHosts?: readonly string[]
}

export function normalizeHostname(hostname: string): string {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
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
  if (!isLoopbackOrPrivateHost(host, options)) {
    throw new Error(`${purpose} refuses public hosts; use loopback/private networking.`)
  }
  return url
}
