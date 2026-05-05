import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isExpectedPackagedRendererFile,
  isTrustedRendererIpcUrl,
  needsMainWindowRecovery,
  pickRecoverableMainWindow,
  rendererUrlLooksWrong,
  rendererUrlMatchesDevServer,
  shouldRecoverMainWindowFromDidFailLoad,
} from '../apps/desktop/src/main/main-window-lifecycle.ts'

function createWindow(overrides?: Partial<{ destroyed: boolean; visible: boolean }>) {
  return {
    isDestroyed: () => overrides?.destroyed === true,
    isVisible: () => overrides?.visible !== false,
  }
}

test('rendererUrlLooksWrong accepts the expected shell URL and rejects asset URLs', () => {
  assert.equal(rendererUrlLooksWrong('about:blank'), true)
  assert.equal(rendererUrlLooksWrong('file:///tmp/index.html'), false)
  assert.equal(rendererUrlLooksWrong('file:///tmp/assets/chunk.js'), true)
  assert.equal(rendererUrlLooksWrong('http://127.0.0.1:5173', 'http://127.0.0.1:5173'), false)
  assert.equal(rendererUrlLooksWrong('http://127.0.0.1:51730', 'http://127.0.0.1:5173'), true)
  assert.equal(rendererUrlLooksWrong('http://127.0.0.1:4173', 'http://127.0.0.1:5173'), true)
})

test('isExpectedPackagedRendererFile only allows the packaged renderer entry', () => {
  const expected = '/Applications/Open Cowork.app/Contents/Resources/app.asar/dist/index.html'
  assert.equal(
    isExpectedPackagedRendererFile('file:///Applications/Open%20Cowork.app/Contents/Resources/app.asar/dist/index.html', expected),
    true,
  )
  assert.equal(
    isExpectedPackagedRendererFile('file:///Applications/Open%20Cowork.app/Contents/Resources/app.asar/dist/chart-frame.html', expected),
    false,
  )
  assert.equal(
    isExpectedPackagedRendererFile('file:///Users/example/.ssh/config', expected),
    false,
  )
  assert.equal(
    isExpectedPackagedRendererFile('https://example.com/index.html', expected),
    false,
  )
})

test('rendererUrlMatchesDevServer requires the exact dev-server origin', () => {
  assert.equal(rendererUrlMatchesDevServer('http://127.0.0.1:5173', 'http://127.0.0.1:5173'), true)
  assert.equal(rendererUrlMatchesDevServer('http://127.0.0.1:5173/src/App.tsx', 'http://127.0.0.1:5173'), true)
  assert.equal(rendererUrlMatchesDevServer('http://127.0.0.1:51730', 'http://127.0.0.1:5173'), false)
  assert.equal(rendererUrlMatchesDevServer('https://example.com', 'http://127.0.0.1:5173'), false)
})

test('isTrustedRendererIpcUrl accepts only packaged renderer or configured dev shell', () => {
  const expected = '/Applications/Open Cowork.app/Contents/Resources/app.asar/dist/index.html'
  assert.equal(isTrustedRendererIpcUrl({
    rawUrl: 'file:///Applications/Open%20Cowork.app/Contents/Resources/app.asar/dist/index.html',
    expectedRendererPath: expected,
  }), true)
  assert.equal(isTrustedRendererIpcUrl({
    rawUrl: 'file:///Applications/Open%20Cowork.app/Contents/Resources/app.asar/dist/startup-splash.html',
    expectedRendererPath: expected,
  }), false)
  assert.equal(isTrustedRendererIpcUrl({
    rawUrl: 'http://127.0.0.1:5173',
    devServerUrl: 'http://127.0.0.1:5173',
    expectedRendererPath: expected,
  }), true)
  assert.equal(isTrustedRendererIpcUrl({
    rawUrl: 'https://example.com/index.html',
    expectedRendererPath: expected,
  }), false)
})

test('pickRecoverableMainWindow keeps a live current window and falls back when needed', () => {
  const live = createWindow()
  const destroyed = createWindow({ destroyed: true })
  const fallback = createWindow()

  assert.equal(pickRecoverableMainWindow(live, [fallback]), live)
  assert.equal(pickRecoverableMainWindow(destroyed, [fallback]), fallback)
  assert.equal(pickRecoverableMainWindow(null, [destroyed, fallback]), fallback)
})

test('needsMainWindowRecovery flags missing, destroyed, or hidden windows', () => {
  assert.equal(needsMainWindowRecovery(null), true)
  assert.equal(needsMainWindowRecovery(createWindow({ destroyed: true })), true)
  assert.equal(needsMainWindowRecovery(createWindow({ visible: false })), true)
  assert.equal(needsMainWindowRecovery(createWindow()), false)
})

test('shouldRecoverMainWindowFromDidFailLoad ignores subframe chart failures', () => {
  assert.equal(
    shouldRecoverMainWindowFromDidFailLoad({
      isMainFrame: false,
      validatedURL: 'file:///tmp/chart-frame.html',
    }),
    false,
  )
  assert.equal(
    shouldRecoverMainWindowFromDidFailLoad({
      isMainFrame: true,
      validatedURL: 'file:///tmp/index.html',
    }),
    true,
  )
})
