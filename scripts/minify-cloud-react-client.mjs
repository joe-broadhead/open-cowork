import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const assetPath = resolve(repoRoot, 'apps/website/dist/client/open-cowork-cloud-react.js')
const source = await readFile(assetPath, 'utf8')
const result = await transform(source, {
  format: 'esm',
  legalComments: 'none',
  minify: true,
  target: 'es2022',
})

await writeFile(assetPath, result.code)
