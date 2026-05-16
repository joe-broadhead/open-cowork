import { existsSync, readdirSync } from 'node:fs'
import { dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const sourceDir = resolve(root, 'packages/shared/src')
const distDir = resolve(root, 'packages/shared/dist')

if (!existsSync(distDir)) {
  process.exit(0)
}

const sourceModules = new Set(
  readdirSync(sourceDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => basename(name, '.ts')),
)

const staleModules = readdirSync(distDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => basename(name, '.js'))
  .filter((name) => name !== 'index' && !sourceModules.has(name))
  .sort()

if (staleModules.length > 0) {
  console.error([
    'packages/shared/dist contains stale JavaScript modules with no matching packages/shared/src/*.ts source:',
    ...staleModules.map((name) => `- ${name}.js`),
    'Run pnpm build:shared to regenerate a clean shared package.',
  ].join('\n'))
  process.exit(1)
}
