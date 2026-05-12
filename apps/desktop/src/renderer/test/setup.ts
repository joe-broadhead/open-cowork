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
    enableBash: false,
    enableFileWrite: false,
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: null,
    automationQuietHoursEnd: null,
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'scoped_execution',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    dreamConsolidationScheduleEnabled: false,
    dreamConsolidationIntervalHours: 168,
    effectiveProviderId: null,
    effectiveModel: null,
    ...overrides,
  }
}

function installCoworkApi(overrides: TestCoworkApi = {}) {
  const api: TestCoworkApi = {
    app: {
      builtinAgents: vi.fn(async () => []),
      metadata: vi.fn(async () => ({ version: '0.0.0', preview: true })),
      config: vi.fn(async () => ({
        branding: {
          appId: 'com.opencowork.desktop',
          name: 'Open Cowork',
          dataDirName: 'Open Cowork',
          helpUrl: 'https://github.com/joe-broadhead/open-cowork',
        },
        permissions: { bash: 'allow', fileWrite: 'allow' },
        providers: {
          defaultProvider: null,
          defaultModel: null,
          available: [],
        },
        auth: { mode: 'none', enabled: false },
        agentStarterTemplates: [],
      })),
      dashboardSummary: vi.fn(async () => ({
        automations: { active: 0, paused: 0, failed: 0, needsUser: 0, deliveredToday: 0 },
        costs: { todayUsd: 0, weekUsd: 0, monthUsd: 0 },
        usage: { sessionsToday: 0, promptsToday: 0, approvalsToday: 0 },
        runtime: { ready: true, uptimeMs: 0 },
        generatedAt: new Date().toISOString(),
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
    agents: {
      list: vi.fn(async () => []),
      runtime: vi.fn(async () => []),
    },
    crews: {
      list: vi.fn(async () => ({ crews: [] })),
      get: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw new Error('crews.create not mocked')
      }),
      update: vi.fn(async () => {
        throw new Error('crews.update not mocked')
      }),
      run: vi.fn(async () => {
        throw new Error('crews.run not mocked')
      }),
      runDetail: vi.fn(async () => null),
      evaluate: vi.fn(async () => {
        throw new Error('crews.evaluate not mocked')
      }),
      exportTrace: vi.fn(async () => ''),
    },
    sops: {
      list: vi.fn(async () => ({ sops: [] })),
      get: vi.fn(async () => null),
      saveFromAutomationRun: vi.fn(async () => {
        throw new Error('sops.saveFromAutomationRun not mocked')
      }),
      update: vi.fn(async () => {
        throw new Error('sops.update not mocked')
      }),
      runNow: vi.fn(async () => {
        throw new Error('sops.runNow not mocked')
      }),
      runForTrigger: vi.fn(async () => {
        throw new Error('sops.runForTrigger not mocked')
      }),
      runDetail: vi.fn(async () => null),
    },
    artifact: {
      cleanup: vi.fn(async (mode) => ({
        mode,
        removedWorkspaces: 0,
        removedBytes: 0,
      })),
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
    channels: {
      list: vi.fn(async () => ({ channels: [], inboundItems: [], deliveries: [] })),
      definitions: vi.fn(async () => []),
      inboundItems: vi.fn(async () => []),
      deliveries: vi.fn(async () => []),
      localWebhookStatus: vi.fn(async () => ({
        schemaVersion: 1,
        enabled: false,
        listening: false,
        host: '127.0.0.1',
        port: null,
        url: null,
        pairedChannels: 0,
        lastError: null,
      })),
      localWebhookPairings: vi.fn(async () => []),
      createLocalWebhook: vi.fn(async () => {
        throw new Error('channels.createLocalWebhook not mocked')
      }),
      rotateLocalWebhookToken: vi.fn(async () => null),
      approveInboundItem: vi.fn(async () => null),
      dismissInboundItem: vi.fn(async () => null),
      createDeliveryDraft: vi.fn(async () => null),
      sendDelivery: vi.fn(async () => null),
      cancelDelivery: vi.fn(async () => null),
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
    },
    runtime: {
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
    diagnostics: {
      perf: vi.fn(async () => ({
        measures: [],
        generatedAt: new Date().toISOString(),
      })),
      reportRendererError: vi.fn(),
    },
    operations: {
      workspaceProfiles: vi.fn(async () => []),
      queueItems: vi.fn(async () => []),
      queueAlerts: vi.fn(async () => []),
      capabilityRisks: vi.fn(async () => []),
      governanceRegistry: vi.fn(async () => ({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        organization: {
          schemaVersion: 1,
          id: 'local-organization',
          tenantId: 'local-tenant',
          displayName: 'Local Open Cowork',
          mode: 'local',
        },
        principals: [],
        groups: [],
        subjects: [],
        dependencyIndex: [],
      })),
      governanceAuditEvents: vi.fn(async () => []),
      exportGovernanceAudit: vi.fn(async () => ({
        schemaVersion: 2,
        format: 'ndjson',
        contentType: 'application/x-ndjson',
        filename: 'open-cowork-governance-audit.ndjson',
        exportedAt: new Date().toISOString(),
        eventCount: 0,
        body: '',
      })),
      pauseAgent: vi.fn(async () => true),
      retireAgent: vi.fn(async () => true),
      quarantineMemory: vi.fn(async () => null),
      revokeTool: vi.fn(async (request: { toolId: string, reason?: string | null }) => ({
        schemaVersion: 1,
        toolId: request.toolId,
        label: request.toolId,
        patterns: [request.toolId],
        source: 'native',
        scope: 'system',
        directory: null,
        revokedAt: new Date(0).toISOString(),
        revokedBy: 'local-user',
        reason: request.reason || null,
      })),
    },
    improvements: {
      summary: vi.fn(async () => ({
        memory: {
          proposed: 0,
          approved: 0,
          rejected: 0,
          archived: 0,
          quarantined: 0,
          approvedRestrictedCount: 0,
          injection: {
            consideredCount: 0,
            returnedCount: 0,
            limit: 12,
            excludedRestrictedCount: 0,
            scopeKeys: ['machine:*'],
          },
        },
        proposals: {
          proposed: 0,
          approved: 0,
          rejected: 0,
          archived: 0,
        },
        dreamRuns: {
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          archived: 0,
        },
        policy: {
          proposalsEnabled: true,
          disabledAgentCount: 0,
          disabledProjectCount: 0,
          disabledCrewCount: 0,
        },
      })),
      inbox: vi.fn(async () => ({
        memory: [],
        proposals: [],
        dreamRuns: [],
      })),
      approveMemory: vi.fn(async () => null),
      rejectMemory: vi.fn(async () => null),
      archiveMemory: vi.fn(async () => null),
      updateProposal: vi.fn(async () => null),
      approveProposal: vi.fn(async () => null),
      rejectProposal: vi.fn(async () => null),
      archiveProposal: vi.fn(async () => null),
      startDreamRun: vi.fn(async () => null),
      cancelDreamRun: vi.fn(async () => null),
      archiveDreamRun: vi.fn(async () => null),
    },
    settings: {
      get: vi.fn(async () => createDefaultSettings()),
      getProviderCredentials: vi.fn(async (providerId: string) => createDefaultSettings().providerCredentials[providerId] || {}),
      getIntegrationCredentials: vi.fn(async (integrationId: string) => createDefaultSettings().integrationCredentials[integrationId] || {}),
      set: vi.fn(async (updates) => createDefaultSettings(updates)),
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
          color: input.color || '#64748b',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
        update: vi.fn(async (tagId: string, input: { name: string; color?: string }) => ({
          id: tagId,
          name: input.name,
          color: input.color || '#64748b',
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
      dashboardSummaryUpdated: vi.fn(() => () => undefined),
      sessionUpdated: vi.fn(() => () => undefined),
      sessionDeleted: vi.fn(() => () => undefined),
      automationUpdated: vi.fn(() => () => undefined),
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
