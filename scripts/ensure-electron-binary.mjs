import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const requireFromDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const electronPath = requireFromDesktop('electron')

if (typeof electronPath !== 'string' || electronPath.trim().length === 0) {
  throw new Error('Electron did not resolve to a binary path.')
}

if (!existsSync(electronPath)) {
  throw new Error(`Electron binary was not found at ${electronPath}.`)
}
