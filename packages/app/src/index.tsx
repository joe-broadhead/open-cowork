import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { studioSurfaceStyles } from '@open-cowork/ui'
import { App } from './App'
import { applyAppearancePreferences } from './helpers/theme'
import './styles/globals.css'

// The shared @open-cowork/ui surface stylesheet is the single source of truth for
// Studio surface CSS across the desktop renderer and Cloud Web. Inject it once,
// after globals.css, so the desktop styles those surfaces identically to the web.
function injectStudioSurfaceStyles() {
  const id = 'cowork-ui-surface-styles'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = studioSurfaceStyles()
  document.head.appendChild(style)
}
injectStudioSurfaceStyles()

function formatStartupError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function renderStartupError(error: unknown) {
  const body = document.body
  if (!body) return
  const message = formatStartupError(error)
  body.replaceChildren()

  const shell = document.createElement('div')
  shell.style.cssText = "height:100vh;width:100vw;display:flex;align-items:center;justify-content:center;background:var(--color-base);color:var(--color-text);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;padding:24px;"

  const panel = document.createElement('div')
  panel.style.cssText = 'max-width:720px;width:100%;background:color-mix(in srgb, var(--color-surface) 74%, transparent);border:1px solid var(--color-border-subtle);border-radius:16px;padding:24px 28px;box-shadow:0 10px 28px color-mix(in srgb, var(--color-base) 55%, transparent);'

  const eyebrow = document.createElement('div')
  eyebrow.textContent = 'Startup Error'
  eyebrow.style.cssText = 'font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.7;margin-bottom:8px;'

  const title = document.createElement('div')
  title.textContent = 'The app could not start the renderer.'
  title.style.cssText = 'font-size:22px;font-weight:600;margin-bottom:10px;'

  const detail = document.createElement('div')
  detail.textContent = message
  detail.style.cssText = 'font-size:14px;line-height:1.6;opacity:0.85;white-space:pre-wrap;word-break:break-word;'

  panel.append(eyebrow, title, detail)
  shell.append(panel)
  body.append(shell)
}

window.addEventListener('error', (event) => {
  console.error('Renderer startup error:', event.error || event.message)
  renderStartupError(event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Renderer startup rejection:', event.reason)
  renderStartupError(event.reason)
})

try {
  applyAppearancePreferences()

  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Renderer root element was not found.')
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (error) {
  console.error('Renderer bootstrap failed:', error)
  renderStartupError(error)
}
