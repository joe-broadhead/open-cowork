import { createRequire } from 'module'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const mcpRoot = resolve(fileURLToPath(new URL('.', import.meta.url)))
const packageRoot = process.cwd()
const workspaceRoot = resolve(mcpRoot, '..')
const requireFromPackage = createRequire(resolve(packageRoot, 'package.json'))
const { build } = requireFromPackage('esbuild')

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.js',
  nodePaths: [
    resolve(workspaceRoot, 'node_modules', '.pnpm', 'node_modules'),
    resolve(workspaceRoot, 'node_modules'),
  ],
})
