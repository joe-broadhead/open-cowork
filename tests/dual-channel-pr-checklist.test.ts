import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateDualChannelChecklist,
  isDurableChannelPath,
  isMonorepoProviderPath,
  isSharedChannelSecurityPath,
  shouldRequireDualChannelChecklist,
} from '../scripts/check-dual-channel-pr-checklist.mjs'

test('path classifiers cover durable, monorepo, and shared security surfaces', () => {
  assert.equal(isDurableChannelPath('products/gateway/src/channels/whatsapp.ts'), true)
  assert.equal(isDurableChannelPath('products/gateway/src/server.ts'), false)
  assert.equal(isMonorepoProviderPath('packages/gateway-provider-telegram/src/telegram-provider.ts'), true)
  assert.equal(isMonorepoProviderPath('packages/gateway-channel/src/webhook-rate-limiter.ts'), true)
  assert.equal(isMonorepoProviderPath('packages/shared/src/index.ts'), false)
  assert.equal(isSharedChannelSecurityPath('packages/shared/src/node/channel-webhook-security.ts'), true)
  assert.equal(isSharedChannelSecurityPath('scripts/check-dual-channel-security.mjs'), true)
})

test('gate activates for shared security, both stacks, or either stack alone', () => {
  assert.equal(
    shouldRequireDualChannelChecklist(['docs/getting-started.md']).active,
    false,
  )
  assert.equal(
    shouldRequireDualChannelChecklist([
      'packages/shared/src/node/channel-webhook-security.ts',
    ]).active,
    true,
  )
  assert.equal(
    shouldRequireDualChannelChecklist([
      'products/gateway/src/channels/discord.ts',
      'packages/gateway-provider-discord/src/discord-provider.ts',
    ]).active,
    true,
  )
  assert.equal(
    shouldRequireDualChannelChecklist(['products/gateway/src/channels/whatsapp.ts']).active,
    true,
  )
  assert.equal(
    shouldRequireDualChannelChecklist([
      'packages/gateway-provider-slack/src/slack-provider.ts',
    ]).active,
    true,
  )
})

test('checklist accepts N/A, full dual review, single-stack + notes, or explicit exempt', () => {
  assert.equal(
    evaluateDualChannelChecklist(`
## Dual-channel security checklist
- [x] N/A — not a channel security/protocol change
`).ok,
    true,
  )

  assert.equal(
    evaluateDualChannelChecklist(`
- [x] Reviewed **monorepo providers** (\`packages/gateway-provider-*\`)
- [x] Reviewed **Durable Gateway channels** (\`products/gateway/src/channels/*\`)
- [x] Shared primitives preferred
- [x] Both stacks fixed **or** explicit single-stack ownership noted in Notes with follow-up
`).ok,
    true,
  )

  assert.equal(
    evaluateDualChannelChecklist(`
- [x] Reviewed **Durable Gateway channels** (\`products/gateway/src/channels/*\`)
## Notes
- single-stack ownership: Durable only; monorepo N/A for this webhook path
`).ok,
    true,
  )

  assert.equal(
    evaluateDualChannelChecklist(`
## Notes
Dual-stack checklist: exempt — docs-only tweak to ownership matrix wording
`).ok,
    true,
  )

  assert.equal(
    evaluateDualChannelChecklist(`
- [ ] N/A — not a channel security/protocol change
- [ ] Reviewed **monorepo providers**
`).ok,
    false,
  )

  assert.equal(evaluateDualChannelChecklist('').ok, false)
})
