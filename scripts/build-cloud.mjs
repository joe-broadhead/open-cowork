import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CLOUD_ELECTRON_SHIM_EXPORTS } from './cloud-electron-shim-exports.mjs'
import { resolveEffectiveCloudRuntimeConfig } from './cloud-runtime-prune-core.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cloudOutputDir = resolve(repoRoot, 'apps/desktop/dist/cloud')
const outfile = resolve(cloudOutputDir, 'open-cowork-cloud.mjs')
const migrateOutfile = resolve(cloudOutputDir, 'open-cowork-cloud-migrate.mjs')
const knowledgeMcpOutfile = resolve(cloudOutputDir, 'mcp-knowledge.mjs')
const runtimeWorkspacesOutfile = resolve(cloudOutputDir, 'cloud-runtime-workspaces.json')
const runtimePackages = ['opencode-ai']
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

async function configuredMcpWorkspaceFilters() {
  const sourceConfig = JSON.parse(await readFile(resolve(repoRoot, 'open-cowork.config.json'), 'utf8'))
  const config = resolveEffectiveCloudRuntimeConfig(sourceConfig)
  return Array.from(new Set(
    (Array.isArray(config.mcps) ? config.mcps : [])
      .filter((mcp) => mcp?.type === 'local' && typeof mcp.packageName === 'string')
      .map((mcp) => mcp.packageName.trim())
      .filter(Boolean),
  ))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((packageName) => {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(packageName)) {
        throw new Error(`Configured MCP package name is not a safe workspace segment: ${packageName}`)
      }
      return `./mcps/${packageName}`
    })
}

function owningWorkspacePath(inputPath) {
  let current = dirname(resolve(repoRoot, inputPath))
  while (current !== repoRoot && current.startsWith(`${repoRoot}${sep}`)) {
    if (existsSync(resolve(current, 'package.json'))) {
      return relative(repoRoot, current).split(sep).join('/')
    }
    current = dirname(current)
  }
  return null
}

function externalPackageName(specifier) {
  if (
    !specifier
    || specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('file:')
    || specifier.startsWith('node:')
    || builtins.has(specifier)
  ) {
    return null
  }
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] || null
}

function externalPackages(metafiles, dynamicSpecifiers) {
  return Array.from(new Set(
    [
      ...metafiles
        .flatMap((metafile) => Object.values(metafile.outputs))
        .flatMap((output) => output.imports || [])
        .filter((imported) => imported.external)
        .map((imported) => imported.path),
      ...dynamicSpecifiers,
    ]
      .map((specifier) => externalPackageName(specifier))
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right, 'en'))
}

async function dynamicExternalSpecifiers(paths) {
  const specifiers = new Set()
  for (const path of paths) {
    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(/\brequire\d*\(\s*["']([^"']+)["']\s*\)/g)) {
      specifiers.add(match[1])
    }
  }
  return Array.from(specifiers)
}

async function listRelativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const absolute = resolve(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(root, absolute))
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  return files
}

// Treat the Cloud directory as a staged production artifact. Starting from an
// empty directory prevents stale hashed chunks and source maps from entering
// the runtime image based on a developer's previous local builds.
await rm(cloudOutputDir, { recursive: true, force: true })
await mkdir(cloudOutputDir, { recursive: true })

const cloudBuild = await build({
  entryPoints: [resolve(repoRoot, 'scripts/open-cowork-cloud.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  metafile: true,
  packages: 'external',
  external: [...builtins],
  plugins: [cloudElectronShimPlugin],
  logLevel: 'info',
})

const migrationBuild = await build({
  entryPoints: [resolve(repoRoot, 'scripts/open-cowork-cloud-migrate.ts')],
  outfile: migrateOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  metafile: true,
  packages: 'external',
  external: [...builtins],
  plugins: [cloudElectronShimPlugin],
  logLevel: 'info',
})

const bundledSourceWorkspaces = Array.from(new Set(
  [cloudBuild.metafile, migrationBuild.metafile]
    .flatMap((metafile) => Object.keys(metafile.inputs))
    .map(owningWorkspacePath)
    .filter(Boolean),
)).sort()
const runtimeExternalPackages = externalPackages(
  [cloudBuild.metafile, migrationBuild.metafile],
  await dynamicExternalSpecifiers([outfile, migrateOutfile]),
)

// A clean Docker context contains MCP source but no workspace dist directories.
// Build exactly the package-backed MCPs admitted by the effective default Cloud
// profile before the pruner validates and copies their production artifacts.
// Disabled bare commands remain Desktop-only; an explicit Cloud opt-in fails
// closed because the production image cannot prove that command's closure.
const mcpWorkspaceFilters = await configuredMcpWorkspaceFilters()
if (mcpWorkspaceFilters.length > 0) {
  runPnpm([
    ...mcpWorkspaceFilters.flatMap((filter) => ['--filter', filter]),
    'build',
  ])
}

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
  sourcemap: false,
  external: [...builtins],
  logLevel: 'info',
})

// -- Unified renderer (browser build) -----------------------------------------
// The cloud image also serves the unified desktop renderer at /app — the
// one-UI-codebase cutover, so the cloud runs the same renderer as the Electron
// app. Build it and copy it next to the cloud entry under ./browser-renderer/,
// the first location packages/cloud-server/src/browser-renderer-app.ts resolves.
runPnpm(['--filter', '@open-cowork/app', 'build:browser'])
const browserRendererSrc = resolve(repoRoot, 'packages/app/dist-browser')
const browserRendererDest = resolve(repoRoot, 'apps/desktop/dist/cloud/browser-renderer')
await mkdir(resolve(browserRendererDest, 'assets'), { recursive: true })
await copyFile(resolve(browserRendererSrc, 'browser.html'), resolve(browserRendererDest, 'browser.html'))
await copyFile(resolve(browserRendererSrc, 'chart-frame.html'), resolve(browserRendererDest, 'chart-frame.html'))
const browserRendererAssets = await readdir(resolve(browserRendererSrc, 'assets'))
for (const asset of browserRendererAssets) {
  await copyFile(resolve(browserRendererSrc, 'assets', asset), resolve(browserRendererDest, 'assets', asset))
}

const runtimeAssets = await listRelativeFiles(cloudOutputDir)
await writeFile(runtimeWorkspacesOutfile, `${JSON.stringify({
  schemaVersion: 3,
  bundledSourceWorkspaces,
  externalPackages: runtimeExternalPackages,
  runtimePackages,
  runtimeAssets,
}, null, 2)}\n`)

// The managed-server supervisor now ships inside @open-cowork/runtime-host (built by
// tsc, present in node_modules/@open-cowork/runtime-host/dist). The cloud's
// runtime-node-managed-server resolves it as a sibling there, so no separate cloud
// bundle of the supervisor is needed.
