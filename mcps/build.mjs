import { createRequire } from 'module'
import { resolve } from 'path'

const workspaceRoot = resolve(process.cwd(), '..', '..')
const requireFromPackage = createRequire(resolve(process.cwd(), 'package.json'))
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
