#!/usr/bin/env node
/**
 * JOE-994: fail closed if dual-stack channel protocol inventory drifts from
 * the freeze ownership model. Does not require unification to be complete.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptLog = (...args) => {
  process.stdout.write(args.map(String).join(' ') + String.fromCharCode(10))
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function mustExist(rel, label = rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) failures.push(`missing ${label}: ${rel}`)
  return abs
}

function mustContain(rel, needle) {
  const abs = mustExist(rel)
  if (!existsSync(abs)) return
  const text = readFileSync(abs, 'utf8')
  if (!text.includes(needle)) failures.push(`${rel} must include ${JSON.stringify(needle)}`)
}

// Freeze docs
mustExist('docs/product-channel-ownership.md')
mustExist('docs/product-channel-protocol-unification.md')
mustContain('docs/product-channel-ownership.md', 'Protocol / adapter body')
mustContain('docs/product-channel-ownership.md', 'Intentional residual freeze')
mustContain('docs/product-channel-protocol-unification.md', 'JOE-994')
mustContain('docs/product-channel-protocol-unification.md', 'protocol freeze retained')

// Durable stack roots
const durableChannels = mustExist('products/gateway/src/channels')
for (const name of ['telegram.ts', 'whatsapp.ts', 'discord.ts', 'provider.ts']) {
  mustExist(`products/gateway/src/channels/${name}`)
}

// JOE-994 Phase 2–3: monorepo façades + stack selectors + shared policy
for (const name of [
  'telegram-monorepo-adapter.ts',
  'telegram-protocol-stack.ts',
  'telegram-inbound-policy.ts',
  'channel-inbound-policy.ts',
  'discord-monorepo-adapter.ts',
  'discord-protocol-stack.ts',
  'whatsapp-monorepo-adapter.ts',
  'whatsapp-protocol-stack.ts',
  'bridge-protocol-stack.ts',
]) {
  mustExist(`products/gateway/src/channels/${name}`)
}
mustContain('docs/product-channel-protocol-unification.md', 'Phase 2')
mustContain('docs/product-channel-protocol-unification.md', 'Phase 3')
mustContain('docs/product-channel-ownership.md', 'Protocol stack façades')

// Monorepo provider packages (at least the production set)
const providerRoot = mustExist('packages')
const providers = readdirSync(providerRoot)
  .filter((name) => name.startsWith('gateway-provider-'))
  .filter((name) => {
    try {
      return statSync(join(providerRoot, name)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

const requiredProviders = [
  'gateway-provider-telegram',
  'gateway-provider-discord',
  'gateway-provider-slack',
]
for (const name of requiredProviders) {
  if (!providers.includes(name)) failures.push(`missing monorepo provider package: packages/${name}`)
  else mustExist(`packages/${name}/src`)
}

mustExist('packages/gateway-channel/src')
mustExist('apps/channel-gateway')
mustExist('apps/standalone-gateway')

// Security guards still present (do not replace with protocol unification)
mustExist('scripts/check-dual-channel-security.mjs')
mustExist('scripts/check-dual-channel-pr-checklist.mjs')

if (failures.length) {
  console.error('Channel protocol inventory check failed:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}

scriptLog(`Channel protocol inventory OK (durable channels + ${providers.length} gateway-provider-* packages; freeze retained)`)
scriptLog(`Durable root: products/gateway/src/channels (${readdirSync(durableChannels).filter((n) => n.endsWith('.ts')).length} ts files)`)
scriptLog(`Providers: ${providers.join(', ')}`)
