#!/usr/bin/env node
/**
 * JOE-932 (light): fail closed if Durable Gateway re-implements native Meta /
 * Discord webhook verify instead of importing the shared kernel.
 *
 * Not a full dual-stack CI bot — only catches copy-paste regressions on the
 * highest-risk security paths after JOE-934.
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8')
}

const whatsapp = read('products/gateway/src/channels/whatsapp.ts')
if (!whatsapp.includes("from '@open-cowork/shared/node'") && !whatsapp.includes('from "@open-cowork/shared/node"')) {
  failures.push('whatsapp.ts must import @open-cowork/shared/node')
}
if (!whatsapp.includes('verifyMetaHubSignature256')) {
  failures.push('whatsapp.ts must use verifyMetaHubSignature256 from the shared kernel')
}
if (/createHmac\s*\(\s*['"]sha256['"]/.test(whatsapp)) {
  failures.push('whatsapp.ts must not re-implement Meta HMAC locally (use shared kernel)')
}

const discord = read('products/gateway/src/channels/discord.ts')
if (!discord.includes('verifyDiscordInteractionSignature')) {
  failures.push('discord.ts must use verifyDiscordInteractionSignature from the shared kernel')
}
if (/createPublicKey\s*\(/.test(discord) && /verify\s+as\s+verifySignature/.test(discord)) {
  failures.push('discord.ts must not re-implement Ed25519 verify locally (use shared kernel)')
}

const kernel = read('packages/shared/src/node/channel-webhook-security.ts')
for (const symbol of [
  'verifyMetaHubSignature256',
  'verifyMetaHubVerifyToken',
  'verifyDiscordInteractionSignature',
  'verifyTelegramWebhookSecretToken',
]) {
  if (!kernel.includes(`export function ${symbol}`)) {
    failures.push(`shared channel-webhook-security missing export ${symbol}`)
  }
}

if (failures.length) {
  console.error('Dual-channel security kernel drift:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
console.log('Dual-channel security kernel wiring OK')
