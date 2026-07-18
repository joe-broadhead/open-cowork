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

const cloudGatewayPackage = read('apps/channel-gateway/package.json')
if (cloudGatewayPackage.includes('@opencode-ai/sdk') || cloudGatewayPackage.includes('"pg"')) {
  throw new Error('Cloud Channel Gateway package must not depend on OpenCode SDK or Postgres.')
}

const standalonePackage = read('apps/standalone-gateway/package.json')
for (const dependency of ['@opencode-ai/sdk', 'pg', '@open-cowork/shared', '@open-cowork/gateway-provider-telegram', '@open-cowork/gateway-provider-webhook']) {
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
  'OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS',
  'OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT',
  'OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_EXECUTION_TIMEOUT_MS',
]) {
  if (!standaloneDocs.includes(phrase)) throw new Error(`Standalone Gateway docs must mention: ${phrase}`)
}

assertPublicSafeStandaloneEnv(read('deploy/standalone-gateway/standalone.env.example'))

// Product wrapper owns OpenCode-facing wording; shared private-host policy owns
// the generic wildcard / private-host checks (audit 2026-07-18 DRY).
const networkPolicy = read('apps/standalone-gateway/src/network-policy.ts')
const sharedHostPolicy = read('packages/shared/src/node/private-host-policy.ts')
const networkPolicySurface = `${networkPolicy}\n${sharedHostPolicy}`
for (const phrase of ['public OpenCode endpoint', 'wildcard address', 'loopback/private']) {
  if (!networkPolicySurface.includes(phrase)) {
    throw new Error(`Standalone network policy must guard ${phrase}`)
  }
}

process.stdout.write('[standalone-gateway-validate] standalone gateway artifacts passed static validation\n')

function read(file) {
  return readFileSync(join(root, file), 'utf8')
}

function assertPublicSafeStandaloneEnv(contents) {
  for (const variable of [
    'OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS=false',
    'OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS=',
    'OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT=/var/lib/open-cowork/standalone-gateway',
    'OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_EXECUTION_TIMEOUT_MS=900000',
  ]) {
    if (!contents.includes(variable)) {
      throw new Error(`deploy/standalone-gateway/standalone.env.example must include ${variable}`)
    }
  }

  const forbiddenPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /\bxoxb-[A-Za-z0-9-]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{20,}\b/,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  ]
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(contents)) {
      throw new Error(`Standalone Gateway env example appears to contain private material matching ${pattern}`)
    }
  }

  const sensitiveAssignmentPattern = /^[ \t]*([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)[ \t]*=[ \t]*([^\n#]*)/gm
  for (const match of contents.matchAll(sensitiveAssignmentPattern)) {
    const [, name, rawValue] = match
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '')
    if (!isPublicPlaceholderValue(value)) {
      throw new Error(`deploy/standalone-gateway/standalone.env.example must not assign a private value to ${name}`)
    }
  }
}

function isPublicPlaceholderValue(value) {
  if (!value || value === '...' || value.includes('...')) return true
  if (value.startsWith('${') || value.startsWith('<')) return true
  return [
    'PASSWORD',
    'REPLACE',
    'change-me',
    'example.',
    'localhost',
    'replace-with',
  ].some((placeholder) => value.includes(placeholder))
}
