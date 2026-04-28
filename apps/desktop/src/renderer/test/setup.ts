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
    effectiveProviderId: null,
    effectiveModel: null,
    ...overrides,
  }
}

function installCoworkApi(overrides: TestCoworkApi = {}) {
  const api: TestCoworkApi = {
    app: {
      builtinAgents: vi.fn(async () => []),
      config: vi.fn(async () => ({
        appId: 'com.opencowork.desktop',
        name: 'Open Cowork',
        helpUrl: 'https://github.com/joe-broadhead/open-cowork',
        defaultModel: null,
        providers: [],
        auth: { mode: 'none' },
      })),
    },
    agents: {
      list: vi.fn(async () => []),
      runtime: vi.fn(async () => []),
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
    clipboard: {
      writeText: vi.fn(async () => true),
    },
    command: {
      list: vi.fn(async () => []),
      run: vi.fn(async () => true),
    },
    dialog: {
      selectDirectory: vi.fn(async () => null),
    },
    permission: {
      respond: vi.fn(async () => undefined),
    },
    provider: {
      authMethods: vi.fn(async () => ({})),
      authorize: vi.fn(async () => null),
      callback: vi.fn(async () => false),
      list: vi.fn(async () => []),
    },
    runtime: {
      restart: vi.fn(async () => ({
        ready: true,
        running: true,
        sessions: 0,
        uptimeMs: 0,
      })),
    },
    settings: {
      get: vi.fn(async () => createDefaultSettings()),
      getWithCredentials: vi.fn(async () => createDefaultSettings()),
      set: vi.fn(async (updates) => createDefaultSettings(updates)),
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
