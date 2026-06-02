import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveHttpClientSource,
  splitTrustedProxyCidrs,
} from '../packages/shared/src/http-client-source.ts'
import {
  resolveHttpClientSource as resolveHttpClientSourceFromDist,
  splitTrustedProxyCidrs as splitTrustedProxyCidrsFromDist,
} from '../packages/shared/dist/index.js'

const implementations = [
  {
    label: 'source',
    resolve: resolveHttpClientSource,
    splitCidrs: splitTrustedProxyCidrs,
  },
  {
    label: 'dist',
    resolve: resolveHttpClientSourceFromDist,
    splitCidrs: splitTrustedProxyCidrsFromDist,
  },
] as const

for (const implementation of implementations) {
  test(`http client source ignores forwarded headers without trusted proxy policy (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.8' },
      policy: { trustProxyHeaders: false, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '10.0.0.10')

    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.8' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: [] },
    }), '10.0.0.10')
  })

  test(`http client source rejects spoofed forwarded headers from untrusted peers (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '198.51.100.10',
      headers: { 'x-forwarded-for': '203.0.113.8' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '198.51.100.10')
  })

  test(`http client source walks trusted proxy chains from right to left (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.20' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '203.0.113.8')
  })

  test(`http client source falls back to the first proxy when the whole chain is trusted (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '10.0.0.30, 10.0.0.20' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '10.0.0.30')
  })

  test(`http client source supports Forwarded headers and IPv6 CIDRs (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '[fd00::10]:443',
      headers: { forwarded: 'for="[2001:db8::123]:443";proto=https, for="[fd00::20]"' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['fd00::/8'] },
    }), '2001:db8::123')
  })

  test(`http client source supports unquoted Forwarded headers and partial CIDR prefixes (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.129',
      headers: { forwarded: 'for=198.51.100.22;proto=https' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.128/25'] },
    }), '198.51.100.22')
  })

  test(`http client source requires Forwarded and x-forwarded-for to agree when both are present (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '127.0.0.1',
      headers: {
        forwarded: 'for="198.51.100.99";proto=https',
        'x-forwarded-for': '203.0.113.8, 127.0.0.2',
      },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['127.0.0.0/8'] },
    }), '127.0.0.1')

    assert.equal(implementation.resolve({
      socketAddress: '127.0.0.1',
      headers: {
        forwarded: 'for="203.0.113.8";proto=https',
        'x-forwarded-for': '203.0.113.8, 127.0.0.2',
      },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['127.0.0.0/8'] },
    }), '203.0.113.8')
  })

  test(`http client source normalizes IPv4-mapped socket addresses (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '::ffff:127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.22' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['127.0.0.0/8'] },
    }), '198.51.100.22')
  })

  test(`http client source normalizes IPv4-embedded IPv6 socket addresses (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '0:0:0:0:0:ffff:c000:221',
      headers: { 'x-forwarded-for': '198.51.100.22' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['192.0.2.33'] },
    }), '198.51.100.22')
  })

  test(`http client source preserves non-IP socket labels when proxy trust is disabled (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: 'unix:/tmp/open-cowork.sock',
      headers: { 'x-forwarded-for': '198.51.100.22' },
      policy: { trustProxyHeaders: false, trustedProxyCidrs: ['127.0.0.0/8'] },
    }), 'unix:/tmp/open-cowork.sock')

    assert.equal(implementation.resolve({
      socketAddress: '',
      headers: null,
      policy: null,
    }), 'unknown')
  })

  test(`http client source falls back to socket when forwarded headers are malformed (${implementation.label})`, () => {
    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': 'not-an-ip' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '10.0.0.10')

    assert.equal(implementation.resolve({
      socketAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.8, not-an-ip, 10.0.0.20' },
      policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    }), '10.0.0.10')
  })

  test(`trusted proxy CIDR parser accepts comma-separated and array inputs (${implementation.label})`, () => {
    assert.deepEqual(implementation.splitCidrs('10.0.0.0/8, 127.0.0.1,,'), ['10.0.0.0/8', '127.0.0.1'])
    assert.deepEqual(implementation.splitCidrs([' fd00::/8 ', '']), ['fd00::/8'])
  })
}
