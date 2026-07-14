import { BlockList, isIP } from 'node:net'

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addAddress('::1', 'ipv6')

const nonPublicAddresses = new BlockList()
nonPublicAddresses.addSubnet('0.0.0.0', 8, 'ipv4')
nonPublicAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
nonPublicAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
nonPublicAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
nonPublicAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
nonPublicAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
nonPublicAddresses.addSubnet('192.0.0.0', 24, 'ipv4')
nonPublicAddresses.addSubnet('192.0.2.0', 24, 'ipv4')
nonPublicAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
nonPublicAddresses.addSubnet('198.18.0.0', 15, 'ipv4')
nonPublicAddresses.addSubnet('198.51.100.0', 24, 'ipv4')
nonPublicAddresses.addSubnet('203.0.113.0', 24, 'ipv4')
nonPublicAddresses.addSubnet('224.0.0.0', 4, 'ipv4')
nonPublicAddresses.addSubnet('240.0.0.0', 4, 'ipv4')
nonPublicAddresses.addAddress('::', 'ipv6')
nonPublicAddresses.addAddress('::1', 'ipv6')
nonPublicAddresses.addSubnet('fc00::', 7, 'ipv6')
nonPublicAddresses.addSubnet('fe80::', 10, 'ipv6')
nonPublicAddresses.addSubnet('2001:db8::', 32, 'ipv6')
nonPublicAddresses.addSubnet('ff00::', 8, 'ipv6')

function normalizeHostname(hostname: string | null | undefined) {
  const host = (hostname || '').trim().toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Classify only validated loopback literals (including IPv4-mapped IPv6) or localhost. */
export function isLoopbackCloudHost(hostname: string | null | undefined) {
  const host = normalizeHostname(hostname)
  if (!host) return false
  if (host === 'localhost') return true
  const family = isIP(host)
  if (!family) return false
  return loopbackAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

/** True for localhost or a validated IP literal that cannot be a public origin. */
export function isNonPublicCloudHost(hostname: string | null | undefined) {
  const host = normalizeHostname(hostname)
  if (!host) return true
  if (host === 'localhost') return true
  const family = isIP(host)
  if (!family) return false
  return nonPublicAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6')
}
