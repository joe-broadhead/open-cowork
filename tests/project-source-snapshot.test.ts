import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildCloudProjectSnapshotInventory,
  buildCloudProjectSnapshotUpload,
} from '../apps/desktop/src/main/project-source-snapshot.ts'

test('cloud project snapshot inventory excludes secrets and generated dependency folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-snapshot-'))
  await writeFile(join(root, 'README.md'), 'hello')
  await writeFile(join(root, '.env'), 'SECRET=value')
  await writeFile(join(root, '.git-credentials'), 'https://token@example.test')
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'package.js'), 'generated')
  await mkdir(join(root, '.ssh'), { recursive: true })
  await writeFile(join(root, '.ssh', 'id_ed25519'), 'key')

  const inventory = await buildCloudProjectSnapshotInventory(root)

  assert.deepEqual(inventory.files, [{ path: 'README.md', byteCount: 5 }])
  assert.equal(inventory.excluded.some((entry) => entry.path === '.env' && /secret/i.test(entry.reason)), true)
  assert.equal(inventory.excluded.some((entry) => entry.path === '.git-credentials' && /secret/i.test(entry.reason)), true)
  assert.equal(inventory.excluded.some((entry) => entry.path === 'node_modules' && /dependency/i.test(entry.reason)), true)
  assert.equal(inventory.excluded.some((entry) => entry.path === '.ssh' && /secret/i.test(entry.reason)), true)
  assert.equal(inventory.warnings.some((entry) => /Secret-bearing/i.test(entry)), true)
})

test('cloud project snapshot upload contains only inventoried files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-upload-'))
  await writeFile(join(root, 'README.md'), 'hello')
  await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=secret')

  const upload = await buildCloudProjectSnapshotUpload(root)

  assert.equal(upload.fileCount, 1)
  assert.equal(upload.byteCount, 5)
  assert.deepEqual(upload.files.map((file) => file.path), ['README.md'])
  assert.equal(Buffer.from(upload.files[0]!.dataBase64, 'base64').toString('utf8'), 'hello')
})
