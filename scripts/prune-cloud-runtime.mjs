import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Build a pruned runtime tree for the cloud OCI image (docker/open-cowork-cloud).
//
// The runtime stage used to copy the whole monorepo source (apps/, packages/,
// mcps/, scripts/) just to satisfy the pnpm workspace layout, shipping every
// TypeScript source and test file inside a public production image. The
// running server only needs:
//   - each workspace package's package.json (pnpm install --prod resolves the
//     workspace graph from the manifests) plus its built dist/ output,
//   - the cloud bundle + sibling browser-renderer copy under
//     apps/desktop/dist/cloud (the image CMD entrypoint),
//   - packages/app/dist-browser (the renderer-serving fallback candidate in
//     packages/cloud-server/src/browser-renderer-app.ts),
//   - bundled MCP dist output (mcps/*/dist) and skill bundles (skills/) for
//     the worker role's OpenCode runtime,
//   - the root manifests (.npmrc carries the ajv hoist the externalized
//     bundle needs), config + schema, and the license/attribution set.
//
// Usage: node scripts/prune-cloud-runtime.mjs <output-dir>

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const outDir = resolve(process.argv[2] || join(repoRoot, '.runtime-prune'))

const ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'open-cowork.config.json',
  'open-cowork.config.schema.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

const ROOT_DIRS = [
  'THIRD_PARTY_LICENSES',
  'skills',
]

// Per-workspace-package artifacts the runtime can actually load.
const PACKAGE_ARTIFACTS = ['package.json', 'dist', 'dist-browser']

const WORKSPACE_GLOB_ROOTS = ['apps', 'mcps', 'packages']

function copy(source, target) {
  cpSync(source, target, { recursive: true, dereference: false })
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const file of ROOT_FILES) {
  const source = join(repoRoot, file)
  if (!existsSync(source)) {
    console.error(`[prune-cloud-runtime] required root file missing: ${file}`)
    process.exit(1)
  }
  copy(source, join(outDir, file))
}

for (const dir of ROOT_DIRS) {
  const source = join(repoRoot, dir)
  if (existsSync(source)) copy(source, join(outDir, dir))
}

let packages = 0
for (const globRoot of WORKSPACE_GLOB_ROOTS) {
  const base = join(repoRoot, globRoot)
  if (!existsSync(base)) continue
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = join(base, entry.name)
    if (!existsSync(join(packageDir, 'package.json'))) continue
    packages += 1
    for (const artifact of PACKAGE_ARTIFACTS) {
      const source = join(packageDir, artifact)
      if (existsSync(source)) copy(source, join(outDir, globRoot, entry.name, artifact))
    }
  }
}

// The image CMD boots apps/desktop/dist/cloud/open-cowork-cloud.mjs — fail the
// build loudly if the prune ran before cloud:build produced it.
if (!existsSync(join(outDir, 'apps/desktop/dist/cloud/open-cowork-cloud.mjs'))) {
  console.error('[prune-cloud-runtime] apps/desktop/dist/cloud/open-cowork-cloud.mjs missing — run `pnpm cloud:build` first')
  process.exit(1)
}

console.log(`[prune-cloud-runtime] wrote ${outDir} (${packages} workspace packages, manifests + dist only)`)
