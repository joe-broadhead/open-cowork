import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  assertSafeCommandPath,
  buildProductMcpLink,
  validateOwnerOnlyTokenFile,
} from '@open-cowork/runtime-host/product-mcp-link'

describe('product MCP soft-link helpers (JOE-909)', () => {
  it('rejects shell metacharacters in command paths', () => {
    assert.match(assertSafeCommandPath('cowork-gateway; rm -rf /') || '', /unsafe/)
    assert.equal(assertSafeCommandPath('cowork-gateway'), undefined)
  })

  it('fails closed when binary is missing', () => {
    const result = buildProductMcpLink({
      kind: 'gateway',
      pathEnv: '/nonexistent-bin-dir-for-smoke',
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'binary_missing')
      assert.match(result.installHint, /Gateway/)
    }
  })

  it('builds gateway MCP config when binary resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-mcp-link-'))
    const bin = join(dir, 'cowork-gateway')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(bin, 0o755)

    const result = buildProductMcpLink({
      kind: 'gateway',
      command: bin,
      gatewayDaemonUrl: 'http://127.0.0.1:5097',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.name, 'cowork-gateway')
      assert.deepEqual(result.config.command, [bin, 'mcp'])
      assert.equal(result.config.environment?.GATEWAY_DAEMON_URL, 'http://127.0.0.1:5097')
    }
  })

  it('rejects token files that are group/world readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-mcp-token-'))
    const token = join(dir, 'token')
    writeFileSync(token, 'secret\n', { mode: 0o644 })
    chmodSync(token, 0o644)
    assert.match(validateOwnerOnlyTokenFile(token) || '', /owner-only/)

    chmodSync(token, 0o600)
    assert.equal(validateOwnerOnlyTokenFile(token), undefined)
  })

  it('builds wiki MCP config when binary resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-mcp-wiki-'))
    const bin = join(dir, 'cowork-wiki')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(bin, 0o755)

    const result = buildProductMcpLink({
      kind: 'wiki',
      command: bin,
      wikiRoot: '/tmp/wiki-demo',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.name, 'cowork-wiki')
      assert.ok(result.config.command.includes('--root'))
      assert.equal(result.config.environment?.OPENWIKI_ROOT, '/tmp/wiki-demo')
    }
  })
})
