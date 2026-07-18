import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedOpenCodeFetchHost, openCodeEndpointUrl, safeOpenCodeBaseUrl, setTrustedOpenCodePeerHosts } from '../opencode-url-policy.js'

describe('OpenCode URL policy', () => {
  afterEach(() => {
    setTrustedOpenCodePeerHosts([])
  })

  it('allows local and Docker host OpenCode endpoints while preserving base paths', () => {
    expect(openCodeEndpointUrl('http://127.0.0.1:4096/api', 'global/health').toString()).toBe('http://127.0.0.1:4096/api/global/health')
    expect(openCodeEndpointUrl('http://host.docker.internal:4096', '/session').toString()).toBe('http://host.docker.internal:4096/session')
    expect(isAllowedOpenCodeFetchHost('workspace.localhost')).toBe(true)
  })

  it('rejects arbitrary hosts, non-http schemes, and embedded credentials before daemon-side fetches', () => {
    expect(() => safeOpenCodeBaseUrl('http://169.254.169.254/latest/meta-data')).toThrow(/not allowed/)
    expect(() => safeOpenCodeBaseUrl('file:///etc/passwd')).toThrow(/http or https/)
    expect(() => safeOpenCodeBaseUrl('http://user:pass@127.0.0.1:4096')).toThrow(/must not embed credentials/)
  })

  it('allows only explicitly trusted peer hostnames', () => {
    expect(() => safeOpenCodeBaseUrl('https://opencode.lab.example')).toThrow(/not allowed/)
    setTrustedOpenCodePeerHosts(['opencode.lab.example'])
    expect(safeOpenCodeBaseUrl('https://opencode.lab.example').hostname).toBe('opencode.lab.example')
    expect(() => safeOpenCodeBaseUrl('https://evil.example')).toThrow(/not allowed/)
  })
})
