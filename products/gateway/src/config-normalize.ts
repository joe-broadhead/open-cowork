/**
 * Pure config normalization utilities and peer-host guards (LOC façade split).
 * Leaf relative to config.ts — no import from config.ts.
 */
import * as net from 'node:net'
import { isCloudMetadataHost } from '@open-cowork/shared/node'

export function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return number
}

export function boundedNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be a number between ${min} and ${max}`)
  return number
}

export function assertProfileName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('profile name must be 1-64 letters, numbers, underscores, or dashes')
}

export function deepMerge<T extends Record<string, any>>(defaults: T, overrides: T): T {
  const result = { ...defaults }
  for (const key of Object.keys(overrides)) {
    if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key]) && typeof defaults[key] === 'object') {
      (result as any)[key] = deepMerge(defaults[key], overrides[key])
    } else {
      (result as any)[key] = overrides[key]
    }
  }
  return result
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export function isNonLocalHostname(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (!value || value === 'localhost') return false
  if (net.isIP(value)) return !isLoopbackIp(value)
  if (value === 'host.docker.internal') return false
  return true
}

export function isLoopbackIp(value: string): boolean {
  if (net.isIPv4(value)) return value.startsWith('127.')
  if (!value.includes(':')) return false
  const bytes = ipv6ToBytes(value)
  if (!bytes) return false
  const ipv4Mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (ipv4Mapped) return bytes[12] === 127
  return bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
}

/** SSRF-classic hosts that must never be a trusted OpenCode peer fetch target. */
export function isForbiddenPeerHost(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (!value) return true
  // Shared IMDS denylist (audit 2026-07-21) — keep Durable Gateway peers aligned
  // with monorepo private-host / webhook metadata policy.
  if (isCloudMetadataHost(value)) return true
  // Parse numerically rather than pattern-match the serialized string: a
  // link-local/metadata target can hide behind decimal/hex IPv4 forms or an
  // IPv4-mapped IPv6 literal (e.g. [::ffff:169.254.169.254], which WHATWG URL
  // serializes to [::ffff:a9fe:a9fe]).
  if (net.isIPv4(value)) return isForbiddenIpv4Octets(value.split('.').map(Number))
  if (value.includes(':')) {
    const bytes = ipv6ToBytes(value)
    if (!bytes) return true // unparseable IPv6 literal → fail closed
    if (bytes.every(byte => byte === 0)) return true                       // :: unspecified
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true       // fe80::/10 link-local
    const ipv4Mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    if (ipv4Mapped) return isForbiddenIpv4Octets([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!])
    return false
  }
  return false // plain hostname: the exact-match allowlist governs trust
}

function isForbiddenIpv4Octets(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  if (octets[0] === 0) return true                       // 0.0.0.0/8 (incl. unspecified)
  if (octets[0] === 169 && octets[1] === 254) return true // 169.254.0.0/16 link-local / cloud metadata
  return false
}

/** Expand an IPv6 literal (incl. an embedded dotted-quad tail) to 16 bytes, or null if malformed. */
export function ipv6ToBytes(addr: string): number[] | null {
  let text = addr
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const octets = [Number(dotted[2]), Number(dotted[3]), Number(dotted[4]), Number(dotted[5])]
    if (octets.some(n => n > 255)) return null
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value = parseInt(group, 16)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes
}
