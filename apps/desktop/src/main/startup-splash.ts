import { writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { escapeHtml } from './html-escape.ts'

export function resolveStartupSplashTemplatePath(dirname: string) {
  const builtSplash = join(dirname, '../startup-splash.html')
  if (existsSync(builtSplash)) return builtSplash
  return join(dirname, '../../public/startup-splash.html')
}

export function writeStartupSplashFile(options: {
  templatePath: string
  outputDir: string
  brandName: string
}) {
  const brandName = escapeHtml(options.brandName)
  const html = readFileSync(options.templatePath, 'utf8').replaceAll('Open Cowork', () => brandName)
  const outputPath = join(options.outputDir, 'startup-splash.html')
  writeFileAtomic(outputPath, html, { mode: 0o600 })
  return outputPath
}
