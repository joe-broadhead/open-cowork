import test from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULT_UI_ACCENT_PRESET_ID, UI_ACCENT_PRESETS } from '@open-cowork/shared'
import { CLOUD_WEB_ROUTES } from './app-shell.ts'
import { cloudWebsiteHtml } from './render.ts'
import {
  iso,
  makeAuditEvents,
  makeDeliveries,
  makeMembers,
  makeSession,
  makeSessionView,
  makeTokens,
  makeUsageEvents,
  makeWorkers,
  makeWorkflows,
} from './browser-test-fixtures.ts'

const CI = Boolean(process.env.CI)
const REAL_BROWSER_STEP_TIMEOUT_MS = 10_000
const REAL_BROWSER_TEST_TIMEOUT_MS = 240_000
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const BUILT_REACT_CLIENT_PATH = fileURLToPath(new URL('../dist/client/open-cowork-cloud-react.js', import.meta.url))
const FONT_ASSET_SPECS = {
  'mona-sans-latin-wght-normal.woff2': '@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2',
  'mona-sans-latin-wght-italic.woff2': '@fontsource-variable/mona-sans/files/mona-sans-latin-wght-italic.woff2',
  'schibsted-grotesk-latin-wght-normal.woff2': '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2',
  'schibsted-grotesk-latin-wght-italic.woff2': '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-italic.woff2',
} as const

type ChromiumLauncher = {
  launch(options: Record<string, unknown>): Promise<any>
}

function pathExists(path: string) {
  try {
    accessSync(path)
    return true
  } catch {
    return false
  }
}

function readCloudWebFontAsset(pathname: string) {
  const fileName = pathname.split('/').pop() || ''
  const spec = FONT_ASSET_SPECS[fileName as keyof typeof FONT_ASSET_SPECS]
  return spec ? readFileSync(desktopRequire.resolve(spec)) : null
}

function readBuiltReactClientAsset() {
  return pathExists(BUILT_REACT_CLIENT_PATH) ? readFileSync(BUILT_REACT_CLIENT_PATH, 'utf8') : null
}

async function loadChromium() {
  try {
    const module = await import('playwright-core') as { chromium: ChromiumLauncher }
    return module.chromium
  } catch (error) {
    if (CI) throw error
    return null
  }
}

async function launchChromium(chromium: ChromiumLauncher) {
  const args = ['--disable-dev-shm-usage', '--no-sandbox']
  const explicitPath = process.env.OPEN_COWORK_CLOUD_WEB_CHROMIUM
  if (explicitPath) return chromium.launch({ executablePath: explicitPath, args })

  try {
    return await chromium.launch({ channel: 'chrome', args })
  } catch (channelError) {
    const executablePath = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].find(pathExists)

    if (executablePath) return chromium.launch({ executablePath, args })
    if (CI) {
      throw new Error('Cloud Web real browser smoke requires Chrome or OPEN_COWORK_CLOUD_WEB_CHROMIUM in CI.', {
        cause: channelError,
      })
    }
    return null
  }
}

async function waitForFontsReady(page: any) {
  try {
    await page.waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', undefined, {
      timeout: REAL_BROWSER_STEP_TIMEOUT_MS,
    })
  } catch (error) {
    const debug = await page.evaluate(() => ({
      fontStatus: document.fonts?.status || null,
      fontCount: document.fonts ? Array.from(document.fonts).length : 0,
      bodyFont: getComputedStyle(document.body).fontFamily,
    }))
    throw new Error(`Cloud Web fonts did not settle: ${JSON.stringify(debug)}`, {
      cause: error,
    })
  }
}

async function closeBrowserBestEffort(browser: any) {
  let closed = false
  await Promise.race([
    browser.close().then(() => {
      closed = true
    }),
    delay(REAL_BROWSER_STEP_TIMEOUT_MS),
  ])
  if (closed) return
  const process = typeof browser.process === 'function' ? browser.process() : null
  process?.kill?.()
}

function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function makeMockState() {
  const sessions = [makeSession(1), makeSession(2)]
  const views = Object.fromEntries(sessions.map((session, index) => [session.sessionId, makeSessionView(session, index + 10, 2)]))
  return {
    role: 'admin',
    features: {
      chat: true,
      workflows: true,
      agents: true,
      customSkills: true,
      customMcps: true,
    },
    sessions,
    views,
    byok: [
      { providerId: 'anthropic', credentialKind: 'kms_ref', last4: '1234', status: 'active', updatedAt: iso(1), lastValidatedAt: null },
    ],
    tokens: makeTokens(2),
    members: makeMembers(3),
    agents: [
      { agentId: 'agent-1', name: 'On-call coding agent', profileName: 'default', status: 'active' },
    ],
    bindings: [
      { bindingId: 'binding-1', agentId: 'agent-1', provider: 'telegram', displayName: 'Team Telegram', status: 'active', settings: { defaultChatId: 'chat-1' } },
    ],
    deliveries: makeDeliveries(2),
    workerPools: [
      { poolId: 'pool-1', name: 'Primary worker pool', mode: 'self_hosted', status: 'active', region: 'test-region', maxWorkers: 3, maxConcurrentWork: 6, updatedAt: iso(4) },
    ],
    workers: makeWorkers(2),
    workflows: makeWorkflows(2),
    runs: [
      { id: 'run-1', workflowId: 'workflow-1', title: 'Daily review run', status: 'completed', sessionId: 'session-1', triggerType: 'manual', createdAt: iso(6), summary: 'Done' },
    ],
    auditEvents: makeAuditEvents(2),
    usageEvents: makeUsageEvents(2),
  }
}

function browserMocksScript(state: ReturnType<typeof makeMockState>) {
  return String.raw`(() => {
  const state = ${scriptJson(state)};
  const requests = [];
  window.__cloudWebRequests = requests;

  function bootstrap() {
    return JSON.parse(document.getElementById('open-cowork-cloud-bootstrap')?.textContent || '{}');
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  function parseBody(body) {
    if (typeof body !== 'string' || !body.trim()) return null;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  function bounded(path, fallback, max = 500) {
    const params = new URL(path, location.origin).searchParams;
    const parsed = Number(params.get('limit') || fallback);
    return Math.min(Math.max(Math.floor(Number.isFinite(parsed) ? parsed : fallback), 1), max);
  }

  function record(input, init = {}) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const baseOrigin = location.origin === 'null' ? 'https://cloud.example.test' : location.origin;
    const url = new URL(raw, baseOrigin);
    return {
      method: String(init.method || 'GET').toUpperCase(),
      path: url.pathname + url.search,
      pathname: url.pathname,
      body: parseBody(init.body),
    };
  }

  window.fetch = async (input, init = {}) => {
    const request = record(input, init);
    requests.push(request);
    const body = request.body || {};

    if (request.method === 'GET' && request.pathname === '/auth/me') {
      return json({
        principal: { userId: 'user-1', accountId: 'acct-1', orgId: 'org-1', tenantId: 'org-1', email: 'admin@example.test', role: state.role },
        csrfToken: 'csrf-token',
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/config') return json({ ...bootstrap(), features: state.features });
    if (request.method === 'GET' && request.pathname === '/api/workspace') {
      return json({
        orgId: 'org-1',
        tenantId: 'org-1',
        orgName: 'Acme Cloud',
        email: 'admin@example.test',
        role: state.role,
        profileName: 'default',
        policy: { allowedAgents: ['build', 'data-analyst'], allowedTools: ['shell', 'repo.search'], allowedMcps: null },
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/byok') return json({ secrets: state.byok });
    if (request.method === 'GET' && request.pathname === '/api/api-tokens') return json({ tokens: state.tokens.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/billing/subscription') {
      return json({
        enabled: true,
        active: true,
        mode: 'managed',
        providerId: 'stripe',
        subscription: { planKey: 'pro', status: 'active', seats: 1, currentPeriodEnd: '${iso(30)}' },
        plans: [{ planKey: 'pro', label: 'Pro', default: true, entitlements: { maxPromptsPerHour: 100 } }],
        entitlements: { maxPromptsPerHour: 100 },
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/usage/events') return json({ events: state.usageEvents.slice(0, bounded(request.path, 20)) });
    if (request.method === 'GET' && request.pathname === '/api/usage/summary') {
      return json({
        eventSampleLimit: 100,
        quotas: [{ quotaKey: 'prompts', label: 'Prompts/hour', enabled: true, used: 1, limit: 100, unit: 'count', resetAt: '${iso(59)}' }],
        totals: [{ eventType: 'prompt', quantity: 1, unit: 'count' }],
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/policy') {
      return json({
        policy: {
          org: { orgId: 'org-1', name: 'Acme Cloud' },
          signup: { mode: 'invite', allowedEmailDomains: ['example.test'] },
          profile: { name: 'default', label: 'Default' },
          features: state.features,
          allowedAgents: ['build', 'data-analyst'],
          allowedTools: ['shell'],
          allowedMcps: null,
          projectSources: { git: { allowedHosts: ['github.com'] }, uploadedSnapshots: { enabled: true, maxFiles: 100, maxBytes: 1048576 }, managedWorkspaces: { enabled: false } },
          runtime: { machineRuntimeConfig: 'disabled', localStdioMcps: 'disabled', hostProjectDirectories: 'disabled' },
          gateway: { channelsEnabled: true, webhooksEnabled: true },
          byok: { allowedProviderIds: ['anthropic'], kmsRefsEnabled: true, envRefsEnabled: false },
        },
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/admin/members') return json({ members: state.members.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/admin/audit') return json({ events: state.auditEvents.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/admin/worker-pools') return json({ pools: state.workerPools.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/admin/workers') return json({ workers: state.workers.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/channels/agents') return json({ agents: state.agents.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/channels/bindings') return json({ bindings: state.bindings.slice(0, bounded(request.path, 100)) });
    if (request.method === 'GET' && request.pathname === '/api/channels/deliveries') return json({ deliveries: state.deliveries.slice(0, bounded(request.path, 50)) });
    if (request.method === 'GET' && request.pathname === '/api/capabilities') {
      return json({
        tools: [
          { id: 'shell', label: 'Shell', kind: 'tool', source: 'builtin', agentNames: ['build'] },
          { id: 'custom-tool', label: 'Custom tool', kind: 'tool', source: 'custom', agentNames: ['data-analyst'] },
        ],
        skills: [
          { id: 'analysis', label: 'Analysis', kind: 'skill', source: 'builtin', agentNames: ['data-analyst'], toolIds: ['shell'] },
        ],
      });
    }
    if (request.method === 'GET' && request.pathname === '/api/workflows') return json({ workflows: state.workflows.slice(0, bounded(request.path, 100)), runs: state.runs.slice(0, 50) });
    if (request.method === 'GET' && request.pathname === '/api/sessions') return json({ sessions: state.sessions.slice(0, bounded(request.path, state.sessions.length)), nextCursor: null, totalEstimate: state.sessions.length });
    const sessionViewMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/view$/);
    if (request.method === 'GET' && sessionViewMatch) return json(state.views[decodeURIComponent(sessionViewMatch[1])] || { error: 'Not found' }, state.views[decodeURIComponent(sessionViewMatch[1])] ? 200 : 404);
    if (request.method === 'GET' && request.pathname === '/api/artifacts') {
      return json({
        artifacts: Object.entries(state.views).flatMap(([sessionId, view]) =>
          (view?.projection?.view?.artifacts || []).map((artifact) => ({
            ...artifact,
            sessionId,
            status: artifact.status || 'draft',
            kind: artifact.kind || 'document',
          })),
        ).slice(0, bounded(request.path, 100)),
      });
    }
    const artifactListMatch = request.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
    if (request.method === 'GET' && artifactListMatch) {
      const view = state.views[decodeURIComponent(artifactListMatch[1])];
      return json({ artifacts: view?.projection?.view?.artifacts || [] });
    }
    if (request.method === 'GET' && request.pathname === '/api/diagnostics') {
      return json({
        generatedAt: '${iso(10)}',
        redaction: 'secrets-redacted',
        runtime: { role: 'web', commandProcessing: 'disabled', heartbeatCount: 2 },
        gateway: { agents: { total: state.agents.length }, deliverySampleLimit: 200 },
      });
    }
    if (request.method === 'POST' && request.pathname === '/api/project-sources/validate') return json({ allowed: true });
    if (request.method === 'POST' && request.pathname === '/api/project-sources/snapshots') return json({ projectSource: { kind: 'snapshot', snapshotId: 'snapshot-1', title: 'Browser upload' } });
    if (request.method === 'POST' && request.pathname === '/api/sessions') {
      const session = { ...state.sessions[0], sessionId: 'created-session', title: 'Created browser thread', profileName: body.profileName || 'default' };
      state.sessions.unshift(session);
      state.views[session.sessionId] = {
        session,
        projection: { sequence: 1, view: { title: session.title, profileName: session.profileName, status: 'idle', updatedAt: '${iso(40)}', messages: [], toolCalls: [], taskRuns: [], pendingApprovals: [], pendingQuestions: [], resolvedApprovals: [], resolvedQuestions: [], artifacts: [], todos: [], errors: [] } },
      };
      return json(state.views[session.sessionId]);
    }

    return json({ error: 'Unhandled browser smoke route ' + request.method + ' ' + request.path }, 404);
  };

  class FakeEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      requests.push({ method: 'SSE', path: String(url), pathname: String(url).split('?')[0], body: null });
      setTimeout(() => {
        if (this.readyState !== 2) {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new Event('open'));
        }
      }, 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;
  window.EventSource = FakeEventSource;
  window.open = () => null;
  window.prompt = () => 'confirmed from real browser test';
})();`
}

test('cloud web workbench passes a real Chromium desktop and mobile smoke', { timeout: REAL_BROWSER_TEST_TIMEOUT_MS }, async () => {
  const chromium = await loadChromium()
  if (!chromium) return

  const browser = await launchChromium(chromium)
  if (!browser) return

  try {
    const state = makeMockState()
    const html = cloudWebsiteHtml({
      role: 'admin',
      profileName: 'default',
      features: state.features,
    }, {
      productName: 'Acme Cowork Cloud',
      shortName: 'AC',
    }, 'real-browser-test-nonce')
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const pageUrl = 'https://cloud.example.test/'
    const builtReactClient = readBuiltReactClientAsset()
    await page.route(pageUrl, (route: any) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    }))
    const fontRequests: string[] = []
    const reactClientRequests: string[] = []
    await page.route('https://cloud.example.test/assets/fonts/*.woff2', (route: any) => {
      const pathname = new URL(route.request().url()).pathname
      fontRequests.push(pathname)
      const body = readCloudWebFontAsset(pathname)
      return route.fulfill(body
        ? { status: 200, contentType: 'font/woff2', body }
        : { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' })
    })
    await page.route('https://cloud.example.test/assets/open-cowork-cloud-react.js', (route: any) => {
      reactClientRequests.push(new URL(route.request().url()).pathname)
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: builtReactClient || 'document.getElementById("open-cowork-cloud-react-root")?.setAttribute("data-react-status", "test-hydrated");',
      })
    })
    await page.addInitScript(browserMocksScript(state))
    const pageErrors: string[] = []
    page.on('pageerror', (error: Error) => pageErrors.push(error.message))
    page.on('console', (message: any) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    await page.goto(pageUrl, { waitUntil: 'load' })
    await waitForFontsReady(page)
    assert.ok(fontRequests.some((path) => path.endsWith('/mona-sans-latin-wght-normal.woff2')), 'Mona Sans font route was requested')
    assert.ok(fontRequests.some((path) => path.endsWith('/schibsted-grotesk-latin-wght-normal.woff2')), 'Schibsted Grotesk font route was requested')
    assert.deepEqual(reactClientRequests, ['/assets/open-cowork-cloud-react.js'])
    if (builtReactClient) {
      try {
        await page.waitForFunction(() => document.getElementById('open-cowork-cloud-react-root')?.dataset.reactStatus === 'hydrated', undefined, { timeout: 10_000 })
      } catch (error) {
        const debug = await page.evaluate(() => ({
          rootStatus: document.getElementById('open-cowork-cloud-react-root')?.dataset.reactStatus || null,
          hasShell: Boolean(document.querySelector('[data-cloud-react-shell]')),
          shellAttr: document.querySelector('[data-cloud-react-shell]')?.getAttribute('data-cloud-react-shell') || null,
          scripts: Array.from(document.scripts).map((script) => ({ src: script.src, type: script.type, nonce: script.nonce ? 'present' : 'missing' })),
          requests: (window as any).__cloudWebRequests || [],
        }))
        throw new Error(`Built React client did not mount: ${JSON.stringify({ pageErrors, debug })}`, {
          cause: error,
        })
      }
    }
    assert.equal(await page.locator('#open-cowork-cloud-react-root').getAttribute('data-react-status'), builtReactClient ? 'hydrated' : 'test-hydrated')
    if (builtReactClient) {
      await page.waitForSelector('body[data-react-workbench="active"]', { timeout: 10_000 })
      await page.waitForSelector('body[data-react-shell="active"]', { timeout: 10_000 })
      await page.waitForSelector('body[data-react-workbench-surfaces="active"]', { timeout: 10_000 })
      await page.waitForSelector('body[data-react-admin-surfaces="active"]', { timeout: 10_000 })
      // The product ships a single Mercury/Day identity — exercise the Mode
      // (scheme) control rather than the removed editor-preset select.
      await page.locator('#cloud-theme-scheme').selectOption('light')
      try {
        await page.waitForFunction(() => document.documentElement.dataset.colorScheme === 'light'
          && document.documentElement.dataset.uiTheme === 'mercury')
      } catch (error) {
        const debug = await page.evaluate(() => {
          const schemeSelect = document.getElementById('cloud-theme-scheme') as HTMLSelectElement | null
          return {
            theme: document.documentElement.dataset.uiTheme || null,
            scheme: document.documentElement.dataset.colorScheme || null,
            schemeValue: schemeSelect?.value || null,
            schemeDisabled: schemeSelect?.disabled || false,
            storedScheme: localStorage.getItem('open-cowork-cloud-color-scheme'),
          }
        })
        throw new Error(`Cloud Web real browser smoke did not apply selected mode: ${JSON.stringify(debug)}`, {
          cause: error,
        })
      }
      assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), 'light')
      assert.equal(await page.evaluate(() => document.documentElement.dataset.uiTheme), 'mercury')
      assert.equal(await page.locator('#cloud-theme-accent').inputValue(), DEFAULT_UI_ACCENT_PRESET_ID)
      assert.equal(
        await page.evaluate(() => document.documentElement.style.getPropertyValue('--color-accent')),
        UI_ACCENT_PRESETS[DEFAULT_UI_ACCENT_PRESET_ID].accent,
      )
      await page.locator('#cloud-theme-density').selectOption('compact')
      await page.waitForFunction(() => document.documentElement.dataset.density === 'compact')
      assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact')
      assert.equal(await page.locator('#cloud-theme-density').inputValue(), 'compact')
    }
    assert.equal(await page.locator('[data-cloud-react-shell]').getAttribute('data-cloud-react-shell'), 'ssr')
    try {
      await page.waitForSelector('body[data-auth="signed-in"]', { timeout: 10_000 })
    } catch (error) {
      const debug = await page.evaluate(() => ({
        auth: document.body?.dataset.auth || null,
        route: document.body?.dataset.route || null,
        status: document.querySelector('#status')?.textContent || null,
        requests: (window as any).__cloudWebRequests || [],
      }))
      throw new Error(`Cloud Web real browser smoke did not sign in: ${JSON.stringify(debug)}`, {
        cause: error,
      })
    }
    await page.waitForFunction(() => document.querySelectorAll('#thread-list [role="row"]').length > 0)
    assert.equal(await page.locator('[data-route-panel="chat"]').getAttribute('aria-hidden'), 'false')
    assert.equal(await page.locator('[data-route-panel="threads"]').getAttribute('aria-hidden'), 'true')
    assert.equal(await page.locator('body').getAttribute('data-chat-state'), 'empty')
    assert.match(await page.locator('#chat-session-title').textContent() || '', /What shall we cowork on today/)
    assert.equal(await page.locator('#chat-inspector').isHidden(), true)
    await page.locator('#sidebar-thread-list button').first().click()
    await page.waitForFunction(() => document.body.dataset.chatState === 'thread')
    assert.match(await page.locator('#chat-timeline').textContent() || '', /Workspace summary for Cloud thread/)
    await page.locator('[data-route-link="agents"]').click()
    await page.waitForFunction(() => document.body.dataset.route === 'agents')
    assert.match(await page.locator('#workbench-agent-list').textContent() || '', /build/)
    await page.locator('[data-route-link="capabilities"]').click()
    await page.waitForFunction(() => document.body.dataset.route === 'capabilities')
    assert.match(await page.locator('#capability-tabs').textContent() || '', /Connections/)
    await page.locator('#capability-tabs button', { hasText: 'Connections' }).click()
    assert.match(await page.locator('#capability-active-list').textContent() || '', /Shell/)
    assert.match(await page.locator('#capability-policy-note').textContent() || '', /Local stdio MCPs are Desktop-only/)
    await page.locator('[data-route-link="workflows"]').click()
    await page.waitForFunction(() => document.body.dataset.route === 'workflows')
    assert.match(await page.locator('#workflow-detail').textContent() || '', /Latest run/)
    assert.match(await page.locator('#workflow-detail').textContent() || '', /Runs as/)
    await page.locator('[data-route-link="artifacts"]').click()
    await page.waitForFunction(() => document.body.dataset.route === 'artifacts')
    await page.waitForFunction(() => document.querySelector('#artifact-list')?.textContent?.includes('summary.txt'))
    assert.match(await page.locator('#artifact-list').textContent() || '', /summary\.txt/)

    for (const route of CLOUD_WEB_ROUTES) {
      const adminOpen = await page.locator('[data-admin-nav]').getAttribute('open')
      if (route.surface === 'admin' && adminOpen === null) {
        await page.locator('[data-admin-nav] summary').click()
      }
      await page.locator(`[data-route-link="${route.id}"]`).click()
      await page.waitForFunction((routeId: string) => document.body.dataset.route === routeId, route.id)
      assert.equal(await page.locator(`[data-route-panel="${route.id}"]`).getAttribute('aria-hidden'), 'false')
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-route-link="diagnostics"]').click()
    await page.waitForFunction(() => document.body.dataset.route === 'diagnostics')
    await page.locator('#prepare-diagnostics').click()
    try {
      await page.waitForFunction(() => document.querySelector('#diagnostics-bundle')?.textContent?.includes('secrets-redacted'), undefined, { timeout: 10_000 })
    } catch (error) {
      const debug = await page.evaluate(() => ({
        route: document.body.dataset.route || null,
        buttonDisabled: (document.querySelector('#prepare-diagnostics') as HTMLButtonElement | null)?.disabled ?? null,
        bundleText: document.querySelector('#diagnostics-bundle')?.textContent || null,
        statusText: document.querySelector('#status')?.textContent || null,
        requests: (window as any).__cloudWebRequests || [],
      }))
      throw new Error(`Diagnostics bundle did not render: ${JSON.stringify({ pageErrors, debug })}`, {
        cause: error,
      })
    }

    const mobile = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      clippedLinks: Array.from(document.querySelectorAll<HTMLElement>('[data-route-link]:not([hidden])'))
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent?.trim() || element.dataset.routeLink || ''),
      topbarBottom: document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0,
      contentTop: document.querySelector('.content')?.getBoundingClientRect().top || 0,
    }))
    assert.ok(mobile.documentWidth <= mobile.viewportWidth + 1, `mobile layout overflowed horizontally: ${mobile.documentWidth} > ${mobile.viewportWidth}`)
    assert.deepEqual(mobile.clippedLinks, [])
    assert.ok(mobile.contentTop >= mobile.topbarBottom - 1, 'content starts below the mobile topbar')
    assert.deepEqual(pageErrors, [])
  } finally {
    await closeBrowserBestEffort(browser)
  }
})
