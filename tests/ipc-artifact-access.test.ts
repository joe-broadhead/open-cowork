import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionRecord } from '../apps/desktop/src/main/session-registry.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getChartArtifactsRoot } from '../apps/desktop/src/main/chart-artifacts.ts'
import { resolvePrivateSessionArtifactPath } from '../apps/desktop/src/main/ipc-artifact-access.ts'

function sessionRecord(directory: string): SessionRecord {
  return {
    id: 'sess-artifact',
    directory: null,
    opencodeDirectory: directory,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    kind: 'interactive',
    workflowId: null,
    runId: null,
    providerId: null,
    modelId: null,
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    managedByCowork: true,
  }
}

test('resolvePrivateSessionArtifactPath allows chart artifacts outside the session workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-artifact-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
    clearConfigCaches()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const chartRoot = getChartArtifactsRoot('sess-artifact')
    mkdirSync(chartRoot, { recursive: true })
    const chartPath = join(chartRoot, 'chart.png')
    writeFileSync(chartPath, 'png')

    const resolved = resolvePrivateSessionArtifactPath(
      { sessionId: 'sess-artifact', filePath: chartPath },
      { ensureSessionRecord: () => sessionRecord(workspace) },
    )

    assert.equal(readFileSync(resolved.source, 'utf-8'), 'png')
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolvePrivateSessionArtifactPath rejects files from non-private project workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-artifact-project-'))

  try {
    const workspace = join(root, 'project')
    mkdirSync(workspace, { recursive: true })
    const filePath = join(workspace, 'report.md')
    writeFileSync(filePath, '# Report')

    assert.throws(
      () => resolvePrivateSessionArtifactPath(
        { sessionId: 'sess-artifact', filePath },
        { ensureSessionRecord: () => sessionRecord(workspace) },
      ),
      /Artifacts can only be accessed from Cowork private workspaces/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
