import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyAppearancePreferences } from './helpers/theme'
import './styles/globals.css'

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
  shell.style.cssText = "height:100vh;width:100vw;display:flex;align-items:center;justify-content:center;background:var(--color-base, #1b1b26);color:var(--color-text, #e8e9f3);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;padding:24px;"

  const panel = document.createElement('div')
  panel.style.cssText = 'max-width:720px;width:100%;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:24px 28px;box-shadow:0 10px 28px rgba(0,0,0,0.18);'

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
