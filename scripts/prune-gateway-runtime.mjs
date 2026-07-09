import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Build a pruned runtime tree for the Gateway OCI image.
//
// The Gateway runtime needs the root workspace manifests for `pnpm install
// --prod`, the public config/schema and license material, plus the built
// package artifacts that apps/gateway imports. It must not ship the monorepo
// source tree, tests, MCPs, desktop cloud artifacts, or release scripts.
//
// Usage: node scripts/prune-gateway-runtime.mjs <output-dir>

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const outDir = resolve(process.argv[2] || join(repoRoot, '.gateway-runtime-prune'))

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
]

const RUNTIME_WORKSPACES = [
  'apps/gateway',
  'packages/cloud-client',
  'packages/gateway-channel',
  'packages/gateway-provider-cli',
  'packages/gateway-provider-discord',
  'packages/gateway-provider-email',
  'packages/gateway-provider-signal',
  'packages/gateway-provider-slack',
  'packages/gateway-provider-telegram',
  'packages/gateway-provider-webhook',
  'packages/gateway-provider-whatsapp',
  'packages/gateway-testing',
  'packages/shared',
]

function copy(source, target) {
  cpSync(source, target, { recursive: true, dereference: false })
}

function requirePath(path, description) {
  if (!existsSync(path)) {
    console.error(`[prune-gateway-runtime] required ${description} missing: ${path}`)
    process.exit(1)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const file of ROOT_FILES) {
  const source = join(repoRoot, file)
  requirePath(source, `root file ${file}`)
  copy(source, join(outDir, file))
}

for (const dir of ROOT_DIRS) {
  const source = join(repoRoot, dir)
  if (existsSync(source)) copy(source, join(outDir, dir))
}

for (const workspace of RUNTIME_WORKSPACES) {
  const source = join(repoRoot, workspace)
  requirePath(join(source, 'package.json'), `${workspace}/package.json`)
  requirePath(join(source, 'dist'), `${workspace}/dist`)
  copy(join(source, 'package.json'), join(outDir, workspace, 'package.json'))
  copy(join(source, 'dist'), join(outDir, workspace, 'dist'))
}

requirePath(
  join(outDir, 'apps/gateway/dist/index.js'),
  'Gateway entrypoint apps/gateway/dist/index.js',
)

process.stdout.write(`[prune-gateway-runtime] wrote ${outDir} (${RUNTIME_WORKSPACES.length} workspace package artifacts, manifests + dist only)\n`)
