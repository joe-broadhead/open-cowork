#!/usr/bin/env node
/**
 * JOE-840: Compose product-mode config schema fragments into the packaged root.
 *
 * Source of truth (read these, edit these):
 *   schemas/config/desktop-core.schema.json
 *   schemas/config/cloud.schema.json
 *   schemas/config/gateway.schema.json
 *
 * Output (packaged / Ajv runtime path):
 *   open-cowork.config.schema.json
 *
 * Usage: node scripts/compose-config-schema.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
}

const desktop = readJson('schemas/config/desktop-core.schema.json')
const cloud = readJson('schemas/config/cloud.schema.json')
const gateway = readJson('schemas/config/gateway.schema.json')

const composed = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Open Cowork Config',
  description: [
    'Thin product-mode compositor (JOE-840). Surfaces live under schemas/config/:',
    'desktop-core (default local product), cloud (control plane + cloudDesktop),',
    'gateway (channel/standalone). Edit the surface fragments, then run',
    '`node scripts/compose-config-schema.mjs` to refresh this packaged root.',
  ].join(' '),
  type: 'object',
  additionalProperties: false,
  // Surface map lives in description + schemas/config/* (Ajv strict mode
  // rejects unknown x-* keywords).
  properties: {
    ...desktop.properties,
    ...cloud.properties,
    ...gateway.properties,
  },
  required: desktop.required || [],
  $defs: {
    ...desktop.$defs,
    ...cloud.$defs,
    ...gateway.$defs,
  },
}

const outputPath = join(root, 'open-cowork.config.schema.json')
const serialized = `${JSON.stringify(composed, null, 2)}\n`

if (checkOnly) {
  const existing = readFileSync(outputPath, 'utf8')
  if (existing !== serialized) {
    console.error(
      'open-cowork.config.schema.json is stale. Run: node scripts/compose-config-schema.mjs',
    )
    process.exit(1)
  }
  console.log('[compose-config-schema] ok — packaged root matches surface fragments')
  process.exit(0)
}

writeFileSync(outputPath, serialized)
console.log(
  `[compose-config-schema] wrote open-cowork.config.schema.json (${Object.keys(composed.properties).length} properties, ${Object.keys(composed.$defs).length} $defs)`,
)
