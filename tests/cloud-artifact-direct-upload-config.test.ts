import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveCloudArtifactDirectUploadConfig } from '@open-cowork/cloud-server/artifact-direct-upload-config'

test('direct artifact uploads are disabled by default', () => {
  assert.deepEqual(resolveCloudArtifactDirectUploadConfig({}), {
    mode: 'off',
    requested: false,
    configStatus: 'valid',
    reason: 'disabled',
    cleanupBatchSize: 100,
    cleanupIntervalMs: 60_000,
  })
})

test('direct artifact uploads require the exact enabled token', () => {
  assert.equal(resolveCloudArtifactDirectUploadConfig({
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
  }).mode, 'enabled')

  assert.deepEqual(resolveCloudArtifactDirectUploadConfig({
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'true',
  }), {
    mode: 'off',
    requested: true,
    configStatus: 'invalid',
    reason: 'invalid_mode',
    cleanupBatchSize: 100,
    cleanupIntervalMs: 60_000,
  })
})

test('direct upload cleanup limits stay positive and bounded', () => {
  const config = resolveCloudArtifactDirectUploadConfig({
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_BATCH_SIZE: '999999',
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS: '-1',
  })
  assert.equal(config.cleanupBatchSize, 100)
  assert.equal(config.cleanupIntervalMs, 60_000)
})
