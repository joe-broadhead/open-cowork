import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupCloudArtifactOpenTempDirs, decodeCloudArtifactDataUrl, registerArtifactHandlers, safeArtifactOpenFilename, safeArtifactExportFilename } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { createIpcHandlerHarness as createBaseContext } from './support/ipc-handler-harness.ts'

test('artifact handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { artifacts: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listArtifacts: async (sessionId) => {
      calls.push(`list:${sessionId}`)
      return [{
        id: 'artifact-1',
        toolId: 'cloud-artifact',
        toolName: 'cloud.artifact',
        filePath: 'cloud-artifact://artifact-1/result.txt',
        filename: 'result.txt',
        order: 0,
        source: 'cloud',
        cloudArtifactId: 'artifact-1',
        mime: 'text/plain',
      }]
    },
    uploadArtifact: async (input) => {
      calls.push(`upload:${input.sessionId}:${input.filename}`)
      return {
        id: 'artifact-2',
        toolId: 'cloud-artifact',
        toolName: 'cloud.artifact',
        filePath: 'cloud-artifact://artifact-2/upload.txt',
        filename: input.filename,
        order: 0,
        source: 'cloud',
        cloudArtifactId: 'artifact-2',
        mime: input.contentType || undefined,
      }
    },
    readArtifactAttachment: async (sessionId, filePath) => {
      calls.push(`read:${sessionId}:${filePath}`)
      return {
        mime: 'text/plain',
        filename: 'result.txt',
        url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      }
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => null,
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => {
        throw new Error('not used')
      },
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerArtifactHandlers(context)

  assert.equal((await handlers.get('artifact:list')?.({}, { sessionId: 'session-1', workspaceId: 'cloud:test' }))?.[0]?.cloudArtifactId, 'artifact-1')
  assert.equal((await handlers.get('artifact:upload')?.({}, {
    sessionId: 'session-1',
    workspaceId: 'cloud:test',
    filename: 'upload.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('hello').toString('base64'),
  }))?.cloudArtifactId, 'artifact-2')
  assert.equal((await handlers.get('artifact:read-attachment')?.({}, {
    sessionId: 'session-1',
    workspaceId: 'cloud:test',
    filePath: 'cloud-artifact://artifact-1/result.txt',
  }))?.filename, 'result.txt')
  await assert.rejects(
    () => handlers.get('artifact:reveal')?.({}, {
      sessionId: 'session-1',
      workspaceId: 'cloud:test',
      filePath: 'cloud-artifact://artifact-1/result.txt',
    }),
    /Cloud artifacts cannot be revealed/,
  )

  assert.deepEqual(calls, [
    'list:session-1',
    'upload:session-1:upload.txt',
    'read:session-1:cloud-artifact://artifact-1/result.txt',
  ])
})

test('cloud artifact export helpers validate data URLs and sanitize default filenames', () => {
  assert.deepEqual(
    decodeCloudArtifactDataUrl(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`),
    Buffer.from('hello'),
  )
  assert.deepEqual(
    decodeCloudArtifactDataUrl(`data:text/plain; charset=utf-8;base64,${Buffer.from('hello').toString('base64')}`),
    Buffer.from('hello'),
  )
  assert.throws(
    () => decodeCloudArtifactDataUrl('https://cloud.example.test/artifact.txt'),
    /base64 data URL/,
  )
  assert.throws(
    () => decodeCloudArtifactDataUrl('data:text/plain;base64,not valid base64!'),
    /valid base64/,
  )

  assert.equal(safeArtifactExportFilename('../report.txt'), 'report.txt')
  assert.equal(safeArtifactExportFilename('/tmp/report.txt'), 'report.txt')
  assert.equal(safeArtifactExportFilename(''), 'artifact')
  assert.equal(safeArtifactOpenFilename('result.txt', 'text/plain', 'run.command'), 'result.txt')
  assert.equal(safeArtifactOpenFilename('result.md', 'application/octet-stream', 'run.command'), 'result.md')
  assert.throws(
    () => safeArtifactOpenFilename('spreadsheet.csv', 'text/csv', 'result.txt'),
    /cannot be opened directly/,
  )
  assert.throws(
    () => safeArtifactOpenFilename('run.command', 'text/plain', 'result.txt'),
    /cannot be opened directly/,
  )
})

test('cloud artifact open temp cleanup only removes stale scoped directories', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-open-temp-root-'))
  try {
    const oldOpenDir = join(tempRoot, 'open-cowork-artifact-old')
    const freshOpenDir = join(tempRoot, 'open-cowork-artifact-fresh')
    const unrelatedDir = join(tempRoot, 'open-cowork-other-old')
    mkdirSync(oldOpenDir)
    mkdirSync(freshOpenDir)
    mkdirSync(unrelatedDir)
    writeFileSync(join(oldOpenDir, 'artifact.txt'), 'old')
    writeFileSync(join(freshOpenDir, 'artifact.txt'), 'fresh')
    writeFileSync(join(unrelatedDir, 'artifact.txt'), 'unrelated')

    const nowMs = Date.now()
    const oldDate = new Date(nowMs - 10_000)
    const freshDate = new Date(nowMs - 500)
    utimesSync(oldOpenDir, oldDate, oldDate)
    utimesSync(freshOpenDir, freshDate, freshDate)
    utimesSync(unrelatedDir, oldDate, oldDate)

    assert.equal(cleanupCloudArtifactOpenTempDirs(tempRoot, { nowMs, maxAgeMs: 1_000 }), 1)
    assert.equal(existsSync(oldOpenDir), false)
    assert.equal(existsSync(freshOpenDir), true)
    assert.equal(existsSync(unrelatedDir), true)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('capability handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { capabilities: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listCapabilityTools: async () => {
      calls.push('tools')
      return [{
        id: 'read',
        name: 'Read',
        description: 'Read files',
        kind: 'built-in',
        source: 'builtin',
        patterns: ['read'],
        agentNames: ['build'],
      }]
    },
    getCapabilityTool: async (toolId) => {
      calls.push(`tool:${toolId}`)
      return {
        id: toolId,
        name: 'Read',
        description: 'Read files',
        kind: 'built-in',
        source: 'builtin',
        patterns: ['read'],
        agentNames: ['build'],
      }
    },
    listCapabilitySkills: async () => {
      calls.push('skills')
      return [{
        name: 'analysis',
        label: 'Analysis',
        description: 'Analyze data',
        source: 'builtin',
        toolIds: ['read'],
        agentNames: ['data-analyst'],
      }]
    },
    getCapabilitySkillBundle: async (skillName) => {
      calls.push(`bundle:${skillName}`)
      return {
        name: skillName,
        source: 'builtin',
        content: '# Analysis',
        files: [{ path: 'examples/report.md' }],
      }
    },
    readCapabilitySkillBundleFile: async (skillName, filePath) => {
      calls.push(`file:${skillName}:${filePath}`)
      return 'report example'
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => null,
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => {
        throw new Error('not used')
      },
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerCatalogHandlers(context)

  assert.equal((await handlers.get('capabilities:tools')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.id, 'read')
  assert.equal((await handlers.get('capabilities:tool')?.({}, 'read', { workspaceId: 'cloud:test' }))?.name, 'Read')
  assert.equal((await handlers.get('capabilities:skills')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analysis')
  assert.equal((await handlers.get('capabilities:skill-bundle')?.({}, 'analysis', { workspaceId: 'cloud:test' }))?.name, 'analysis')
  assert.equal(await handlers.get('capabilities:skill-bundle-file')?.({}, 'analysis', 'examples/report.md', { workspaceId: 'cloud:test' }), 'report example')

  assert.deepEqual(calls, [
    'tools',
    'tool:read',
    'skills',
    'bundle:analysis',
    'file:analysis:examples/report.md',
  ])
})

test('custom content handlers sync portable cloud metadata and block local-only content', async () => {
  const { context, handlers } = createBaseContext()
  const settings = new Map<string, Record<string, unknown>>()
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { customMcps: true, customSkills: true, agents: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    listCapabilityTools: async () => [{
      id: 'read',
      name: 'Read',
      description: 'Read files',
      kind: 'built-in',
      source: 'builtin',
      patterns: ['read'],
      agentNames: ['build'],
    }],
    listCapabilitySkills: async () => [{
      name: 'analysis',
      label: 'Analysis',
      description: 'Analyze data',
      source: 'builtin',
      toolIds: ['read'],
      agentNames: ['build'],
    }],
    getSetting: async (key) => ({
      key,
      value: settings.get(key) || { items: [] },
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    setSetting: async (key, value) => {
      settings.set(key, value)
      return {
        key,
        value,
        updatedAt: '2026-05-27T10:01:00.000Z',
      }
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => null,
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => {
        throw new Error('not used')
      },
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerCustomContentHandlers(context)
  registerCatalogHandlers(context)

  assert.equal(await handlers.get('custom:add-mcp')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'remote_docs',
    type: 'http',
    url: 'https://mcp.example.test',
  }), true)
  assert.equal((await handlers.get('custom:list-mcps')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'remote_docs')
  await assert.rejects(
    () => handlers.get('custom:add-mcp')?.({}, {
      workspaceId: 'cloud:test',
      scope: 'machine',
      name: 'local_shell',
      type: 'stdio',
      command: 'node',
    }),
    /Local stdio MCPs stay in the Local workspace/,
  )

  assert.equal(await handlers.get('custom:add-skill')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analysis',
    content: '# Analysis\n\nUse the read tool.',
    toolIds: ['read'],
  }), true)
  assert.equal((await handlers.get('custom:list-skills')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analysis')

  assert.equal(await handlers.get('agents:create')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
    description: 'Analyze data',
    instructions: 'Use the analysis skill.',
    skillNames: ['analysis'],
    toolIds: ['read'],
    enabled: true,
    color: 'primary',
    mode: 'primary',
    permissionOverrides: [
      { key: 'bash', action: 'allow' },
    ],
  }), true)
  assert.equal((await handlers.get('agents:list')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.name, 'analyst')
  assert.equal((await handlers.get('agents:list')?.({}, { workspaceId: 'cloud:test' }))?.[0]?.writeAccess, true)
  assert.equal((await handlers.get('agents:catalog')?.({}, { workspaceId: 'cloud:test' }))?.tools[0]?.id, 'read')
  assert.equal(await handlers.get('agents:update')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
  }, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
    description: 'Analyze data with updated copy',
    instructions: 'Use the analysis skill.',
    skillNames: ['analysis'],
    toolIds: ['read'],
    enabled: true,
    color: 'primary',
  }), true)
  const updatedAgent = (await handlers.get('agents:list')?.({}, { workspaceId: 'cloud:test' }))?.[0]
  assert.equal(updatedAgent?.mode, 'primary')
  assert.deepEqual(updatedAgent?.permissionOverrides, [
    { key: 'bash', action: 'allow' },
  ])
  assert.equal(updatedAgent?.writeAccess, true)
  await assert.rejects(
    () => handlers.get('agents:create')?.({}, {
      workspaceId: 'cloud:test',
      scope: 'machine',
      name: 'local-path-agent',
      description: 'Should not sync local directory permissions',
      instructions: 'Do not save.',
      skillNames: [],
      toolIds: ['read'],
      enabled: true,
      color: 'primary',
      permissionOverrides: [
        { key: 'external_directory', action: 'deny', rules: [{ pattern: '/Users/alice/Private/*', action: 'allow' }] },
      ],
    }),
    /Cloud custom agents cannot reference local external-directory permissions/,
  )
  assert.equal(await handlers.get('agents:remove')?.({}, {
    workspaceId: 'cloud:test',
    scope: 'machine',
    name: 'analyst',
  }, 'confirm'), true)
})
