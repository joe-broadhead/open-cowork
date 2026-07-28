import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  createDesktopSmokeEnvironment,
  desktopRendererProbeUrl,
} from '../scripts/desktop-dev-smoke-core.mjs'

test('desktop development smoke inherits only operating-system launch context', () => {
  const source = {
    PATH: '/tools',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    DISPLAY: ':99',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/dbus',
    HOME: '/real-home',
    OPENAI_API_KEY: 'secret',
    OPEN_COWORK_E2E_PROBE_ACTION: 'create-session',
    ELECTRON_DISABLE_WEB_SECURITY: '1',
    NODE_OPTIONS: '--inspect',
  }
  const overrides = {
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_USER_DATA_DIR: '/isolated/data',
  }

  assert.deepEqual(
    createDesktopSmokeEnvironment(source, overrides, {
      isolatedHome: '/isolated/home',
      platform: 'linux',
    }),
    {
      PATH: '/tools',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      DISPLAY: ':99',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/dbus',
      HOME: '/isolated/home',
      OPEN_COWORK_E2E: '1',
      OPEN_COWORK_USER_DATA_DIR: '/isolated/data',
    },
  )
})

test('desktop development smoke keeps the macOS login home for safeStorage only', () => {
  const environment = createDesktopSmokeEnvironment(
    {
      PATH: '/tools',
      HOME: '/real-home',
      USER: 'cowork',
      LOGNAME: 'cowork',
      SECURITYSESSIONID: 'session',
      OPENAI_API_KEY: 'secret',
    },
    { OPEN_COWORK_E2E: '1' },
    {
      isolatedHome: '/isolated/home',
      platform: 'darwin',
    },
  )

  assert.deepEqual(environment, {
    PATH: '/tools',
    HOME: '/real-home',
    USER: 'cowork',
    LOGNAME: 'cowork',
    SECURITYSESSIONID: 'session',
    OPEN_COWORK_E2E: '1',
  })
})

test('desktop renderer HMR probe must live under packages/app/src', () => {
  const repoRoot = resolve('/workspace/open-cowork')
  assert.equal(
    desktopRendererProbeUrl(
      repoRoot,
      join(repoRoot, 'packages/app/src/dev-smoke-123/hmr-probe.ts'),
    ),
    '/packages/app/src/dev-smoke-123/hmr-probe.ts',
  )
  assert.throws(
    () => desktopRendererProbeUrl(repoRoot, '/tmp/hmr-probe.ts'),
    /packages\/app\/src/,
  )
})
