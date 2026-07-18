/** Leaf module: trusted OpenCode peer hostnames for URL policy (no imports). */

let trustedPeerHosts = new Set<string>()

export function setTrustedOpenCodePeerHosts(hosts: Iterable<string>): void {
  trustedPeerHosts = new Set(
    [...hosts]
      .map(host => String(host || '').trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isTrustedOpenCodePeerHost(hostname: string): boolean {
  const host = String(hostname || '').trim().toLowerCase()
  return trustedPeerHosts.has(host)
}
