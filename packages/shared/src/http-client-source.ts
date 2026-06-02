export type HttpClientSourcePolicy = {
  trustProxyHeaders?: boolean
  trustedProxyCidrs?: readonly string[] | null
}

export type HttpClientSourceInput = {
  socketAddress?: string | null
  headers?: Record<string, string | string[] | undefined> | null
  policy?: HttpClientSourcePolicy | null
}

type ParsedIp = {
  version: 4 | 6
  bytes: number[]
  normalized: string
}

export function splitTrustedProxyCidrs(value: string | readonly string[] | null | undefined): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

export function resolveHttpClientSource(input: HttpClientSourceInput): string {
  const socket = parseIpAddress(input.socketAddress || '')?.normalized || normalizeSourceLabel(input.socketAddress) || 'unknown'
  const policy = input.policy
  if (!policy?.trustProxyHeaders) return socket

  const trustedCidrs = splitTrustedProxyCidrs(policy.trustedProxyCidrs)
  if (!trustedCidrs.length || !isTrustedProxy(socket, trustedCidrs)) return socket

  const chains = forwardedClientChains(input.headers || {})
  const candidates = [
    resolveForwardedChain(chains.forwarded, trustedCidrs),
    resolveForwardedChain(chains.xForwardedFor, trustedCidrs),
  ].filter((candidate): candidate is ParsedIp => candidate !== null)

  if (!candidates.length) return socket
  if (!candidates.every((candidate) => candidate.normalized === candidates[0]?.normalized)) {
    return socket
  }
  return candidates[0].normalized
}

function forwardedClientChains(headers: Record<string, string | string[] | undefined>) {
  const forwarded = firstHeader(headers, 'forwarded')
  const xForwardedFor = firstHeader(headers, 'x-forwarded-for')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (!forwarded) {
    return { forwarded: [], xForwardedFor }
  }

  const forwardedChain = forwarded.split(',')
    .map((entry) => entry.split(';')
      .map((field) => field.trim())
      .find((field) => /^for=/i.test(field)))
    .map((field) => field?.replace(/^for=/i, '').trim() || '')
    .map(unquoteForwardedValue)
    .filter(Boolean)

  return { forwarded: forwardedChain, xForwardedFor }
}

function resolveForwardedChain(chain: readonly string[], trustedCidrs: readonly string[]) {
  if (!chain.length) return null
  const parsed = chain.map((entry) => parseIpAddress(entry))
  if (parsed.some((entry) => entry === null)) return null

  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const candidate = parsed[index]
    if (candidate && !isTrustedProxy(candidate.normalized, trustedCidrs)) return candidate
  }
  return parsed[0]
}

function firstHeader(headers: Record<string, string | string[] | undefined>, name: string) {
  const value = headers[name]
    || Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function unquoteForwardedValue(value: string) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

function normalizeSourceLabel(value: string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function isTrustedProxy(address: string, trustedCidrs: readonly string[]) {
  const parsed = parseIpAddress(address)
  if (!parsed) return false
  return trustedCidrs.some((cidr) => ipMatchesCidr(parsed, cidr))
}

function ipMatchesCidr(ip: ParsedIp, cidr: string) {
  const [rawAddress, rawPrefix] = cidr.split('/')
  const trusted = parseIpAddress(rawAddress || '')
  if (!trusted || trusted.version !== ip.version) return false
  const maxBits = ip.version === 4 ? 32 : 128
  const prefix = rawPrefix === undefined || rawPrefix === ''
    ? maxBits
    : Number(rawPrefix)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false
  return bytesMatchPrefix(ip.bytes, trusted.bytes, prefix)
}

function bytesMatchPrefix(left: readonly number[], right: readonly number[], prefixBits: number) {
  const wholeBytes = Math.floor(prefixBits / 8)
  for (let index = 0; index < wholeBytes; index += 1) {
    if (left[index] !== right[index]) return false
  }
  const remainingBits = prefixBits % 8
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return ((left[wholeBytes] || 0) & mask) === ((right[wholeBytes] || 0) & mask)
}

function parseIpAddress(input: string): ParsedIp | null {
  const normalized = normalizeIpInput(input)
  if (!normalized) return null
  const ipv4 = parseIpv4(normalized)
  if (ipv4) return ipv4
  return parseIpv6(normalized)
}

function normalizeIpInput(input: string) {
  let value = input.trim()
  if (!value) return ''
  const bracketMatch = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketMatch) value = bracketMatch[1] || ''
  const ipv4PortMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value)
  if (ipv4PortMatch) value = ipv4PortMatch[1] || ''
  const zoneIndex = value.indexOf('%')
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex)
  if (value.toLowerCase().startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    if (parseIpv4(mapped)) value = mapped
  }
  return value
}

function parseIpv4(value: string): ParsedIp | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1
    const parsed = Number(part)
    return parsed >= 0 && parsed <= 255 ? parsed : -1
  })
  if (bytes.some((byte) => byte < 0)) return null
  return { version: 4, bytes, normalized: bytes.join('.') }
}

function parseIpv6(value: string): ParsedIp | null {
  if (!value.includes(':')) return null
  const halves = value.toLowerCase().split('::')
  if (halves.length > 2) return null

  const left = splitIpv6Half(halves[0] || '')
  const right = splitIpv6Half(halves[1] || '')
  if (!left || !right) return null

  const missing = 8 - left.length - right.length
  if (halves.length === 1 && missing !== 0) return null
  if (halves.length === 2 && missing < 1) return null

  const words = [...left, ...Array(Math.max(0, missing)).fill(0), ...right]
  if (words.length !== 8) return null

  const mapped = ipv4MappedWords(words)
  if (mapped) return mapped

  const bytes = words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff])
  return {
    version: 6,
    bytes,
    normalized: compressIpv6(words),
  }
}

function splitIpv6Half(value: string): number[] | null {
  if (!value) return []
  const parts = value.split(':')
  const words: number[] = []
  for (const part of parts) {
    if (!part) return null
    if (part.includes('.')) {
      if (part !== parts[parts.length - 1]) return null
      const ipv4 = parseIpv4(part)
      if (!ipv4) return null
      words.push((ipv4.bytes[0] << 8) | ipv4.bytes[1])
      words.push((ipv4.bytes[2] << 8) | ipv4.bytes[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    words.push(parseInt(part, 16))
  }
  return words
}

function ipv4MappedWords(words: readonly number[]): ParsedIp | null {
  if (
    words[0] === 0
    && words[1] === 0
    && words[2] === 0
    && words[3] === 0
    && words[4] === 0
    && words[5] === 0xffff
  ) {
    const bytes = [
      (words[6] >> 8) & 0xff,
      words[6] & 0xff,
      (words[7] >> 8) & 0xff,
      words[7] & 0xff,
    ]
    return { version: 4, bytes, normalized: bytes.join('.') }
  }
  return null
}

function compressIpv6(words: readonly number[]) {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 0) continue
    let end = index + 1
    while (end < words.length && words[end] === 0) end += 1
    const length = end - index
    if (length > bestLength && length > 1) {
      bestStart = index
      bestLength = length
    }
    index = end - 1
  }
  if (bestStart < 0) return words.map((word) => word.toString(16)).join(':')
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(':')
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(':')
  if (!left && !right) return '::'
  if (!left) return `::${right}`
  if (!right) return `${left}::`
  return `${left}::${right}`
}
