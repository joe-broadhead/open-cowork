import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceMapMaxSize, setBoundedMapEntry } from '@open-cowork/runtime-host/bounded-map'
import {
  MAX_APPROVED_SKILL_IMPORT_DIRECTORIES,
  rememberApprovedSkillImportDirectory,
} from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'

test('setBoundedMapEntry FIFO-evicts oldest keys under the cap (JOE-839)', () => {
  const map = new Map<string, number>()
  for (let index = 0; index < 5; index += 1) {
    setBoundedMapEntry(map, `k${index}`, index, 3)
  }
  assert.equal(map.size, 3)
  assert.equal(map.has('k0'), false)
  assert.equal(map.has('k1'), false)
  assert.equal(map.get('k2'), 2)
  assert.equal(map.get('k4'), 4)

  // Re-set moves an existing key to newest so it survives the next insert.
  setBoundedMapEntry(map, 'k2', 22, 3)
  setBoundedMapEntry(map, 'k5', 5, 3)
  assert.equal(map.has('k3'), false)
  assert.equal(map.get('k2'), 22)
  assert.equal(map.get('k5'), 5)
})

test('enforceMapMaxSize trims insertion-order oldest first', () => {
  const map = new Map<string, string>([
    ['a', '1'],
    ['b', '2'],
    ['c', '3'],
  ])
  enforceMapMaxSize(map, 1)
  assert.equal(map.size, 1)
  assert.equal(map.get('c'), '3')
})

test('approved skill import directory map bounds abandoned picker tokens (JOE-839)', () => {
  const map = new Map<string, string>()
  for (let index = 0; index < MAX_APPROVED_SKILL_IMPORT_DIRECTORIES + 10; index += 1) {
    rememberApprovedSkillImportDirectory(map, `token-${index}`, `/tmp/skill-${index}`)
  }
  assert.equal(map.size, MAX_APPROVED_SKILL_IMPORT_DIRECTORIES)
  assert.equal(map.has('token-0'), false)
  assert.equal(
    map.get(`token-${MAX_APPROVED_SKILL_IMPORT_DIRECTORIES + 9}`),
    `/tmp/skill-${MAX_APPROVED_SKILL_IMPORT_DIRECTORIES + 9}`,
  )
})
