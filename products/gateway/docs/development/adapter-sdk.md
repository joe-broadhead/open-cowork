# Adapter SDK

The adapter SDK path is a small, generic starting point for the next channel adapter. Use it when starting a new provider, improving WhatsApp, or adding another surface. Keep product behavior in Gateway core modules and keep provider behavior inside the adapter.

## Implementation Shape

Start from the existing adapters under `src/channels/` (`telegram.ts`, `whatsapp.ts`, `discord.ts`). A well-shaped adapter:

- declares capabilities with `defineChannelCapabilities()`;
- declares connector onboarding metadata for setup states, credentials, trust, and diagnostics;
- sends text, structured messages, and command menus through the shared renderer path;
- normalizes inbound text and action payloads into `ChannelMessage`;
- rejects inbound events until authentication and target authorization hooks pass;
- reports unsupported or planned capabilities with fallback guidance.

Copy the shape, not the provider name. A real adapter should use stable provider IDs, real webhook or polling authentication, provider target allowlists, and provider-specific send APIs.

## Capability Declaration

Every adapter must expose a complete `ChannelCapabilities` declaration:

```ts
import { defineChannelCapabilities } from '../channels/capabilities.js'

export const MY_CHANNEL_CAPABILITIES = defineChannelCapabilities({
  provider: 'my-channel',
  displayName: 'My Channel',
  stage: 'alpha',
  render: {
    plainText: true,
    markdown: true,
    buttons: true,
  },
  categories: {
    richText: { status: 'supported', summary: 'Markdown-safe text is supported.' },
    richCards: { status: 'planned', summary: 'Native cards need parity tests first.', fallback: 'Use Markdown/plain text.' },
    inlineActions: { status: 'partial', summary: 'Native controls carry Gateway command payloads.', fallback: 'Show slash commands in text.' },
    callbacks: { status: 'partial', summary: 'Callbacks normalize to Gateway command payloads.', fallback: 'Users can type the command.' },
    filesMedia: { status: 'unsupported', summary: 'Media is not brokered yet.', fallback: 'Render safe links as text.' },
    threading: { status: 'partial', summary: 'Thread IDs are preserved when the provider supplies them.', fallback: 'Use chatId-only targets.' },
    identityBinding: { status: 'partial', summary: 'Stable provider user IDs are required.', fallback: 'Reject events without stable identity.' },
    deepLinks: { status: 'partial', summary: 'Links are preserved in text or controls.', fallback: 'Show URLs in text.' },
    notifications: { status: 'partial', summary: 'Gateway notifications use the adapter send path.', fallback: 'Use sendMessage().' },
    edits: { status: 'unsupported', summary: 'Edits need safe prior message id and audit semantics.', fallback: 'Send a follow-up message.' },
    deletes: { status: 'unsupported', summary: 'Deletes need explicit authorization and audit semantics.', fallback: 'Send corrections instead.' },
    fallbackBehavior: { status: 'supported', summary: 'All structured output degrades through renderStructuredMessage().' },
  },
  fallback: {
    order: ['markdown', 'plainText'],
    maxChars: 4000,
    semantics: ['Preserve action command payloads, facts, details, tables, and safe links.'],
  },
  onboarding: {
    modes: ['webhook'],
    states: [
      'not_configured',
      'credentials_needed',
      'provider_connected',
      'webhook_needed',
      'verification_pending',
      'trusted_target_pending',
      'bound',
      'ready',
      'degraded',
      'blocked',
    ],
    actions: ['connect', 'verify', 'trust', 'bind', 'repair', 'disconnect'],
    credentials: [
      {
        key: 'my_channel_api_token',
        label: 'My Channel API token',
        source: 'providerConsole',
        secret: true,
        env: 'MY_CHANNEL_API_TOKEN',
        configKey: 'channels.myChannel.apiToken',
        summary: 'Provider token used for outbound sends and provider API checks.',
      },
    ],
    webhook: {
      routes: [{ method: 'POST', path: '/webhooks/my-channel', purpose: 'Signed inbound provider events.' }],
      signature: 'supported',
      challenge: 'Use provider challenge or signature verification before handler invocation.',
      publicExposure: 'Expose only the provider webhook route; keep other Gateway routes local or capability-protected.',
    },
    trust: {
      summary: 'Trust stable provider targets explicitly before any Gateway state mutation.',
      allowlistConfigKey: 'security.channelAllowlists.myChannel',
      targetIdRedaction: 'required',
      modes: [
        { mode: 'manualAllowlist', status: 'supported', summary: 'Operators can configure trusted targets directly.' },
        { mode: 'claimCode', status: 'planned', summary: 'Claim codes can avoid copying raw target IDs once implemented.', fallback: 'Use manual allowlist.' },
      ],
    },
    diagnostics: [
      { code: 'missing_credentials', state: 'credentials_needed', severity: 'blocked', summary: 'Provider token is missing.', remediation: 'Set MY_CHANNEL_API_TOKEN or local config.' },
      { code: 'missing_allowlist', state: 'trusted_target_pending', severity: 'blocked', summary: 'No trusted target is configured.', remediation: 'Add an allowlist entry or use claim code setup when available.' },
    ],
  },
})
```

Unsupported and planned categories are useful. They tell Gateway authors what not to assume, and the contract suite verifies that every unsupported category has fallback notes.

## Onboarding Declaration

Every adapter must also declare `onboarding` metadata. This keeps setup UX provider-neutral:

- `modes` identifies polling, webhook, local, embedded signup, or provider-managed setup.
- `states` maps the provider into the universal connector state machine.
- `actions` lists the shared setup actions the UX may offer: connect, verify, trust, bind, repair, disconnect.
- `credentials` names required env/config keys and marks secret values for redaction.
- `webhook` names callback routes and signature/challenge requirements.
- `trust` describes manual allowlist, claim-code, local-session, or provider-install trust paths.
- `diagnostics` gives stable, redaction-safe codes and remediations.

Do not put real provider IDs, phone numbers, tokens, app secrets, signatures, or private transcript text in onboarding declarations. The declarations are safe product metadata; runtime status later combines them with local config and evidence.

## Provider Family Templates

All provider families inherit the same user journey: Connect -> Verify -> Trust -> Bind. Provider-specific docs, buttons, or setup pages may change the mechanics, but they should not rename the steps or skip Gateway trust.

### Slack-Like Webhook Providers

Use the `webhook` archetype for providers with signed HTTP callbacks and native interactions:

- `modes`: `webhook`; add `providerManaged` only if app installation discovers workspace context.
- `webhook`: list the exact Gateway callback routes and signature/challenge posture.
- `credentials`: include app/bot tokens and signing secrets as redacted metadata only.
- `trust`: require explicit channel/thread trust and include `claimCode` as planned or supported when the provider can safely echo a claim.

### Matrix-Like Polling Providers

Use the `polling` archetype for homeserver sync, long polling, or provider streams:

- `modes`: `polling`.
- `states`: include `polling_ready` after provider credentials are present and before trust.
- `credentials`: name access token or appservice config keys without sample values.
- `trust`: trust stable room/channel IDs, optionally with thread scope when the provider distinguishes threads.
- `diagnostics`: include `missing_credentials`, `missing_allowlist`, and `binding_missing`.

### Discord-Like Interaction Providers

Use `webhook` plus `providerManaged` when a provider has both signed interactions and app installation:

- keep provider app install separate from Gateway target trust;
- preserve interaction custom IDs as `MessageAction.command` payloads;
- include signature verification diagnostics before any handler invocation;
- document guild/workspace IDs only as mapping rules, never as example values.

### Custom Enterprise Channels

Start from the archetype that matches the transport, then add enterprise-specific constraints as diagnostics instead of new setup language:

- SSO or admin approval becomes `credentials_needed`, `provider_auth_failed`, or `provider_unavailable` diagnostics.
- Private network or callback routing becomes `callback_url_missing` or `unsafe_route_exposure` diagnostics.
- Tenant/workspace approval may discover candidate targets, but Gateway still requires `trust` and `bind`.
- If provider identifiers are sensitive, store only redacted evidence refs and keep `targetIdRedaction: 'required'`.

## Renderer Path

Domain code should produce `StructuredGatewayMessage` values. Adapters should call `renderStructuredMessage(message, capabilities)` and send the selected mode:

```ts
const rendered = renderStructuredMessage(message, adapter.capabilities)

if (rendered.mode === 'rich') {
  await sendNativeCard(chatId, rendered.richBlocks, rendered.actions)
} else {
  await adapter.sendMessage(chatId, rendered.text, options)
}
```

If provider-native rich delivery fails, retry with `rendered.markdown || rendered.plainText`. Do not drop notifications because a native card, embed, list, or component send failed.

## Actions And Callbacks

Native controls and typed fallback commands are the same command surface:

- `MessageAction.command` must become the provider callback ID, list row ID, button payload, or equivalent.
- `MessageAction.url` may become a native URL control, with the URL preserved in fallback text.
- Callback events must normalize back into `ChannelMessage.text` as the command payload.
- Command menus should use shared command definitions, not provider-only product commands.

Prove parity in the adapter's test file: render the native controls for a structured message and assert the identifiers equal the identifiers extracted from the rendered fallback text (see `src/__tests__/discord.test.ts` and `src/__tests__/helpers/adapter-fixtures.ts` for a working example).

## Fixture Pack

Shared test fixtures live in `src/__tests__/helpers/adapter-fixtures.ts` (a rich-card fixture plus fallback action-identifier helpers). Add adapter-specific fixtures next to the adapter's test file, and run the focused provider suites before enabling a new adapter:

```sh
npx vitest run src/__tests__/telegram.test.ts src/__tests__/discord.test.ts
```

## Security Checklist

Before an adapter calls the Gateway handler with inbound traffic:

- verify webhook signatures, challenge tokens, polling credentials, or interaction signatures;
- normalize only stable provider IDs into `provider`, `chatId`, `threadId`, `messageId`, and `userId`;
- require `isTrustedChannelTarget(provider, chatId, threadId, config)` before context resolution, binding mutation, or command execution;
- map action callbacks to command payloads, never display labels, raw JSON, or provider-private state;
- redact provider response bodies, signatures, bearer tokens, bot tokens, media IDs, and app secrets before logs or events;
- avoid fake production credentials in examples, tests, screenshots, or docs;
- leave sync checkpoints unadvanced when delivery fails;
- prefer follow-up messages over edits/deletes until safe prior-message ID, audit, and authorization semantics are documented.

## Implementation Checklist

- Add the adapter module under `src/channels/`.
- Declare capabilities with honest supported, partial, planned, and unsupported categories.
- Declare onboarding metadata with setup modes, states, credentials, trust model, and redaction-safe diagnostics.
- Implement `start()`, `stop()`, `sendMessage()`, and `onMessage()`.
- Add `sendStructuredMessage()` and `sendCommandMenu()` only when they preserve fallback parity.
- Normalize inbound text, callbacks, attachments, and timestamps into `ChannelMessage`.
- Document provider ID mapping and configuration in channel docs.
- Register `describeChannelAdapterContract()` for the adapter.
- Add focused tests for webhook/auth rejection, target trust, renderer fallback, action parity, redaction, and provider send failures.
- Run adapter tests, typecheck, full tests, build, and docs build before opening a PR.
