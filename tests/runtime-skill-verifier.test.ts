import { compareRuntimeSkills } from '@open-cowork/runtime-host/runtime-skill-verifier'
import test from 'node:test'
import assert from 'node:assert/strict'
test('compareRuntimeSkills reports missing configured skills from the OpenCode SDK catalog', () => {
  const result = compareRuntimeSkills(
    ['analyst', 'chart-creator', 'analyst'],
    [
      { name: 'chart-creator' },
      { name: 'skill-creator' },
    ],
  )

  assert.deepEqual(result.expected, ['analyst', 'chart-creator'])
  assert.deepEqual(result.available, ['chart-creator', 'skill-creator'])
  assert.deepEqual(result.missing, ['analyst'])
})
