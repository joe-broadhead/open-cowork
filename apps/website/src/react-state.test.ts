import test from 'node:test'
import assert from 'node:assert/strict'
import { CLOUD_WEB_ADMIN_SURFACE_MATRIX } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import { initialCloudWebClientState } from './react-state.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { CLOUD_WEB_WORKBENCH_PARITY_MATRIX } from './workbench-parity.ts'

void test('React Cloud Web state initializes from bootstrap without feature data', () => {
  const bootstrap: CloudWebClientBootstrap = {
    role: 'admin',
    profileName: 'default',
    features: { chat: true },
    publicBranding: { productName: 'Open Cowork Cloud' },
    routes: CLOUD_WEB_ROUTES,
    defaultRoute: DEFAULT_CLOUD_WEB_ROUTE,
    api: CLOUD_WEB_CLIENT_ENDPOINTS,
    routeMatrix: CLOUD_WEB_ROUTE_API_MATRIX,
    adminSurfaces: CLOUD_WEB_ADMIN_SURFACE_MATRIX,
    workbenchParity: CLOUD_WEB_WORKBENCH_PARITY_MATRIX,
    sessionEventTypes: ['assistant.message'],
  }
  const state = initialCloudWebClientState(bootstrap)
  assert.equal(state.authStatus, 'loading')
  assert.equal(state.activeRoute, 'chat')
  assert.equal(state.csrfToken, null)
  assert.equal(state.workspace, null)
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(state.capabilities, { tools: [], skills: [], error: null })
  assert.equal(state.sessionEvents.status, 'idle')
  assert.equal(state.workspaceEvents.status, 'idle')
})
