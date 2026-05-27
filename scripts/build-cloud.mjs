import { mkdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

await mkdir(dirname(outfile), { recursive: true })

await build({
  entryPoints: [resolve(repoRoot, 'scripts/open-cowork-cloud.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  external: [...builtins],
  logLevel: 'info',
})
