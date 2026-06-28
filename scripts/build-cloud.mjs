import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CLOUD_ELECTRON_SHIM_EXPORTS } from './cloud-electron-shim-exports.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs')
const migrateOutfile = resolve(repoRoot, 'apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs')
const knowledgeMcpOutfile = resolve(repoRoot, 'apps/desktop/dist/cloud/mcp-knowledge.mjs')
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

// The cloud entrypoint reuses desktop configuration modules. Those modules
// guard Electron usage at runtime, so the server bundle only needs a tiny
// undefined-valued shim instead of shipping Electron in the production image.
const cloudElectronShimPlugin = {
  name: 'cloud-electron-shim',
  setup(buildContext) {
    buildContext.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron',
      namespace: 'cloud-electron-shim',
    }))
    buildContext.onLoad({ filter: /.*/, namespace: 'cloud-electron-shim' }, () => ({
      // Stub every name in the single-sourced shim list (kept in lockstep with the
      // server→Electron boundary test). Each is an undefined-valued named export,
      // plus a default object so `import electron from 'electron'` keeps working.
      contents: [
        ...CLOUD_ELECTRON_SHIM_EXPORTS.map((name) => `export const ${name} = undefined;`),
        `export default { ${CLOUD_ELECTRON_SHIM_EXPORTS.join(', ')} };`,
      ].join('\n'),
      loader: 'js',
    }))
  },
}

function runPnpm(args) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`)
  }
}

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
  plugins: [cloudElectronShimPlugin],
  logLevel: 'info',
})

await build({
  entryPoints: [resolve(repoRoot, 'scripts/open-cowork-cloud-migrate.ts')],
  outfile: migrateOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  external: [...builtins],
  plugins: [cloudElectronShimPlugin],
  logLevel: 'info',
})

// Bundle the knowledge MCP into the cloud image so a cloud coworker can propose
// a knowledge-wiki edit. The cloud runtime registers this built file as a local
// MCP (command `['node', '<…>/mcp-knowledge.mjs']`) per session. Unlike the other
// cloud entries (which keep node_modules external), the MCP ships as a single
// self-contained file with its deps (@modelcontextprotocol/sdk, zod) bundled, so
// the spawned process needs nothing installed alongside it.
await build({
  entryPoints: [resolve(repoRoot, 'mcps/knowledge/src/index.ts')],
  outfile: knowledgeMcpOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...builtins],
  logLevel: 'info',
})

// -- Unified renderer (browser build) -----------------------------------------
// The cloud image also serves the unified desktop renderer at /app — the
// one-UI-codebase cutover, so the cloud runs the same renderer as the Electron
// app. Build it and copy it next to the cloud entry under ./browser-renderer/,
// the first location packages/cloud-server/src/browser-renderer-app.ts resolves.
runPnpm(['--filter', '@open-cowork/desktop', 'build:browser'])
const browserRendererSrc = resolve(repoRoot, 'apps/desktop/dist-browser')
const browserRendererDest = resolve(repoRoot, 'apps/desktop/dist/cloud/browser-renderer')
await mkdir(resolve(browserRendererDest, 'assets'), { recursive: true })
await copyFile(resolve(browserRendererSrc, 'browser.html'), resolve(browserRendererDest, 'browser.html'))
const browserRendererAssets = await readdir(resolve(browserRendererSrc, 'assets'))
for (const asset of browserRendererAssets) {
  await copyFile(resolve(browserRendererSrc, 'assets', asset), resolve(browserRendererDest, 'assets', asset))
}

// The managed-server supervisor now ships inside @open-cowork/runtime-host (built by
// tsc, present in node_modules/@open-cowork/runtime-host/dist). The cloud's
// runtime-node-managed-server resolves it as a sibling there, so no separate cloud
// bundle of the supervisor is needed.
