import { afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CoworkAPI, EffectiveAppSettings } from '@open-cowork/shared'

type TestCoworkApi = {
  [Group in keyof CoworkAPI]?: Record<string, unknown>
}

function createDefaultSettings(overrides: Partial<EffectiveAppSettings> = {}): EffectiveAppSettings {
  return {
    selectedProviderId: null,
    selectedModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission: 'deny',
    fileWritePermission: 'deny',
    webPermission: 'allow',
    webSearchEnabled: true,
    taskPermission: 'allow',
    externalDirectoryPermission: 'allow',
    mcpPermission: 'allow',
    requireApprovalBeforeSending: true,
    notificationVoiceReplies: true,
    notificationSmartSuggestions: true,
    notificationDailyDigest: false,
    notificationSounds: true,
    privacyKeepConversationHistory: true,
    privacyShareAnonymizedUsage: false,
    runtimeToolingBridgeEnabled: true,
    windowZoomFactor: 1,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: null,
    workflowQuietHoursEnd: null,
    effectiveProviderId: null,
    effectiveModel: null,
    ...overrides,
  }
}

function installCoworkApi(overrides: TestCoworkApi = {}) {
  const api: TestCoworkApi = {
    workspace: {
      list: vi.fn(async () => [{
        id: 'local',
        kind: 'local',
        label: 'Local',
        status: 'online',
        active: true,
        lastSyncedAt: null,
      }]),
      activate: vi.fn(async () => ({
        id: 'local',
        kind: 'local',
        label: 'Local',
        status: 'online',
        active: true,
        lastSyncedAt: null,
      })),
      addCloud: vi.fn(async (input: { baseUrl: string; label?: string }) => ({
        id: 'cloud:test',
        kind: 'cloud',
        label: input.label || 'Cloud',
        status: 'disabled',
        active: false,
        baseUrl: input.baseUrl,
        lastSyncedAt: null,
      })),
      addGateway: vi.fn(async (input: { baseUrl: string; label?: string }) => ({
        id: 'gateway:test',
        kind: 'gateway',
        authority: 'gateway_standalone',
        label: input.label || 'Gateway',
        status: 'auth_required',
        active: false,
        baseUrl: input.baseUrl,
        lastSyncedAt: null,
      })),
      remove: vi.fn(async () => true),
      login: vi.fn(async () => ({
        id: 'local',
        kind: 'local',
        label: 'Local',
        status: 'online',
        active: true,
        lastSyncedAt: null,
      })),
      logout: vi.fn(async () => ({
        id: 'local',
        kind: 'local',
        label: 'Local',
        status: 'online',
        active: true,
        lastSyncedAt: null,
      })),
      policy: vi.fn(async () => ({
        features: {},
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
        localFiles: 'enabled',
        localStdioMcps: 'enabled',
        machineRuntimeConfig: 'allowlisted',
      })),
      support: vi.fn(async () => []),
      sync: vi.fn(async () => ({ ok: true, syncedAt: new Date().toISOString() })),
    },
    desktopPairing: {
      list: vi.fn(async () => []),
      create: vi.fn(async (input: { label: string }) => ({
        record: {
          id: 'pairing-1',
          label: input.label,
          deviceName: 'Test device',
          status: 'paired_offline',
          enabled: true,
          brokerUrl: null,
          allowedWorkspaceIds: ['local'],
          allowedSessionIds: null,
          policy: {
            allowRemotePrompts: true,
            allowRemoteAbort: true,
            remoteApprovals: 'local_confirmation',
            remoteQuestions: 'local_confirmation',
            exposeArtifactBodies: false,
            exposeLocalPaths: false,
            exposeLocalMcpDetails: false,
            allowRemoteAttachments: false,
          },
          lastConnectedAt: null,
          lastHeartbeatAt: null,
          lastCommandSequence: 0,
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
          credential: {
            hasToken: true,
            deviceId: 'device-1',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        pairingToken: 'pairing-token',
      })),
      update: vi.fn(async (pairingId: string) => ({
        id: pairingId,
        label: 'Test pairing',
        deviceName: 'Test device',
        status: 'paired_offline',
        enabled: true,
        brokerUrl: null,
        allowedWorkspaceIds: ['local'],
        allowedSessionIds: null,
        policy: {
          allowRemotePrompts: true,
          allowRemoteAbort: true,
          remoteApprovals: 'local_confirmation',
          remoteQuestions: 'local_confirmation',
          exposeArtifactBodies: false,
          exposeLocalPaths: false,
          exposeLocalMcpDetails: false,
          allowRemoteAttachments: false,
        },
        lastConnectedAt: null,
        lastHeartbeatAt: null,
        lastCommandSequence: 0,
        error: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
        credential: {
          hasToken: true,
          deviceId: 'device-1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })),
      connect: vi.fn(async (pairingId: string) => ({
        pairingId,
        status: 'paired_online',
        enabled: true,
        lastConnectedAt: '2026-01-01T00:00:00.000Z',
        lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
        lastCommandSequence: 0,
        error: null,
      })),
      disconnect: vi.fn(async (pairingId: string) => ({
        pairingId,
        status: 'paired_offline',
        enabled: true,
        lastConnectedAt: null,
        lastHeartbeatAt: null,
        lastCommandSequence: 0,
        error: null,
      })),
      revoke: vi.fn(async (pairingId: string) => ({
        pairingId,
        status: 'revoked',
        enabled: false,
        lastConnectedAt: null,
        lastHeartbeatAt: null,
        lastCommandSequence: 0,
        error: null,
      })),
      sync: vi.fn(async (pairingId: string) => ({
        pairingId,
        status: 'paired_online',
        enabled: true,
        lastConnectedAt: '2026-01-01T00:00:00.000Z',
        lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
        lastCommandSequence: 0,
        error: null,
      })),
      audit: vi.fn(async () => []),
    },
    app: {
      builtinAgents: vi.fn(async () => []),
      metadata: vi.fn(async () => ({ version: '0.0.0', preview: true, surface: 'desktop' as const })),
      config: vi.fn(async () => ({
        branding: {
          appId: 'com.opencowork.desktop',
          name: 'Open Cowork',
          dataDirName: 'Open Cowork',
          helpUrl: 'https://github.com/joe-broadhead/open-cowork',
        },
        permissions: { bash: 'allow', fileWrite: 'allow', task: 'allow', web: 'allow', webSearch: true },
        providers: {
          defaultProvider: null,
          defaultModel: null,
          available: [],
        },
        auth: { mode: 'none', enabled: false },
        agentStarterTemplates: [],
      })),
      runtimeInputs: vi.fn(async () => ({
        runtimeHome: '/tmp/open-cowork-runtime',
        configPath: '/tmp/open-cowork-runtime/opencode.json',
        providerCount: 0,
        mcpCount: 0,
        skillPathCount: 0,
        agentCount: 0,
      })),
      refreshProviderCatalog: vi.fn(async () => []),
      exportDiagnostics: vi.fn(async () => null),
      reset: vi.fn(async () => ({ removedPaths: [] })),
      checkUpdates: vi.fn(async () => ({
        status: 'ok',
        currentVersion: '0.0.0',
        latestVersion: '0.0.0',
        hasUpdate: false,
        releaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases/tag/v0.0.0',
      })),
    },
    auth: {
      status: vi.fn(async () => ({ authenticated: false, email: null })),
      login: vi.fn(async () => ({ authenticated: false, email: null })),
      logout: vi.fn(async () => ({ authenticated: false, email: null })),
    },
    // Admin control plane (#896). Defaults to a no-permission principal so the
    // Admin entry stays hidden and shells that render App never crash on
    // window.coworkApi.admin.access(). Admin tests override this group.
    admin: {
      access: vi.fn(async () => ({ role: 'member', customRoleKey: null, permissions: [], email: null, ssoVerified: false })),
      entitlements: vi.fn(async () => ({ provider: 'metadata', gatingEnabled: false, billingEnabled: false, planKey: null, planLabel: null, subscriptionStatus: null, seats: null, features: {}, limits: {} })),
      overview: vi.fn(async () => ({
        org: { orgId: 'o', tenantId: 't', name: 'Org', planKey: null, status: 'active' },
        signup: { mode: 'invite', allowSelfServiceSignup: false, allowedEmailDomains: [], invitesEnabled: true },
        profile: { name: 'default', label: null, description: null },
        features: {}, allowedAgents: null, allowedTools: null, allowedMcps: null,
        runtime: { configSource: 'app', machineRuntimeConfig: 'disabled', localStdioMcps: 'disabled', hostProjectDirectories: 'disabled' },
        gateway: { channelsEnabled: false, webhooksEnabled: false },
      })),
      members: { list: vi.fn(async () => []), invite: vi.fn(), update: vi.fn(), assignRole: vi.fn() },
      roles: { catalog: vi.fn(async () => []), list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      policy: { get: vi.fn(async () => ({ policy: null, view: {} })), set: vi.fn() },
      providers: { listKeys: vi.fn(async () => []), setKey: vi.fn(), deleteKey: vi.fn(), sso: vi.fn(async () => null) },
      usage: vi.fn(async () => ({ enabled: false, generatedAt: '', events: [], totals: [], quotas: [] })),
      audit: { query: vi.fn(async () => ({ events: [], nextCursor: null })), export: vi.fn() },
    },
    agents: {
      list: vi.fn(async () => []),
      runtime: vi.fn(async () => []),
    },
    workflows: {
      list: vi.fn(async () => ({ workflows: [], runs: [] })),
      get: vi.fn(async () => null),
      startDraft: vi.fn(async () => {
        throw new Error('workflows.startDraft not mocked')
      }),
      runNow: vi.fn(async () => null),
      pause: vi.fn(async () => null),
      resume: vi.fn(async () => null),
      archive: vi.fn(async () => null),
      regenerateWebhookSecret: vi.fn(async () => null),
    },
    capabilities: {
      tools: vi.fn(async () => []),
      tool: vi.fn(async () => null),
      skills: vi.fn(async () => []),
      skillBundle: vi.fn(async () => null),
    },
    coordination: {
      board: vi.fn(async () => ({ projects: [], tasks: [] })),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(async () => {
        throw new Error('coordination.createProject not mocked')
      }),
      updateProject: vi.fn(async () => null),
      planWithCleo: vi.fn(async () => null),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(async () => {
        throw new Error('coordination.createTask not mocked')
      }),
      updateTask: vi.fn(async () => null),
      moveTask: vi.fn(async () => null),
      assignTask: vi.fn(async () => null),
      linkTaskWork: vi.fn(async () => null),
      taskWorkTarget: vi.fn(async () => null),
    },
    launchpad: {
      feed: vi.fn(async () => ({
        generatedAt: '2026-01-01T00:00:00.000Z',
        inProgress: [],
        waitingOnYou: [],
        freshArtifacts: [],
        totals: {
          inProgress: 0,
          waitingOnYou: 0,
          freshArtifacts: 0,
        },
        truncated: {
          inProgress: false,
          waitingOnYou: false,
          freshArtifacts: false,
        },
      })),
    },
    channels: {
      providers: vi.fn(async () => []),
      agents: vi.fn(async () => []),
      createAgent: vi.fn(async () => {
        throw new Error('channels.createAgent not mocked')
      }),
      updateAgent: vi.fn(async () => null),
      bindings: vi.fn(async () => []),
      connectBinding: vi.fn(async () => {
        throw new Error('channels.connectBinding not mocked')
      }),
      updateBinding: vi.fn(async () => null),
      disconnectBinding: vi.fn(async () => null),
      people: vi.fn(async () => []),
      resolvePerson: vi.fn(async () => {
        throw new Error('channels.resolvePerson not mocked')
      }),
      deliveries: vi.fn(async () => []),
      retryDelivery: vi.fn(async () => null),
      deadLetterDelivery: vi.fn(async () => null),
      watches: vi.fn(async () => []),
      createWatch: vi.fn(async () => {
        throw new Error('channels.createWatch not mocked')
      }),
      updateWatch: vi.fn(async () => null),
      pauseWatch: vi.fn(async () => null),
      resumeWatch: vi.fn(async () => null),
      deleteWatch: vi.fn(async () => false),
    },
    artifact: {
      list: vi.fn(async () => []),
      index: vi.fn(async () => ({ artifacts: [], total: 0 })),
      cleanup: vi.fn(async (mode) => ({
        mode,
        removedWorkspaces: 0,
        removedBytes: 0,
      })),
      upload: vi.fn(async (request) => ({
        id: 'uploaded-artifact',
        toolId: 'upload',
        toolName: 'upload',
        filename: request.filename,
        filePath: `cloud-artifact://uploaded-artifact/${request.filename}`,
        order: 0,
        source: 'cloud',
        cloudArtifactId: 'uploaded-artifact',
        mime: request.contentType || undefined,
      })),
      open: vi.fn(async () => null),
      export: vi.fn(async () => null),
      readAttachment: vi.fn(async () => ({
        filename: 'chart.png',
        mime: 'image/png',
        url: 'data:image/png;base64,',
      })),
      reveal: vi.fn(async () => true),
      storageStats: vi.fn(async () => ({
        root: '/tmp/open-cowork-test',
        totalBytes: 0,
        workspaceCount: 0,
        referencedWorkspaceCount: 0,
        unreferencedWorkspaceCount: 0,
        staleWorkspaceCount: 0,
        staleThresholdDays: 14,
      })),
    },
    chart: {
      saveArtifact: vi.fn(async () => ({
        id: 'artifact-1',
        toolId: 'tool-call-1',
        toolName: 'chart',
        filename: 'chart.png',
        filePath: '/tmp/chart.png',
        order: 0,
        mime: 'image/png',
      })),
    },
    clipboard: {
      writeText: vi.fn(async () => true),
    },
    confirm: {
      requestDestructive: vi.fn(async () => ({
        token: 'confirmation-token',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })),
    },
    command: {
      list: vi.fn(async () => []),
      run: vi.fn(async () => true),
    },
    mcp: {
      auth: vi.fn(async () => true),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      preflight: vi.fn(async (name: string) => ({
        ok: true,
        status: 'ok',
        mcpName: name,
        message: `${name} connected.`,
        methodCount: 1,
      })),
    },
    custom: {
      addSkill: vi.fn(async () => true),
      addMcp: vi.fn(async () => true),
      importSkillDirectory: vi.fn(async () => ({
        name: 'imported-skill',
        path: '/tmp/imported-skill',
        directory: null,
        scope: 'machine',
        toolIds: [],
      })),
      listMcps: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      removeMcp: vi.fn(async () => true),
      removeSkill: vi.fn(async () => true),
      selectSkillDirectoryImport: vi.fn(async () => null),
      testMcp: vi.fn(async () => ({ ok: true, methods: [], error: null })),
    },
    dialog: {
      selectDirectory: vi.fn(async () => null),
      saveText: vi.fn(async () => null),
    },
    permission: {
      respond: vi.fn(async () => undefined),
    },
    provider: {
      authMethods: vi.fn(async () => ({})),
      authorize: vi.fn(async () => null),
      callback: vi.fn(async () => false),
      list: vi.fn(async () => []),
      logout: vi.fn(async () => true),
      testConnection: vi.fn(async (providerId: string, modelId: string) => ({ ok: true, providerId, modelId })),
    },
    runtime: {
      awaitInitialization: vi.fn(async () => ({
        phase: 'ready',
        message: 'Runtime is ready.',
        ready: true,
        error: null,
        updatedAt: new Date().toISOString(),
      })),
      status: vi.fn(async () => ({
        ready: true,
        running: true,
        sessions: 0,
        uptimeMs: 0,
      })),
      restart: vi.fn(async () => ({
        ready: true,
        running: true,
        sessions: 0,
        uptimeMs: 0,
      })),
    },
    projects: {
      list: vi.fn(async () => []),
      switchByIndex: vi.fn(async () => null),
    },
    diagnostics: {
      perf: vi.fn(async () => ({
        measures: [],
        generatedAt: new Date().toISOString(),
      })),
      reportRendererError: vi.fn(),
    },
    settings: {
      get: vi.fn(async () => createDefaultSettings()),
      getProviderCredentials: vi.fn(async (providerId: string) => createDefaultSettings().providerCredentials[providerId] || {}),
      getIntegrationCredentials: vi.fn(async (integrationId: string) => createDefaultSettings().integrationCredentials[integrationId] || {}),
      set: vi.fn(async (updates) => createDefaultSettings(updates)),
    },
    session: {
      create: vi.fn(async () => ({
        id: 'session-1',
        title: 'Session 1',
        directory: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      activate: vi.fn(async () => ({
        messages: [],
        toolCalls: [],
        taskRuns: [],
        compactions: [],
        pendingApprovals: [],
        pendingQuestions: [],
        errors: [],
        todos: [],
        executionPlan: [],
        sessionCost: 0,
        sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        lastInputTokens: 0,
        contextState: 'idle',
        compactionCount: 0,
        lastCompactedAt: null,
        activeAgent: null,
        lastItemWasTool: false,
        revision: 0,
        lastEventAt: 0,
        isGenerating: false,
        isAwaitingPermission: false,
        isAwaitingQuestion: false,
      })),
      prompt: vi.fn(async () => undefined),
      setComposerPreferences: vi.fn(async () => null),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      importInventory: vi.fn(async () => ({
        source: { kind: 'local-session', fingerprint: 'sha256:test', title: 'Session 1' },
        title: 'Session 1',
        counts: { messages: 0, artifacts: 0, attachments: 0, projectSource: 0, excluded: 0 },
        defaults: { includeMessages: true, includeArtifacts: false, includeAttachments: false, includeProjectSource: false },
        warnings: [],
        excluded: [],
      })),
      copyToCloud: vi.fn(async () => ({
        workspaceId: 'cloud:test',
        sessionId: 'cloud-session-1',
        title: 'Session 1',
        importedAt: '2026-01-01T00:00:00.000Z',
        itemCounts: { messages: 0, artifacts: 0, attachments: 0, projectSource: 0, excluded: 0 },
      })),
      abort: vi.fn(async () => undefined),
      abortTask: vi.fn(async () => undefined),
      rename: vi.fn(async () => true),
      delete: vi.fn(async () => true),
      export: vi.fn(async () => null),
      fork: vi.fn(async () => null),
      share: vi.fn(async () => null),
      unshare: vi.fn(async () => true),
      summarize: vi.fn(async () => ({ ok: true })),
      revert: vi.fn(async () => true),
      unrevert: vi.fn(async () => true),
      children: vi.fn(async () => []),
      diff: vi.fn(async () => []),
      fileSnippet: vi.fn(async () => []),
      todo: vi.fn(async () => []),
    },
    projectSource: {
      validate: vi.fn(async () => ({ allowed: true, reason: null })),
      snapshotInventory: vi.fn(async (input: { directory: string }) => ({
        rootDirectory: input.directory,
        files: [{ path: 'README.md', byteCount: 12 }],
        excluded: [],
        warnings: [],
        fileCount: 1,
        byteCount: 12,
        maxFiles: 2000,
        maxBytes: 25 * 1024 * 1024,
      })),
      uploadSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-1',
        objectKey: 'project-snapshots/tenant/snapshot/snapshot.json',
        fileCount: 1,
        byteCount: 12,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectSource: {
          kind: 'snapshot',
          snapshotId: 'snapshot-1',
          objectKey: 'project-snapshots/tenant/snapshot/snapshot.json',
          fileCount: 1,
          byteCount: 12,
        },
      })),
    },
    threads: {
      search: vi.fn(async () => ({ threads: [], nextCursor: null, totalEstimate: 0 })),
      facets: vi.fn(async () => ({
        projects: [],
        providers: [],
        models: [],
        agents: [],
        tools: [],
        mcps: [],
        statuses: [],
        tags: [],
      })),
      tags: {
        list: vi.fn(async () => []),
        create: vi.fn(async (input: { name: string; color?: string }) => ({
          id: 'tag-1',
          name: input.name,
          color: input.color || 'var(--color-text-muted)',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
        update: vi.fn(async (tagId: string, input: { name: string; color?: string }) => ({
          id: tagId,
          name: input.name,
          color: input.color || 'var(--color-text-muted)',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })),
        delete: vi.fn(async () => true),
        apply: vi.fn(async () => true),
        remove: vi.fn(async () => true),
      },
      smartFilters: {
        list: vi.fn(async () => []),
        create: vi.fn(async (input: { name: string; query: Record<string, unknown> }) => ({
          id: 'filter-1',
          name: input.name,
          query: input.query,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
        update: vi.fn(async (filterId: string, input: { name: string; query: Record<string, unknown> }) => ({
          id: filterId,
          name: input.name,
          query: input.query,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })),
        delete: vi.fn(async () => true),
      },
      suggestions: {
        accept: vi.fn(async () => true),
        edit: vi.fn(async () => true),
        dismiss: vi.fn(async () => true),
      },
      reindex: vi.fn(async () => true),
    },
    updates: {
      installCapability: vi.fn(async () => ({
        supported: false,
        reason: 'dev',
        currentVersion: '0.0.0',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
        releaseSource: {
          kind: 'github-releases',
          label: 'GitHub Releases',
          channel: 'latest',
          requiresAuth: false,
          authKind: 'none',
        },
      })),
      checkInstallable: vi.fn(async () => ({
        status: 'unsupported',
        reason: 'dev',
        currentVersion: '0.0.0',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })),
      download: vi.fn(async () => ({
        status: 'unsupported',
        reason: 'dev',
        currentVersion: '0.0.0',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })),
      quitAndInstall: vi.fn(async () => ({
        status: 'unsupported',
        reason: 'dev',
        currentVersion: '0.0.0',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })),
      onInstallEvent: vi.fn(() => () => undefined),
    },
    on: {
      sessionPatch: vi.fn(() => () => undefined),
      notification: vi.fn(() => () => undefined),
      sessionView: vi.fn(() => () => undefined),
      permissionRequest: vi.fn(() => () => undefined),
      mcpStatus: vi.fn(() => () => undefined),
      authExpired: vi.fn(() => () => undefined),
      authLogout: vi.fn(() => () => undefined),
      menuAction: vi.fn(() => () => undefined),
      menuNavigate: vi.fn(() => () => undefined),
      runtimeReady: vi.fn(() => () => undefined),
      runtimeLoadingStatus: vi.fn(() => () => undefined),
      sessionUpdated: vi.fn(() => () => undefined),
      sessionDeleted: vi.fn(() => () => undefined),
      workspaceSessionsUpdated: vi.fn(() => () => undefined),
      workflowUpdated: vi.fn(() => () => undefined),
      coordinationUpdated: vi.fn(() => () => undefined),
    },
  }

  for (const [key, value] of Object.entries(overrides) as Array<[keyof CoworkAPI, Record<string, unknown>]>) {
    api[key] = {
      ...(api[key] || {}),
      ...value,
    } as TestCoworkApi[typeof key]
  }

  Object.defineProperty(window, 'coworkApi', {
    configurable: true,
    writable: true,
    value: api as CoworkAPI,
  })

  return window.coworkApi
}

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds = []
  disconnect() {}
  observe() {}
  takeRecords() {
    return []
  }
  unobserve() {}
}

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
})

Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  writable: true,
  value: TestIntersectionObserver,
})

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  writable: true,
  value: {
    writeText: vi.fn(async () => undefined),
  },
})

const testLocalStorage = new TestStorage()
const testSessionStorage = new TestStorage()

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  writable: true,
  value: testLocalStorage,
})

Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: testSessionStorage,
})

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: testLocalStorage,
})

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: testSessionStorage,
})

const svgGraphicsPrototype: object = typeof SVGGraphicsElement !== 'undefined'
  ? SVGGraphicsElement.prototype
  : SVGElement.prototype

if (!('getBBox' in svgGraphicsPrototype)) {
  Object.defineProperty(svgGraphicsPrototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 120, height: 80 }),
  })
}

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
}

beforeEach(() => {
  installCoworkApi()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

export { installCoworkApi as installRendererTestCoworkApi }
