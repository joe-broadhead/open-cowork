import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const clientDir = resolve(repoRoot, 'apps/website/dist/client')

// Bundle-size budget across ALL client chunks. The cloud React client is now
// vendor-split: the entry (`open-cowork-cloud-react.js`) imports a cacheable
// React/ReactDOM/scheduler vendor chunk by a fixed name. Vite minifies the
// chunks (esbuild); this guards against silent growth and surfaces the shipped
// size in CI (gzip is what users download). Budgets sit just above the current
// total; ratchet them DOWN (never up without intent) as the bundle shrinks.
const RAW_BUDGET_BYTES = 500_000
const GZIP_BUDGET_BYTES = 152_000

const chunks = (await readdir(clientDir)).filter((file) => file.endsWith('.js')).sort()
let rawBytes = 0
let gzipBytes = 0
const lines = []
for (const file of chunks) {
  const code = await readFile(resolve(clientDir, file))
  rawBytes += code.length
  gzipBytes += gzipSync(code).length
  lines.push(`  ${file}: ${(code.length / 1024).toFixed(1)} KB`)
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
process.stdout.write(
  `[cloud-react-client] ${chunks.length} chunks, ${kb(rawBytes)} raw / ${kb(gzipBytes)} gzip `
  + `(budget ${kb(RAW_BUDGET_BYTES)} / ${kb(GZIP_BUDGET_BYTES)})\n${lines.join('\n')}\n`,
)
if (rawBytes > RAW_BUDGET_BYTES || gzipBytes > GZIP_BUDGET_BYTES) {
  process.stderr.write(
    '[cloud-react-client] client bundle exceeds its size budget. Trim dependencies or, if the '
    + 'growth is intentional and unavoidable, raise the budget in this script deliberately.\n',
  )
  process.exit(1)
}
