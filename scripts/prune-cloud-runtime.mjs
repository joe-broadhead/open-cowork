import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruneCloudRuntime } from './cloud-runtime-prune-core.mjs'

// Build the Cloud OCI runtime tree from the production workspace graph plus
// product-configured MCP/skill assets. Preflight completes before the previous
// output is replaced, and the emitted manifest records every copied file.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = resolve(process.argv[2] || join(repoRoot, '.runtime-prune'))

try {
  const manifest = pruneCloudRuntime({ repoRoot, outDir })
  process.stdout.write(
    `[prune-cloud-runtime] wrote ${outDir} `
    + `(${manifest.productionWorkspaces.length} production workspaces, `
    + `${manifest.comparison.savedBytes} workspace bytes removed)\n`,
  )
} catch (error) {
  process.stderr.write(`[prune-cloud-runtime] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
