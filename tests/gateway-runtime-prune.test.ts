import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = process.cwd()

const runtimeWorkspaces = [
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

function listFiles(root: string): string[] {
  const files: string[] = []
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
      } else if (statSync(fullPath).isFile()) {
        files.push(relative(root, fullPath).replaceAll('\\', '/'))
      }
    }
  }
  visit(root)
  return files.sort()
}

test('gateway runtime prune emits only shipped manifests and built artifacts', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-gateway-runtime-'))
  try {
    const result = spawnSync(process.execPath, ['scripts/prune-gateway-runtime.mjs', outputDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)

    const files = listFiles(outputDir)
    for (const requiredFile of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      'open-cowork.config.json',
      'open-cowork.config.schema.json',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'apps/gateway/dist/index.js',
    ]) {
      assert.ok(files.includes(requiredFile), `pruned runtime is missing ${requiredFile}`)
    }

    for (const workspace of runtimeWorkspaces) {
      assert.ok(files.includes(`${workspace}/package.json`), `pruned runtime is missing ${workspace}/package.json`)
      assert.ok(
        files.some((file) => file.startsWith(`${workspace}/dist/`)),
        `pruned runtime is missing built dist output for ${workspace}`,
      )
    }

    const forbiddenPatterns = [
      /^scripts\//,
      /^mcps\//,
      /^apps\/desktop\//,
      /^apps\/standalone-gateway\//,
      /^packages\/runtime-host\//,
      /(^|\/)src\//,
      /(^|\/)tests?\//,
      /\.test\.[cm]?[jt]sx?$/,
      /(^|\/)tsconfig(?:\.[^/]+)?\.json$/,
    ]
    const forbiddenFiles = files.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)))
    assert.deepEqual(forbiddenFiles, [], `gateway runtime prune leaked non-runtime files:\n${forbiddenFiles.join('\n')}`)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
