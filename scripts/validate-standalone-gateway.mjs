import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const requiredFiles = [
  'apps/standalone-gateway/package.json',
  'apps/standalone-gateway/src/config.ts',
  'apps/standalone-gateway/src/opencode.ts',
  'apps/standalone-gateway/src/postgres-repository.ts',
  'apps/standalone-gateway/src/runtime.ts',
  'apps/standalone-gateway/src/server.ts',
  'docs/standalone-gateway.md',
  'deploy/standalone-gateway/README.md',
  'deploy/standalone-gateway/standalone.env.example',
]

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) throw new Error(`Missing standalone gateway artifact: ${file}`)
}

const cloudGatewayPackage = read('apps/gateway/package.json')
if (cloudGatewayPackage.includes('@opencode-ai/sdk') || cloudGatewayPackage.includes('"pg"')) {
  throw new Error('Cloud Channel Gateway package must not depend on OpenCode SDK or Postgres.')
}

const standalonePackage = read('apps/standalone-gateway/package.json')
for (const dependency of ['@opencode-ai/sdk', 'pg', '@open-cowork/gateway-provider-telegram', '@open-cowork/gateway-provider-webhook']) {
  if (!standalonePackage.includes(dependency)) throw new Error(`Standalone Gateway package must declare ${dependency}`)
}

const productContract = read('docs/product-contract.md')
for (const phrase of [
  'Standalone Team Gateway is a separate Gateway product mode and execution authority',
  'must not expose a public OpenCode port',
  'Gateway Postgres/control-plane state',
]) {
  if (!productContract.includes(phrase)) throw new Error(`Product contract must mention: ${phrase}`)
}

const standaloneDocs = read('docs/standalone-gateway.md')
for (const phrase of [
  'Gateway-only',
  'private OpenCode',
  'Postgres',
  'doctor',
  'smoke',
  'backup',
  'retention',
]) {
  if (!standaloneDocs.includes(phrase)) throw new Error(`Standalone Gateway docs must mention: ${phrase}`)
}

const networkPolicy = read('apps/standalone-gateway/src/network-policy.ts')
for (const phrase of ['public OpenCode endpoint', 'wildcard address', 'loopback/private']) {
  if (!networkPolicy.includes(phrase)) throw new Error(`Standalone network policy must guard ${phrase}`)
}

process.stdout.write('[standalone-gateway-validate] standalone gateway artifacts passed static validation\n')

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}
