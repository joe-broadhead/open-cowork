import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Ajv2020 from 'ajv/dist/2020.js'

import { validateResolvedConfig } from '@open-cowork/runtime-host'

const root = process.cwd()

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>
}

test('JOE-840: packaged config schema is composed from product-mode surfaces', () => {
  const check = spawnSync(process.execPath, ['scripts/compose-config-schema.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(check.status, 0, check.stderr || check.stdout)

  const composed = readJson('open-cowork.config.schema.json')
  assert.match(String(composed.description || ''), /desktop-core/)
  assert.match(String(composed.description || ''), /JOE-840/)

  const desktop = readJson('schemas/config/desktop-core.schema.json')
  const cloud = readJson('schemas/config/cloud.schema.json')
  const gateway = readJson('schemas/config/gateway.schema.json')

  // Desktop-core must not declare cloud/gateway product trees (false coupling).
  const desktopProps = desktop.properties as Record<string, unknown>
  assert.equal('cloud' in desktopProps, false)
  assert.equal('cloudDesktop' in desktopProps, false)
  assert.equal('gateway' in desktopProps, false)

  // Cloud and gateway surfaces stay isolated to their trees.
  assert.deepEqual(Object.keys(cloud.properties as object).sort(), ['cloud', 'cloudDesktop'])
  assert.deepEqual(Object.keys(gateway.properties as object).sort(), ['gateway'])

  // Composed root merges surfaces without losing keys.
  const composedProps = Object.keys(composed.properties as object).sort()
  const merged = [
    ...Object.keys(desktopProps),
    ...Object.keys(cloud.properties as object),
    ...Object.keys(gateway.properties as object),
  ].sort()
  assert.deepEqual(composedProps, merged)
})

test('JOE-840: desktop-core schema validates a desktop-only config without cloud trees', () => {
  const desktop = readJson('schemas/config/desktop-core.schema.json')
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true })
  const validate = ajv.compile(desktop)

  // Strip cloud/gateway product trees from the repo root config — the remainder
  // is a desktop-core document.
  const full = readJson('open-cowork.config.json')
  const { cloud: _cloud, cloudDesktop: _cloudDesktop, gateway: _gateway, ...desktopOnly } = full as {
    cloud?: unknown
    cloudDesktop?: unknown
    gateway?: unknown
    [key: string]: unknown
  }
  assert.equal(validate(desktopOnly), true, JSON.stringify(validate.errors))

  // Cloud-only keys are rejected by desktop-core (additionalProperties: false).
  assert.equal(validate({ ...desktopOnly, cloud: { enabled: true } }), false)
})

test('JOE-840: full composed schema still validates the repo root config', () => {
  const config = readJson('open-cowork.config.json')
  assert.doesNotThrow(() => validateResolvedConfig(config, 'open-cowork.config.json'))
})
