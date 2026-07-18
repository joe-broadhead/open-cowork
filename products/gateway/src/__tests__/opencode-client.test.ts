import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, writeConfig, getConfig } from '../config.js'
import { createGatewayOpenCodeClient, openCodeFetch } from '../opencode-client.js'
import { setTrustedOpenCodePeerHosts } from '../opencode-peer-hosts.js'

describe('createGatewayOpenCodeClient peer auth', () => {
  let testDir = ''
  let passwordFile = ''

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-opencode-client-'))
    passwordFile = path.join(testDir, 'peer.pass')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    fs.writeFileSync(passwordFile, 's3cret\n', { mode: 0o600 })
    clearConfigCacheForTest()
    setTrustedOpenCodePeerHosts([])
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_SERVER_PASSWORD']
    clearConfigCacheForTest()
    setTrustedOpenCodePeerHosts([])
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('injects basic auth for allowlisted peer with passwordFile', () => {
    const base = getConfig()
    writeConfig({
      ...base,
      opencodeUrl: 'https://opencode.lab.example',
      opencodePeers: {
        lab: {
          baseUrl: 'https://opencode.lab.example',
          allowHostnames: ['opencode.lab.example'],
          requireHttps: true,
          basicAuth: { passwordFile },
        },
      },
    } as any)

    const built = createGatewayOpenCodeClient()
    expect(built.authMode).toBe('basic')
    expect(built.peerName).toBe('lab')
    expect(built.baseUrl).toContain('opencode.lab.example')
  })

  it('fails closed when peer basicAuth is set without credentials', () => {
    const base = getConfig()
    writeConfig({
      ...base,
      opencodeUrl: 'https://opencode.lab.example',
      opencodePeers: {
        lab: {
          baseUrl: 'https://opencode.lab.example',
          allowHostnames: ['opencode.lab.example'],
          basicAuth: { passwordEnv: 'MISSING_PEER_PASSWORD' },
        },
      },
    } as any)
    expect(() => createGatewayOpenCodeClient()).toThrow(/requires basicAuth credentials/)
  })

  it('actually injects the Authorization: Basic header on outbound requests', async () => {
    const base = getConfig()
    writeConfig({
      ...base,
      opencodeUrl: 'https://opencode.lab.example',
      opencodePeers: {
        lab: { baseUrl: 'https://opencode.lab.example', allowHostnames: ['opencode.lab.example'], requireHttps: true, basicAuth: { passwordFile } },
      },
    } as any)
    const built = createGatewayOpenCodeClient()
    const captured: Headers[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: any, init: any) => {
      captured.push(new Headers(init?.headers))
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
    try {
      await (built.client.session.list() as any).catch(() => {})
    } finally {
      globalThis.fetch = realFetch
    }
    expect(captured.length).toBeGreaterThan(0)
    const auth = captured[0]!.get('Authorization')
    expect(auth).toMatch(/^Basic /)
    expect(Buffer.from(auth!.slice('Basic '.length), 'base64').toString()).toContain('s3cret')
  })

  it('injects trusted-peer Basic auth for raw OpenCode fetches', async () => {
    const base = getConfig()
    writeConfig({
      ...base,
      opencodeUrl: 'https://opencode.lab.example',
      opencodePeers: {
        lab: { baseUrl: 'https://opencode.lab.example', allowHostnames: ['opencode.lab.example'], requireHttps: true, basicAuth: { passwordFile } },
      },
    } as any)
    const captured: { url: string; headers: Headers }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init: any) => {
      captured.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
    try {
      await openCodeFetch('https://opencode.lab.example', 'global/health', {}, { timeoutMs: 1000 })
    } finally {
      globalThis.fetch = realFetch
    }

    expect(captured[0]?.url).toBe('https://opencode.lab.example/global/health')
    const auth = captured[0]!.headers.get('Authorization')
    expect(auth).toMatch(/^Basic /)
    expect(Buffer.from(auth!.slice('Basic '.length), 'base64').toString()).toContain('s3cret')
  })

  it('rejects the link-local / cloud-metadata address across IPv4, decimal, and IPv4-mapped IPv6 encodings', () => {
    const base = getConfig()
    // Dotted IPv4, decimal IPv4 (URL-canonicalized), IPv4-mapped IPv6 (URL
    // serializes to [::ffff:a9fe:a9fe]), and IPv6 link-local must all be refused.
    for (const host of ['169.254.169.254', '2852039166', '[::ffff:169.254.169.254]', '[fe80::1]', '0.0.0.0']) {
      expect(() => writeConfig({
        ...base,
        opencodePeers: { evil: { baseUrl: `http://${host}` } },
      } as any), host).toThrow(/link-local\/metadata\/unspecified/)
    }
  })

  it('requires https for trusted private-LAN peers by IP', () => {
    const base = getConfig()
    expect(() => writeConfig({
      ...base,
      opencodePeers: { lan: { baseUrl: 'http://192.168.1.50', allowHostnames: ['192.168.1.50'] } },
    } as any)).toThrow(/non-local peers require https/)
    expect(() => writeConfig({
      ...base,
      opencodePeers: { lan: { baseUrl: 'https://192.168.1.50', allowHostnames: ['192.168.1.50'] } },
    } as any)).not.toThrow()
  })

  it('requires https for trusted non-local hostname peers', () => {
    const base = getConfig()
    expect(() => writeConfig({
      ...base,
      opencodePeers: { lab: { baseUrl: 'http://opencode.lab.example', allowHostnames: ['opencode.lab.example'] } },
    } as any)).toThrow(/non-local peers require https/)
  })
})
