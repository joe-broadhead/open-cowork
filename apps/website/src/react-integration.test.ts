import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { act, createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppApiProvider } from '@open-cowork/ui/app-api'
import type { AppAPI } from '@open-cowork/shared'
import { CLOUD_WEB_ADMIN_SURFACE_MATRIX } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import {
  allowedAgentsFromWorkspace,
  asRecord,
  chatFeatureEnabled,
  mergeSessions,
  pageFromResponse,
  sessionIdFromCreateResult,
  sessionMessageCount,
  sessionTitle,
} from './react-workbench-controller.ts'
import { useCloudWorkbenchForms } from './react-workbench-forms.ts'
import { useCloudComposer } from './react-workbench-hooks.ts'
import { assertCloudProjectSourceAllowed, cloudProjectSourceFromForm } from './react-project-source.ts'
import { CLOUD_WEB_WORKBENCH_PARITY_MATRIX } from './workbench-parity.ts'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options?: Record<string, unknown>) => {
    window: Window & typeof globalThis & { close(): void }
  }
}

function bootstrap(overrides: Partial<CloudWebClientBootstrap> = {}): CloudWebClientBootstrap {
  return {
    role: 'admin',
    profileName: 'default',
    features: { chat: true, workflows: true, agents: true, customSkills: true, customMcps: true },
    publicBranding: { productName: 'Open Cowork Cloud' },
    routes: CLOUD_WEB_ROUTES,
    defaultRoute: DEFAULT_CLOUD_WEB_ROUTE,
    api: CLOUD_WEB_CLIENT_ENDPOINTS,
    routeMatrix: CLOUD_WEB_ROUTE_API_MATRIX,
    adminSurfaces: CLOUD_WEB_ADMIN_SURFACE_MATRIX,
    workbenchParity: CLOUD_WEB_WORKBENCH_PARITY_MATRIX,
    sessionEventTypes: ['assistant.message'],
    ...overrides,
  }
}

async function withDom<T>(html: string, run: (window: Window & typeof globalThis) => Promise<T> | T): Promise<T> {
  const dom = new JSDOM(html, { url: 'https://cloud.example.test/#org', pretendToBeVisual: true })
  const window = dom.window as Window & typeof globalThis
  window.requestAnimationFrame ||= ((callback: FrameRequestCallback) => Number(setTimeout(callback, 0)))
  window.cancelAnimationFrame ||= ((id: number) => clearTimeout(id))

  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'SubmitEvent',
    'Event',
    'MouseEvent',
    'FormData',
    'File',
    'Blob',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (window as unknown as Record<string, unknown>)[key],
    })
  }
  previous.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'))
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  })

  try {
    return await run(window)
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalRecord[key]
    }
    dom.window.close()
  }
}

async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await delay(10)
    }
  }
  throw lastError
}

void test('React workbench controller helpers normalize cloud thread state', () => {
  const created = {
    session: { sessionId: 'session-1' },
    view: {
      session: { sessionId: 'session-1', title: 'Session fallback' },
      projection: { view: { title: 'Projected title', messages: [{}, {}] } },
    },
  }

  assert.deepEqual(asRecord({ ok: true }), { ok: true })
  assert.deepEqual(asRecord(['not-record']), {})
  assert.equal(sessionIdFromCreateResult(created), 'session-1')
  assert.equal(sessionTitle(created.view as never, 'Fallback'), 'Projected title')
  assert.equal(sessionMessageCount(created.view as never), 2)
  assert.deepEqual(allowedAgentsFromWorkspace({ policy: { allowedAgents: ['build', { name: 'review' }, {}] } }), ['build', 'review'])
  assert.deepEqual(pageFromResponse({ sessions: [{ sessionId: 's1' }, { bad: true }], nextCursor: 'cursor-2', totalEstimate: 12 }), {
    sessions: [{ sessionId: 's1' }],
    nextCursor: 'cursor-2',
    totalEstimate: 12,
  })
  assert.deepEqual(mergeSessions([{ sessionId: 's1', title: 'Old' } as never], [{ sessionId: 's1', status: 'idle' } as never, { sessionId: 's2' } as never], true), [
    { sessionId: 's1', title: 'Old', status: 'idle' },
    { sessionId: 's2' },
  ])
  assert.equal(chatFeatureEnabled(bootstrap()), true)
  assert.equal(chatFeatureEnabled(bootstrap({ features: { chat: false } })), false)
})

void test('React project-source helpers build git and upload snapshots with policy validation', async () => {
  await withDom(`
    <form id="session-form">
      <input name="repositoryUrl" value="https://github.com/acme/app.git" />
      <input name="ref" value="main" />
      <input name="subdirectory" value="packages/app" />
      <input name="credentialRef" value="git-token" />
      <input name="snapshotTitle" value="Browser upload" />
      <input name="snapshotFiles" type="file" />
    </form>
  `, async (window) => {
    const form = window.document.getElementById('session-form') as HTMLFormElement
    const apiCalls: unknown[] = []
    const api = {
      projectSources: {
        uploadSnapshot: async (input: unknown) => {
          apiCalls.push(input)
          return { projectSource: { kind: 'snapshot', snapshotId: 'snapshot-1' } }
        },
        validate: async (input: unknown) => {
          apiCalls.push(input)
          return { allowed: true }
        },
      },
    } as unknown as AppAPI

    const gitFormData = new window.FormData()
    gitFormData.set('repositoryUrl', 'https://github.com/acme/app.git')
    gitFormData.set('ref', 'main')
    gitFormData.set('subdirectory', 'packages/app')
    gitFormData.set('credentialRef', 'git-token')
    const gitSource = await cloudProjectSourceFromForm(api, form, gitFormData)
    assert.deepEqual(gitSource, {
      kind: 'git',
      repositoryUrl: 'https://github.com/acme/app.git',
      ref: 'main',
      subdirectory: 'packages/app',
      credentialRef: 'git-token',
    })
    await assertCloudProjectSourceAllowed(api, gitSource)

    ;(form.querySelector('input[name="repositoryUrl"]') as HTMLInputElement).value = ''
    const file = {
      name: 'README.md',
      size: 5,
      webkitRelativePath: 'docs/README.md',
      arrayBuffer: async () => Uint8Array.from([104, 101, 108, 108, 111]).buffer,
    }
    Object.defineProperty(form.querySelector('input[name="snapshotFiles"]'), 'files', {
      configurable: true,
      value: [file],
    })
    const uploadFormData = new window.FormData()
    uploadFormData.set('snapshotTitle', 'Browser upload')
    const uploadedSource = await cloudProjectSourceFromForm(api, form, uploadFormData)
    assert.deepEqual(uploadedSource, { kind: 'snapshot', snapshotId: 'snapshot-1' })
    assert.deepEqual(asRecord(apiCalls[0]).projectSource, gitSource)
    const upload = asRecord(apiCalls[1])
    assert.equal(upload.title, 'Browser upload')
    assert.equal(upload.fileCount, 1)
    assert.equal(upload.byteCount, 5)
    assert.equal(asRecord((upload.files as Array<Record<string, unknown>>)[0]).path, 'docs/README.md')
    assert.equal(asRecord((upload.files as Array<Record<string, unknown>>)[0]).dataBase64, btoa('hello'))
  })
})

void test('React workbench form hook creates a chat and prompts the selected agent', async () => {
  await withDom(`
    <div id="status"></div>
    <div id="sidebar-status"></div>
    <form id="prompt-form">
      <textarea name="text">Build the app</textarea>
      <select name="agent"><option value="build" selected>build</option></select>
    </form>
    <div id="react-root"></div>
  `, async (window) => {
    const calls: Array<{ type: string, body?: unknown, sessionId?: string }> = []
    const view = { session: { sessionId: 'session-1', title: 'Started' }, projection: { view: { messages: [] } } }
    const api = {
      sessions: {
        create: async (body: unknown) => {
          calls.push({ type: 'create', body })
          return { session: { sessionId: 'session-1' }, view }
        },
        prompt: async (sessionId: string, body: unknown) => {
          calls.push({ type: 'prompt', sessionId, body })
          return { view }
        },
      },
    } as unknown as AppAPI
    const promptForm = window.document.getElementById('prompt-form') as HTMLFormElement

    function Harness() {
      const [composerText, setComposerText] = useState('Build the app')
      const [isSending, setIsSending] = useState(false)
      const [, setError] = useState<string | null>(null)
      const [, setViews] = useState<Record<string, unknown>>({})
      const [, setSelectedSessionId] = useState<string | null>(null)
      useCloudWorkbenchForms({
        api,
        bootstrap: bootstrap(),
        workspace: { profileName: 'default' },
        composerTarget: promptForm,
        sessionFormTarget: null,
        composerText,
        composerAgent: 'build',
        allowedAgents: ['build', 'data-analyst'],
        isSending,
        selectedSessionId: null,
        setComposerText,
        setIsSending,
        setError,
        setViews: setViews as never,
        setSelectedSessionId,
        loadSessions: async () => {
          calls.push({ type: 'loadSessions' })
        },
        loadView: async (sessionId: string) => {
          calls.push({ type: 'loadView', sessionId })
          return view as never
        },
      })
      return null
    }

    const root = createRoot(window.document.getElementById('react-root') as HTMLElement)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await waitFor(() => assert.equal(promptForm.dataset.reactOwned, 'chat'))
    await act(async () => {
      promptForm.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => {
        assert.deepEqual(calls.map((call) => call.type), ['create', 'prompt', 'loadSessions', 'loadView'])
        assert.equal(window.document.getElementById('status')?.textContent, 'Ready')
      })
    })

    assert.deepEqual(calls.map((call) => call.type), ['create', 'prompt', 'loadSessions', 'loadView'])
    assert.deepEqual(calls[0]?.body, { profileName: 'default', projectSource: null })
    assert.deepEqual(calls[1], { type: 'prompt', sessionId: 'session-1', body: { text: 'Build the app', agent: 'build' } })
    assert.equal(window.location.hash, '#chat')
    assert.equal(window.document.getElementById('status')?.textContent, 'Ready')
    await act(async () => {
      root.unmount()
      await delay(0)
    })
  })
})

void test('React workbench form hook maps a direct coworker mention to the cloud prompt assignment', async () => {
  await withDom(`
    <div id="status"></div>
    <div id="sidebar-status"></div>
    <form id="prompt-form">
      <textarea name="text">@data-analyst Review the run.</textarea>
      <select name="agent"><option value="build" selected>build</option></select>
    </form>
    <div id="react-root"></div>
  `, async (window) => {
    const calls: Array<{ type: string, body?: unknown, sessionId?: string }> = []
    const view = { session: { sessionId: 'session-mention', title: 'Started' }, projection: { view: { messages: [] } } }
    const api = {
      sessions: {
        create: async (body: unknown) => {
          calls.push({ type: 'create', body })
          return { session: { sessionId: 'session-mention' }, view }
        },
        prompt: async (sessionId: string, body: unknown) => {
          calls.push({ type: 'prompt', sessionId, body })
          return { view }
        },
      },
    } as unknown as AppAPI
    const promptForm = window.document.getElementById('prompt-form') as HTMLFormElement

    function Harness() {
      const [composerText, setComposerText] = useState('@data-analyst Review the run.')
      const [isSending, setIsSending] = useState(false)
      const [, setError] = useState<string | null>(null)
      const [, setViews] = useState<Record<string, unknown>>({})
      const [, setSelectedSessionId] = useState<string | null>(null)
      useCloudWorkbenchForms({
        api,
        bootstrap: bootstrap(),
        workspace: { profileName: 'default' },
        composerTarget: promptForm,
        sessionFormTarget: null,
        composerText,
        composerAgent: 'build',
        allowedAgents: ['build', 'data-analyst'],
        isSending,
        selectedSessionId: null,
        setComposerText,
        setIsSending,
        setError,
        setViews: setViews as never,
        setSelectedSessionId,
        loadSessions: async () => {
          calls.push({ type: 'loadSessions' })
        },
        loadView: async (sessionId: string) => {
          calls.push({ type: 'loadView', sessionId })
          return view as never
        },
      })
      return null
    }

    const root = createRoot(window.document.getElementById('react-root') as HTMLElement)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await waitFor(() => assert.equal(promptForm.dataset.reactOwned, 'chat'))
    await act(async () => {
      promptForm.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => assert.deepEqual(calls.map((call) => call.type), ['create', 'prompt', 'loadSessions', 'loadView']))
    })

    assert.deepEqual(calls[1], {
      type: 'prompt',
      sessionId: 'session-mention',
      body: { text: 'Review the run.', agent: 'data-analyst' },
    })
    await act(async () => {
      root.unmount()
      await delay(0)
    })
  })
})

void test('React workbench form hook preserves a selected capability coworker outside the policy shortlist', async () => {
  await withDom(`
    <div id="status"></div>
    <div id="sidebar-status"></div>
    <form id="prompt-form">
      <textarea name="text">Review the capability output.</textarea>
      <select name="agent"><option value="" selected>Default coworker</option></select>
    </form>
    <div id="react-root"></div>
  `, async (window) => {
    const calls: Array<{ type: string, body?: unknown, sessionId?: string }> = []
    const view = { session: { sessionId: 'session-capability', title: 'Started' }, projection: { view: { messages: [] } } }
    const api = {
      sessions: {
        create: async (body: unknown) => {
          calls.push({ type: 'create', body })
          return { session: { sessionId: 'session-capability' }, view }
        },
        prompt: async (sessionId: string, body: unknown) => {
          calls.push({ type: 'prompt', sessionId, body })
          return { view }
        },
      },
    } as unknown as AppAPI
    const promptForm = window.document.getElementById('prompt-form') as HTMLFormElement

    function Harness() {
      const [composerText, setComposerText] = useState('Review the capability output.')
      const [isSending, setIsSending] = useState(false)
      const [, setError] = useState<string | null>(null)
      const [, setViews] = useState<Record<string, unknown>>({})
      const [, setSelectedSessionId] = useState<string | null>(null)
      useCloudWorkbenchForms({
        api,
        bootstrap: bootstrap(),
        workspace: { profileName: 'default' },
        composerTarget: promptForm,
        sessionFormTarget: null,
        composerText,
        composerAgent: 'capability-coworker',
        allowedAgents: ['build'],
        isSending,
        selectedSessionId: null,
        setComposerText,
        setIsSending,
        setError,
        setViews: setViews as never,
        setSelectedSessionId,
        loadSessions: async () => {
          calls.push({ type: 'loadSessions' })
        },
        loadView: async (sessionId: string) => {
          calls.push({ type: 'loadView', sessionId })
          return view as never
        },
      })
      return null
    }

    const root = createRoot(window.document.getElementById('react-root') as HTMLElement)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await waitFor(() => assert.equal(promptForm.dataset.reactOwned, 'chat'))
    await act(async () => {
      promptForm.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => assert.deepEqual(calls.map((call) => call.type), ['create', 'prompt', 'loadSessions', 'loadView']))
    })

    assert.deepEqual(calls[1], {
      type: 'prompt',
      sessionId: 'session-capability',
      body: { text: 'Review the capability output.', agent: 'capability-coworker' },
    })
    await act(async () => {
      root.unmount()
      await delay(0)
    })
  })
})

void test('React cloud composer hook creates a session before prompting when no thread is selected', async () => {
  await withDom('<div id="react-root"></div>', async (window) => {
    const calls: Array<{ type: string, body?: unknown, sessionId?: string }> = []
    const api = {
      sessions: {
        create: async (body: unknown) => {
          calls.push({ type: 'create', body })
          return { session: { sessionId: 'session-2' } }
        },
        prompt: async (sessionId: string, body: unknown) => {
          calls.push({ type: 'prompt', sessionId, body })
          return { ok: true }
        },
      },
    } as unknown as AppAPI
    const root = createRoot(window.document.getElementById('react-root') as HTMLElement)
    let sendPromise: Promise<string | null> | null = null
    function Harness() {
      const composer = useCloudComposer()
      useEffect(() => {
        sendPromise ||= composer.send({ text: ' Plan ', agent: 'review', create: { profileName: 'default' } })
      }, [composer.send])
      return null
    }
    await act(async () => {
      root.render(createElement(AppApiProvider, { api, children: createElement(Harness) }))
    })
    const result = await act(async () => sendPromise)

    assert.equal(result, 'session-2')
    assert.deepEqual(calls, [
      { type: 'create', body: { profileName: 'default' } },
      { type: 'prompt', sessionId: 'session-2', body: { text: 'Plan', agent: 'review' } },
    ])
    await act(async () => {
      root.unmount()
      await delay(0)
    })
  })
})

void test('React workbench form hook aborts the in-flight turn for the selected chat (Stop/Esc)', async () => {
  await withDom('<form id="prompt-form"></form><div id="react-root"></div>', async (window) => {
    const calls: Array<{ type: string, sessionId?: string }> = []
    const api = {
      sessions: {
        abort: async (sessionId: string) => { calls.push({ type: 'abort', sessionId }); return { ok: true } },
        view: async (sessionId: string) => { calls.push({ type: 'view', sessionId }); return {} },
      },
    } as unknown as AppAPI
    const promptForm = window.document.getElementById('prompt-form') as HTMLFormElement
    const stops: Array<() => void> = []

    function Harness({ selectedSessionId }: { selectedSessionId: string | null }) {
      const [, setError] = useState<string | null>(null)
      const { stopGenerating } = useCloudWorkbenchForms({
        api,
        bootstrap: bootstrap(),
        workspace: { profileName: 'default' },
        composerTarget: promptForm,
        sessionFormTarget: null,
        composerText: '',
        composerAgent: '',
        allowedAgents: ['build'],
        isSending: true,
        selectedSessionId,
        setComposerText: () => {},
        setIsSending: () => {},
        setError,
        setViews: (() => {}) as never,
        setSelectedSessionId: () => {},
        loadSessions: async () => { calls.push({ type: 'loadSessions' }) },
        loadView: async (sessionId: string) => { calls.push({ type: 'loadView', sessionId }); return {} as never },
      })
      stops.push(stopGenerating)
      return null
    }

    const root = createRoot(window.document.getElementById('react-root') as HTMLElement)
    // No selected chat: Stop is a safe no-op (never calls abort).
    await act(async () => { root.render(createElement(Harness, { selectedSessionId: null })) })
    await act(async () => { stops.at(-1)?.() })
    assert.equal(calls.length, 0)

    // Selected chat: Stop aborts that session, then refreshes the view + list.
    await act(async () => { root.render(createElement(Harness, { selectedSessionId: 'session-7' })) })
    await act(async () => { await stops.at(-1)?.(); await delay(0) })
    await waitFor(() => assert.deepEqual(calls.map((call) => call.type), ['abort', 'loadView', 'loadSessions']))
    assert.equal(calls[0]?.sessionId, 'session-7')

    await act(async () => {
      root.unmount()
      await delay(0)
    })
  })
})
