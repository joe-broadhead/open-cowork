import { escapeHtml } from '@open-cowork/runtime-host/html-escape'
import {
  STARTUP_THEME_CSS_PROPERTIES,
  type StartupSurfaceState,
} from '@open-cowork/shared'
import { writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const FALLBACK_APPEARANCE_ATTRIBUTES = 'data-color-scheme="system" data-ui-theme="system"'
const STARTUP_THEME_BLOCK = /\/\* STARTUP_THEME_BEGIN \*\/[\s\S]*?\/\* STARTUP_THEME_END \*\//

export function resolveStartupSplashTemplatePath(dirname: string) {
  const builtSplash = join(dirname, '../startup-splash.html')
  if (existsSync(builtSplash)) return builtSplash
  return join(dirname, '../../public/startup-splash.html')
}

export function writeStartupSplashFile(options: {
  templatePath: string
  outputDir: string
  state: StartupSurfaceState
}) {
  const brandName = escapeHtml(options.state.brandName)
  const declarations = Object.entries(STARTUP_THEME_CSS_PROPERTIES)
    .map(([token, property]) => `        ${property}: ${escapeHtml(options.state.tokens[token as keyof typeof options.state.tokens])};`)
    .join('\n')
  let html = readFileSync(options.templatePath, 'utf8').replaceAll('Open Cowork', () => brandName)
  html = html.replace(
    FALLBACK_APPEARANCE_ATTRIBUTES,
    `data-color-scheme="${options.state.colorScheme}" data-ui-theme="${escapeHtml(options.state.themeId)}"`,
  )
  html = html.replace(
    STARTUP_THEME_BLOCK,
    `/* STARTUP_THEME_BEGIN */\n        color-scheme: ${options.state.colorScheme};\n${declarations}\n        /* STARTUP_THEME_END */`,
  )
  const outputPath = join(options.outputDir, 'startup-splash.html')
  writeFileAtomic(outputPath, html, { mode: 0o600 })
  return outputPath
}

export function prepareStartupSplashFile(options: {
  templatePath: string
  outputDir: string
  state: StartupSurfaceState
}) {
  try {
    return { path: writeStartupSplashFile(options), error: null }
  } catch (error) {
    return { path: options.templatePath, error }
  }
}
