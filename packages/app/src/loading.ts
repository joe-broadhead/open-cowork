import {
  parseStartupSurfaceState,
  STARTUP_THEME_CSS_PROPERTIES,
  type RuntimeLoadingPhase,
  type RuntimeLoadingStatus,
  type StartupSurfaceState,
} from '@open-cowork/shared'

import './styles/loading.css'

const phaseProgress: Record<RuntimeLoadingPhase, number> = {
  idle: 6,
  starting: 16,
  config: 34,
  'managed-server': 56,
  'connecting-events': 72,
  mcp: 86,
  ready: 100,
  error: 100,
}

const messageEl = document.querySelector<HTMLParagraphElement>('#runtime-message')
const errorEl = document.querySelector<HTMLParagraphElement>('#runtime-error')
const progressEl = document.querySelector<HTMLDivElement>('#runtime-progress')
const actionsEl = document.querySelector<HTMLDivElement>('#runtime-actions')
const restartButton = document.querySelector<HTMLButtonElement>('#runtime-restart')
const diagnosticsButton = document.querySelector<HTMLButtonElement>('#runtime-diagnostics')
const brandEl = document.querySelector<HTMLParagraphElement>('#runtime-brand')

function applyStartupSurfaceState(state: StartupSurfaceState) {
  const root = document.documentElement
  root.dataset.colorScheme = state.colorScheme
  root.dataset.uiTheme = state.themeId
  root.style.setProperty('color-scheme', state.colorScheme)
  for (const [token, property] of Object.entries(STARTUP_THEME_CSS_PROPERTIES)) {
    root.style.setProperty(property, state.tokens[token as keyof StartupSurfaceState['tokens']])
  }
  document.title = `${state.brandName} starting`
  if (brandEl) brandEl.textContent = state.brandName
}

const startupState = parseStartupSurfaceState(window.location.search)
if (startupState) applyStartupSurfaceState(startupState)

function renderStatus(status: RuntimeLoadingStatus) {
  if (messageEl) messageEl.textContent = status.message
  if (progressEl) progressEl.style.width = `${phaseProgress[status.phase]}%`
  const error = status.error || null
  if (errorEl) {
    errorEl.textContent = error || ''
    errorEl.hidden = !error
  }
  if (actionsEl) actionsEl.hidden = !error
}

window.coworkApi.on.runtimeLoadingStatus(renderStatus)

void window.coworkApi.app.config().then((config) => {
  const brandName = config.branding.name.trim()
  if (!brandName) return
  document.title = `${brandName} starting`
  if (brandEl) brandEl.textContent = brandName
}).catch(() => {
  // The static fallback remains readable if config loading fails.
})

void window.coworkApi.runtime.awaitInitialization().then(renderStatus).catch((error: unknown) => {
  renderStatus({
    phase: 'error',
    message: 'Runtime startup failed.',
    ready: false,
    error: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  })
})

restartButton?.addEventListener('click', () => {
  restartButton.disabled = true
  void window.coworkApi.runtime.restart()
    .catch((error: unknown) => {
      renderStatus({
        phase: 'error',
        message: 'Runtime restart was blocked.',
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      })
    })
    .finally(() => {
      restartButton.disabled = false
    })
})

diagnosticsButton?.addEventListener('click', () => {
  diagnosticsButton.disabled = true
  void window.coworkApi.app.exportDiagnostics()
    .then((diagnostics) => diagnostics ? window.coworkApi.clipboard.writeText(diagnostics) : false)
    .finally(() => {
      diagnosticsButton.disabled = false
    })
})
