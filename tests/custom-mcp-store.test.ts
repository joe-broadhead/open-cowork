import { getMachineOpencodeConfigPath, getMachineOpencodeDir } from '@open-cowork/runtime-host/runtime-paths'
import { listCustomMcps, removeCustomMcp, saveCustomMcp } from '@open-cowork/runtime-host/native-customizations'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
function withTempUserData<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-custom-mcp-store-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = root
  clearConfigCaches()
  try {
    return fn()
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
}

test('custom MCP store saves, updates, lists, and removes machine MCPs', () => withTempUserData(() => {
  assert.equal(saveCustomMcp({
    scope: 'machine',
    directory: null,
    name: 'tickets',
    label: 'Tickets',
    description: 'Internal ticket workflow tools.',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { authorization: 'Bearer token' },
    allowPrivateNetwork: true,
    permissionMode: 'allow',
    traceLabel: 'ticket',
    tracePluralLabel: 'tickets',
  }), true)

  const saved = listCustomMcps().find((entry) => entry.name === 'tickets')
  assert.equal(saved?.type, 'http')
  assert.equal(saved?.label, 'Tickets')
  assert.equal(saved?.allowPrivateNetwork, true)
  assert.equal(saved?.permissionMode, 'allow')
  assert.equal(saved?.tracePluralLabel, 'tickets')

  assert.equal(saveCustomMcp({
    scope: 'machine',
    directory: null,
    name: 'tickets',
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { NODE_ENV: 'test' },
  }), true)

  const updated = listCustomMcps().find((entry) => entry.name === 'tickets')
  assert.equal(updated?.type, 'stdio')
  assert.equal(updated?.command, 'node')
  assert.deepEqual(updated?.args, ['server.js'])
  assert.deepEqual(updated?.env, { NODE_ENV: 'test' })
  assert.equal(updated?.label, undefined)

  assert.equal(removeCustomMcp({ scope: 'machine', directory: null, name: 'tickets' }), true)
  assert.equal(listCustomMcps().some((entry) => entry.name === 'tickets'), false)
}))

test('custom MCP store rejects incomplete MCP definitions before writing', () => withTempUserData(() => {
  assert.throws(() => {
    saveCustomMcp({
      scope: 'machine',
      directory: null,
      name: 'broken',
      type: 'http',
      url: '',
    })
  }, /Remote MCPs require a URL/)
  assert.equal(listCustomMcps().some((entry) => entry.name === 'broken'), false)
}))

test('custom MCP store rolls back OpenCode config when metadata write fails', () => withTempUserData(() => {
  const metadataPath = join(getMachineOpencodeDir(), 'mcp.open-cowork.json')
  mkdirSync(metadataPath, { recursive: true })

  assert.throws(() => {
    saveCustomMcp({
      scope: 'machine',
      directory: null,
      name: 'rollback-mcp',
      label: 'Rollback MCP',
      type: 'http',
      url: 'https://example.com/rollback-mcp',
    })
  }, /metadata write failed.*restored previous MCP config/i)

  assert.equal(listCustomMcps().some((entry) => entry.name === 'rollback-mcp'), false)
  if (existsSync(getMachineOpencodeConfigPath())) {
    const config = JSON.parse(readFileSync(getMachineOpencodeConfigPath(), 'utf8'))
    assert.equal(Boolean(config.mcp?.['rollback-mcp']), false)
  }
}))

test('custom MCP store repairs stale metadata sidecar entries during load', () => withTempUserData(() => {
  const metadataPath = join(getMachineOpencodeDir(), 'mcp.open-cowork.json')
  mkdirSync(getMachineOpencodeDir(), { recursive: true })
  writeFileSync(metadataPath, `${JSON.stringify({ ghost: { label: 'Ghost MCP' } }, null, 2)}\n`)

  assert.deepEqual(listCustomMcps(), [])
  assert.equal(existsSync(metadataPath), false)
}))
