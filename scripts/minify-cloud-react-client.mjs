import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
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

// Bundle-size budget. The cloud React client currently ships as a single chunk
// with no code-splitting, so this guards against silent growth and surfaces the
// shipped size in CI (gzip is what users actually download). Budgets sit just
// above the current size; ratchet them DOWN (never up without intent) as the
// bundle shrinks — e.g. once route/portal-level code-splitting lands.
const RAW_BUDGET_BYTES = 500_000
const GZIP_BUDGET_BYTES = 152_000
const rawBytes = Buffer.byteLength(result.code)
const gzipBytes = gzipSync(result.code).length
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
process.stdout.write(
  `[cloud-react-client] ${kb(rawBytes)} raw / ${kb(gzipBytes)} gzip `
  + `(budget ${kb(RAW_BUDGET_BYTES)} / ${kb(GZIP_BUDGET_BYTES)})\n`,
)
if (rawBytes > RAW_BUDGET_BYTES || gzipBytes > GZIP_BUDGET_BYTES) {
  process.stderr.write(
    '[cloud-react-client] bundle exceeds its size budget. Code-split the client or, '
    + 'if the growth is intentional and unavoidable, raise the budget in this script deliberately.\n',
  )
  process.exit(1)
}
