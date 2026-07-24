/**
 * JOE-994 Phase 1: dual-stack protocol capability contract conformance.
 * No operator behavior change — compares Durable matrices + monorepo providers
 * against the shared vocabulary in `@open-cowork/shared`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNEL_ADAPTER_CAPABILITY_KEYS,
  DUAL_STACK_OVERLAP_PROVIDERS,
  isCompleteAdapterCategoryMatrix,
  mapMonorepoCapabilitiesToAdapterCategories,
  monorepoCapabilitiesMissingKeys,
} from '@open-cowork/shared'

const root = process.cwd()
const gatewayChannelDist = join(root, 'packages/gateway-channel/dist/index.js')
const telegramDist = join(root, 'packages/gateway-provider-telegram/dist/index.js')
const discordDist = join(root, 'packages/gateway-provider-discord/dist/index.js')

function requireDist(path: string, label: string) {
  if (!existsSync(path)) {
    throw new Error(`${label} missing at ${path}; run pnpm --filter ${label} build`)
  }
}

test('shared and Durable capability category keys stay lockstep', async () => {
  const durable = await import('../products/gateway/src/channels/capabilities.ts')
  assert.deepEqual([...durable.CHANNEL_ADAPTER_CAPABILITY_KEYS], [...CHANNEL_ADAPTER_CAPABILITY_KEYS])
})

test('Durable overlap providers declare complete category matrices', async () => {
  const {
    CHANNEL_CAPABILITY_REGISTRY,
    DISCORD_ALPHA_CAPABILITIES,
    telegramAdapterCapabilities,
    WHATSAPP_CAPABILITIES,
  } = await import('../products/gateway/src/channels/capabilities.ts')

  const durableByProvider: Record<string, { categories?: Record<string, { status?: string }> }> = {
    telegram: telegramAdapterCapabilities(),
    whatsapp: WHATSAPP_CAPABILITIES,
    discord: DISCORD_ALPHA_CAPABILITIES,
  }

  for (const provider of DUAL_STACK_OVERLAP_PROVIDERS) {
    const caps = durableByProvider[provider]
    assert.ok(caps, `missing Durable capabilities for ${provider}`)
    assert.ok(
      isCompleteAdapterCategoryMatrix(caps.categories),
      `${provider} Durable categories incomplete: ${JSON.stringify(caps.categories && Object.keys(caps.categories))}`,
    )
    if (provider === 'telegram' || provider === 'whatsapp') {
      assert.ok(CHANNEL_CAPABILITY_REGISTRY[provider], `registry missing ${provider}`)
    }
  }
})

test('monorepo overlap providers satisfy dual-stack monorepo capability contract', async () => {
  requireDist(gatewayChannelDist, '@open-cowork/gateway-channel')
  requireDist(telegramDist, '@open-cowork/gateway-provider-telegram')
  requireDist(discordDist, '@open-cowork/gateway-provider-discord')

  const { assertMonorepoProviderCapabilities, reportMonorepoProviderCapabilities } = await import(gatewayChannelDist)
  const { TelegramProvider } = await import(telegramDist)
  const { DiscordProvider } = await import(discordDist)

  const telegram = new TelegramProvider({
    botToken: '000000000:AAFaketokenforcontracttest1234567890',
    mode: 'polling',
    respondInGroups: 'commands_only',
    observeUnmentionedGroupMessages: false,
  })
  assertMonorepoProviderCapabilities('telegram', telegram.capabilities)
  const telegramReport = reportMonorepoProviderCapabilities('telegram', telegram.capabilities)
  assert.equal(telegramReport.categoryMap.threading, 'supported')

  const discord = new DiscordProvider({
    deliveryUrl: 'https://bridge.example.test/discord',
    sharedSecret: 'discord-bridge-shared-secret-for-contract-test',
  })
  assertMonorepoProviderCapabilities('discord', discord.capabilities)

  const mapped = mapMonorepoCapabilitiesToAdapterCategories({
    threads: false,
    messageEditing: false,
    inlineButtons: false,
    fileUploads: true,
    fileDownloads: false,
    typingIndicator: false,
    maxTextLength: 4096,
    preferredParseMode: 'plain',
  })
  assert.equal(mapped.filesMedia, 'supported')
  assert.equal(mapped.threading, 'unsupported')
  assert.deepEqual(monorepoCapabilitiesMissingKeys({
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: true,
    maxTextLength: 100,
    preferredParseMode: 'plain',
  }), [])
})
