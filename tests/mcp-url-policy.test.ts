import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateHttpMcpUrl } from '../apps/desktop/src/main/mcp-url-policy.ts'

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
  if (result.ok === false) assert.match(result.reason, /link-local/i)
})

test('evaluateHttpMcpUrl rejects RFC1918 private ranges by default', () => {
  for (const url of ['http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.10/']) {
    const result = evaluateHttpMcpUrl(url)
    assert.equal(result.ok, false, `expected reject for ${url}`)
  }
})

test('evaluateHttpMcpUrl accepts private ranges when allowPrivateNetwork is true', () => {
  for (const url of ['http://localhost:3000', 'http://10.0.0.1/', 'http://192.168.1.1/']) {
    const result = evaluateHttpMcpUrl(url, { allowPrivateNetwork: true })
    assert.equal(result.ok, true, `expected accept for ${url} with opt-in`)
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
