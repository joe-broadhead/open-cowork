import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  assertSafeCommandPath,
  buildProductMcpLink,
  probeProductMcpLinks,
  PRODUCT_MCP_LINK_NAMES,
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
      assert.equal(result.name, PRODUCT_MCP_LINK_NAMES.gateway)
      assert.deepEqual(result.config.command, [bin, 'mcp'])
      assert.equal(result.config.environment?.GATEWAY_DAEMON_URL, 'http://127.0.0.1:5097')
      assert.equal(result.customMcp.type, 'stdio')
      assert.equal(result.customMcp.command, bin)
      assert.deepEqual(result.customMcp.args, ['mcp'])
      assert.equal(result.customMcp.scope, 'machine')
      assert.equal(result.customMcp.permissionMode, 'ask')
      // Never embeds bearer secrets — token file path only when provided.
      assert.equal(result.customMcp.env?.OPENCODE_GATEWAY_HTTP_READ_TOKEN, undefined)
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

  it('requires absolute wiki root and builds stdio MCP args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-mcp-wiki-'))
    const bin = join(dir, 'cowork-wiki')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(bin, 0o755)

    const missingRoot = buildProductMcpLink({ kind: 'wiki', command: bin })
    assert.equal(missingRoot.ok, false)
    if (!missingRoot.ok) assert.equal(missingRoot.code, 'wiki_root_required')

    const wikiRoot = join(dir, 'wiki-root')
    const result = buildProductMcpLink({
      kind: 'wiki',
      command: bin,
      wikiRoot,
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.name, PRODUCT_MCP_LINK_NAMES.wiki)
      assert.deepEqual(result.config.command, [bin, '--root', wikiRoot, 'mcp', '--stdio', '--tools', 'proposal'])
      assert.equal(result.customMcp.command, bin)
      assert.ok(result.customMcp.args?.includes('--stdio'))
    }
  })

  it('probes PATH and linked names for the soft-link panel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-mcp-probe-'))
    const bin = join(dir, 'cowork-gateway')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(bin, 0o755)

    const probes = probeProductMcpLinks({
      linkedNames: [PRODUCT_MCP_LINK_NAMES.gateway],
      pathEnv: dir,
    })
    const gateway = probes.find((row) => row.kind === 'gateway')
    const wiki = probes.find((row) => row.kind === 'wiki')
    assert.equal(gateway?.found, true)
    assert.equal(gateway?.linked, true)
    assert.equal(wiki?.found, false)
    assert.equal(wiki?.linked, false)
  })
})
