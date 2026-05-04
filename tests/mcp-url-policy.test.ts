import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateHttpMcpUrl, evaluateHttpMcpUrlResolved } from '../apps/desktop/src/main/mcp-url-policy.ts'

test('evaluateHttpMcpUrl accepts public internet URLs by default', () => {
  const result = evaluateHttpMcpUrl('https://api.example.com/mcp')
  assert.equal(result.ok, true)
})

test('evaluateHttpMcpUrl rejects loopback hostnames', () => {
  for (const url of ['http://localhost:4000/mcp', 'http://127.0.0.1/x', 'http://127.1.2.3/']) {
    const result = evaluateHttpMcpUrl(url)
    assert.equal(result.ok, false, `expected reject for ${url}`)
    if (result.ok === false) assert.match(result.reason, /loopback/i)
  }
})

test('evaluateHttpMcpUrl rejects AWS/Azure/GCP metadata link-local targets', () => {
  const result = evaluateHttpMcpUrl('http://169.254.169.254/latest/meta-data/')
  assert.equal(result.ok, false)
  if (result.ok === false) assert.match(result.reason, /metadata/i)
})

test('evaluateHttpMcpUrl rejects RFC1918 private ranges by default', () => {
  for (const url of ['http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.10/']) {
    const result = evaluateHttpMcpUrl(url)
    assert.equal(result.ok, false, `expected reject for ${url}`)
  }
})

test('evaluateHttpMcpUrl rejects special-use non-public ranges by default', () => {
  for (const url of [
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://192.0.2.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
  ]) {
    const result = evaluateHttpMcpUrl(url)
    assert.equal(result.ok, false, `expected reject for ${url}`)
    if (result.ok === false) assert.match(result.reason, /non-routable/i)
  }
})

test('evaluateHttpMcpUrl accepts private ranges when allowPrivateNetwork is true', () => {
  for (const url of ['http://localhost:3000', 'http://10.0.0.1/', 'http://192.168.1.1/']) {
    const result = evaluateHttpMcpUrl(url, { allowPrivateNetwork: true })
    assert.equal(result.ok, true, `expected accept for ${url} with opt-in`)
  }
})

test('evaluateHttpMcpUrl hard-denies cloud metadata endpoints even with private-network opt-in', () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/']) {
    const result = evaluateHttpMcpUrl(url, { allowPrivateNetwork: true })
    assert.equal(result.ok, false, `expected metadata endpoint reject for ${url}`)
    if (result.ok === false) assert.match(result.reason, /metadata/i)
  }
})

test('evaluateHttpMcpUrl rejects non-http protocols even with opt-in', () => {
  for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://x']) {
    const result = evaluateHttpMcpUrl(url, { allowPrivateNetwork: true })
    assert.equal(result.ok, false, `expected reject for ${url}`)
    if (result.ok === false) assert.match(result.reason, /protocol/i)
  }
})

test('evaluateHttpMcpUrl rejects IPv6 loopback + link-local + ULA', () => {
  // URL wraps bare IPv6 in brackets; replicate here.
  assert.equal(evaluateHttpMcpUrl('http://[::1]/').ok, false)
  assert.equal(evaluateHttpMcpUrl('http://[fe80::1]/').ok, false)
  assert.equal(evaluateHttpMcpUrl('http://[fd00::1]/').ok, false)
  assert.equal(evaluateHttpMcpUrl('http://[2001:db8::1]/').ok, false)
  assert.equal(evaluateHttpMcpUrl('http://[ff02::1]/').ok, false)
})

test('evaluateHttpMcpUrl rejects IPv6 zone-id link-local inputs', () => {
  const result = evaluateHttpMcpUrl('http://[fe80::1%25lo0]/')
  assert.equal(result.ok, false)
})

test('evaluateHttpMcpUrl rejects malformed URLs with a clear reason', () => {
  const result = evaluateHttpMcpUrl('not a url')
  assert.equal(result.ok, false)
  if (result.ok === false) assert.match(result.reason, /not valid/i)
})

test('evaluateHttpMcpUrl rejects empty input', () => {
  const result = evaluateHttpMcpUrl('')
  assert.equal(result.ok, false)
})

test('evaluateHttpMcpUrlResolved accepts public DNS answers', async () => {
  const result = await evaluateHttpMcpUrlResolved('https://api.example.com/mcp', {
    resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  assert.equal(result.ok, true)
})

test('evaluateHttpMcpUrlResolved rejects public-looking hostnames resolving to private networks', async () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '100.64.0.8', '198.18.0.1', '224.0.0.1', 'fd00::1', '2001:db8::1', 'ff02::1']) {
    const result = await evaluateHttpMcpUrlResolved('https://mcp.example.com/api', {
      resolveHostname: async () => [{ address }],
    })
    assert.equal(result.ok, false, `expected reject for resolved ${address}`)
    if (result.ok === false) assert.match(result.reason, /resolves/i)
  }
})

test('evaluateHttpMcpUrlResolved allows private DNS answers when private networks are explicitly allowed', async () => {
  let resolverCalled = false
  const result = await evaluateHttpMcpUrlResolved('https://mcp.example.com/api', {
    allowPrivateNetwork: true,
    resolveHostname: async () => {
      resolverCalled = true
      return [{ address: '127.0.0.1', family: 4 }]
    },
  })
  assert.equal(result.ok, true)
  assert.equal(resolverCalled, true)
})

test('evaluateHttpMcpUrlResolved rejects metadata DNS answers even with private-network opt-in', async () => {
  const result = await evaluateHttpMcpUrlResolved('https://mcp.example.com/api', {
    allowPrivateNetwork: true,
    resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
  })
  assert.equal(result.ok, false)
  if (result.ok === false) assert.match(result.reason, /metadata/i)
})

test('evaluateHttpMcpUrlResolved fails closed on DNS resolution errors', async () => {
  const result = await evaluateHttpMcpUrlResolved('https://missing.example.test/api', {
    resolveHostname: async () => {
      throw new Error('ENOTFOUND')
    },
  })
  assert.equal(result.ok, false)
  if (result.ok === false) assert.match(result.reason, /Could not resolve/i)
})
