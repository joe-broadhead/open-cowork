import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { runtimeState } from '@open-cowork/runtime-host/runtime-state'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAppHandlers, resolveSafeSaveTextPath, saveTextExportFile } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { normalizeFindTextPattern, registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'
import { registerWorkflowHandlers } from '../apps/desktop/src/main/ipc/workflow-handlers.ts'
import { sniffImageMime } from '../apps/desktop/src/main/ipc/app-handler-support.ts'
import { validateCustomSkillConfig } from '../apps/desktop/src/main/ipc/object-validators.ts'
import { createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { createIpcHandlerHarness as createBaseContext } from './support/ipc-handler-harness.ts'

test('workflow mutation handlers reject malformed workflow ids before service calls', async () => {
  const { context, handlers } = createBaseContext()

  registerWorkflowHandlers(context)
  const handler = handlers.get('workflows:run-now')

  assert.ok(handler, 'expected workflows:run-now handler to be registered')
  await assert.rejects(
    () => handler({}, { id: 'workflow-1' }),
    /workflow id to be a string/,
  )
})

test('workflow handlers route cloud workspace operations through the workspace gateway', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { workflows: true },
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
    listWorkflows: async () => {
      calls.push('list')
      return { workflows: [], runs: [] }
    },
    getWorkflow: async (workflowId) => {
      calls.push(`get:${workflowId}`)
      return null
    },
    runWorkflow: async (workflowId) => {
      calls.push(`run:${workflowId}`)
      return null
    },
    pauseWorkflow: async (workflowId) => {
      calls.push(`pause:${workflowId}`)
      return null
    },
    resumeWorkflow: async (workflowId) => {
      calls.push(`resume:${workflowId}`)
      return null
    },
    archiveWorkflow: async (workflowId) => {
      calls.push(`archive:${workflowId}`)
      return null
    },
    rotateWorkflowWebhookSecret: async (workflowId) => {
      calls.push(`rotate:${workflowId}`)
      return null
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

  registerWorkflowHandlers(context)

  await handlers.get('workflows:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('workflows:get')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:run-now')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:pause')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:resume')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:archive')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })
  await handlers.get('workflows:regenerate-webhook-secret')?.({}, 'workflow-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(calls, [
    'list',
    'get:workflow-1',
    'run:workflow-1',
    'pause:workflow-1',
    'resume:workflow-1',
    'archive:workflow-1',
    'rotate:workflow-1',
  ])

  context.workspaceGateway.activate({}, 'cloud:test')
  await assert.rejects(
    () => handlers.get('workflows:start-draft')?.({}, undefined),
    /Local workspace/,
  )
})

test('settings:set rejects non-object payloads before saving settings', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('settings:set')

  assert.ok(handler, 'expected settings:set handler to be registered')
  await assert.rejects(
    () => handler({}, null),
    /settings update to be an object/,
  )
})

test('sniffImageMime accepts only image magic bytes', () => {
  assert.equal(sniffImageMime(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png')
  assert.equal(sniffImageMime(Buffer.from('ffd8ffe000104a464946', 'hex')), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('4749463839610000', 'hex')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.from('524946460000000057454250', 'hex')), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('not really an image')), null)
})

test('custom content write handlers reject malformed objects before save paths', async () => {
  const { context, handlers } = createBaseContext()
  let confirmed = false
  context.requestNativeConfirmation = async () => {
    confirmed = true
    return true
  }

  registerCustomContentHandlers(context)
  const addSkill = handlers.get('custom:add-skill')
  const addMcp = handlers.get('custom:add-mcp')

  assert.ok(addSkill, 'expected custom:add-skill handler to be registered')
  assert.ok(addMcp, 'expected custom:add-mcp handler to be registered')
  await assert.rejects(
    () => addSkill({}, []),
    /custom skill to be an object/,
  )
  await assert.rejects(
    () => addMcp({}, 'not-an-object'),
    /custom MCP to be an object/,
  )
  assert.equal(confirmed, false)
})

test('custom skill IPC validation preserves authored content bytes', () => {
  const skillContent = '  Skill body\n\nkeep intentional trailing newline\n'
  const paddedContent = '  keep leading whitespace\nand trailing whitespace  \n'
  const validated = validateCustomSkillConfig({
    scope: 'machine',
    name: 'test-skill',
    content: skillContent,
    files: [
      { path: 'notes.txt', content: paddedContent },
      { path: 'empty.txt', content: '' },
    ],
  })

  assert.equal(validated.content, skillContent)
  assert.equal(validated.files?.[0]?.content, paddedContent)
  assert.equal(validated.files?.[1]?.content, '')
  assert.throws(
    () => validateCustomSkillConfig({ scope: 'machine', name: 'empty-skill', content: '   \n' }),
    /Skill content is required/,
  )
})

test('explorer:file-read returns null for ungranted renderer-supplied directories', async () => {
  const { context, handlers, errors } = createBaseContext()
  context.resolveGrantedProjectDirectory = () => {
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }

  registerExplorerHandlers(context)
  const handler = handlers.get('explorer:file-read')

  assert.ok(handler, 'expected explorer:file-read handler to be registered')
  const result = await handler({}, '/etc/passwd', '/etc')

  assert.equal(result, null)
  assert.match(errors[0] || '', /explorer:directory/)
  assert.match(errors[0] || '', /native directory picker/)
})

test('explorer list and find use native V2 filesystem routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-explorer-v2-'))
  const docs = join(root, 'docs')
  mkdirSync(docs)
  writeFileSync(join(root, 'README.md'), 'hello')
  const calls: Array<{ method: string; input: unknown }> = []
  const client = {
    v2: {
      fs: {
        async list(input: unknown) {
          calls.push({ method: 'v2.fs.list', input })
          return { data: { data: [
            { path: 'docs/', type: 'directory' },
            { path: 'README.md', type: 'file' },
          ] } }
        },
        async find(input: unknown) {
          calls.push({ method: 'v2.fs.find', input })
          return { data: { data: [{ path: 'README.md', type: 'file' }] } }
        },
      },
    },
  }

  runtimeState.setClient(client as Parameters<typeof runtimeState.setClient>[0])
  try {
    const { context, handlers } = createBaseContext()
    registerExplorerHandlers(context)

    assert.deepEqual(await handlers.get('explorer:file-list')?.({}, root, root), [
      { name: 'docs', path: 'docs/', absolute: docs, type: 'directory', ignored: false },
      { name: 'README.md', path: 'README.md', absolute: join(root, 'README.md'), type: 'file', ignored: false },
    ])
    assert.deepEqual(await handlers.get('explorer:find-files')?.({}, {
      query: 'read',
      dirs: false,
      limit: 25,
    }, root), ['README.md'])
    assert.deepEqual(calls, [
      {
        method: 'v2.fs.list',
        input: { location: { directory: root }, path: '.' },
      },
      {
        method: 'v2.fs.find',
        input: {
          query: 'read',
          type: 'file',
          limit: '25',
          location: { directory: root },
        },
      },
    ])
  } finally {
    runtimeState.resetAfterStop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('explorer find-text pattern validation caps costly regex input', () => {
  assert.equal(normalizeFindTextPattern('  TODO  '), 'TODO')
  assert.equal(normalizeFindTextPattern('   '), null)
  assert.throws(() => normalizeFindTextPattern('x'.repeat(513)), /exceeds 512 bytes/)
  assert.throws(() => normalizeFindTextPattern('(a+)+$'), /nested quantifier/)
})

test('artifact:read-attachment rejects private files that were not surfaced by the session', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-unsurfaced-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/secret.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('artifact export and reveal reject private files that were not surfaced by the session', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-unsurfaced-export-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const exportHandler = handlers.get('artifact:export')
    const revealHandler = handlers.get('artifact:reveal')

    assert.ok(exportHandler, 'expected artifact:export handler to be registered')
    assert.ok(revealHandler, 'expected artifact:reveal handler to be registered')
    await assert.rejects(
      () => exportHandler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/secret.txt' }),
      /Only surfaced session artifacts/,
    )
    await assert.rejects(
      () => revealHandler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/secret.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('artifact:read-attachment rejects non-object payloads before artifact resolution', async () => {
  const { context, handlers } = createBaseContext()
  let resolved = false
  context.resolvePrivateArtifactPath = () => {
    resolved = true
    throw new Error('artifact should not be resolved')
  }

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:read-attachment')

  assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-an-object'),
    /artifact request to be an object/,
  )
  assert.equal(resolved, false)
})

test('artifact:read-attachment authorizes the resolved artifact path, not a renderer-supplied alias', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-resolved-source-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'tool_call',
        id: 'write-link',
        name: 'write',
        status: 'complete',
        input: { filePath: '/tmp/open-cowork-private-workspace/link.txt' },
      },
    })
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/link.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('artifact IPC validates request shape before resolving private paths', async () => {
  const { context, handlers } = createBaseContext()
  let resolveCalled = false
  context.resolvePrivateArtifactPath = () => {
    resolveCalled = true
    return { root: '/tmp', source: '/tmp/file.txt' }
  }

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:export')

  assert.ok(handler, 'expected artifact:export handler to be registered')
  await assert.rejects(
    () => handler({}, { sessionId: 'session-1', filePath: '' }),
    /Artifact path is required/,
  )
  assert.equal(resolveCalled, false)
})

test('artifact:open rejects active artifact file types before shell open', async () => {
  const { context, handlers } = createBaseContext()
  context.resolvePrivateArtifactPath = () => ({ root: '/tmp', source: '/tmp/run.command' })

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:open')

  assert.ok(handler, 'expected artifact:open handler to be registered')
  await assert.rejects(
    () => handler({}, { sessionId: 'session-1', filePath: '/tmp/run.command' }),
    /cannot be opened directly/,
  )
})

test('artifact:open rejects passive private files that were not surfaced by the session', async () => {
  const { context, handlers } = createBaseContext()
  context.resolvePrivateArtifactPath = () => ({ root: '/tmp', source: '/tmp/private-note.txt' })

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:open')

  assert.ok(handler, 'expected artifact:open handler to be registered')
  await assert.rejects(
    () => handler({}, { sessionId: 'session-1', filePath: '/tmp/private-note.txt' }),
    /surfaced session artifacts/,
  )
})

test('chart:save-artifact rejects unknown sessions before writing chart bytes', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('chart:save-artifact')

  assert.ok(handler, 'expected chart:save-artifact handler to be registered')
  await assert.rejects(
    () => handler({}, {
      sessionId: 'fake-session',
      toolCallId: 'tool-1',
      toolName: 'charts.create_bar',
      dataUrl: 'data:image/png;base64,AAAA',
    }),
    /existing session/,
  )
})

test('dialog:save-text path policy keeps exports as non-sensitive json files', () => {
  assert.equal(resolveSafeSaveTextPath('/tmp/agent'), '/tmp/agent.json')
  assert.equal(resolveSafeSaveTextPath('/tmp/agent.cowork-agent.json'), '/tmp/agent.cowork-agent.json')
  assert.throws(
    () => resolveSafeSaveTextPath('/tmp/agent.md'),
    /must use a \.json extension/,
  )
  assert.throws(
    () => resolveSafeSaveTextPath('/Users/example/.ssh/config'),
    /sensitive configuration path/,
  )
})

test('dialog:save-text writes private export files atomically', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-save-text-'))
  try {
    const outputPath = join(tempRoot, 'agent.cowork-agent.json')
    saveTextExportFile(outputPath, '{"ok":true}\n')

    assert.equal(readFileSync(outputPath, 'utf-8'), '{"ok":true}\n')
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
