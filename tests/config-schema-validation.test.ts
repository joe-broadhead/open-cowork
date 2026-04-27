import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'fs'
import { validateResolvedConfig } from '../apps/desktop/src/main/config-schema.ts'

test('root open-cowork.config.json validates against the public schema', () => {
  const config = JSON.parse(readFileSync('open-cowork.config.json', 'utf-8'))
  assert.doesNotThrow(() => validateResolvedConfig(config, 'open-cowork.config.json'))
})
