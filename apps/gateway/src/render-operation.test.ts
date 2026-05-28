import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createButtonCapableFakeProvider,
  createButtonlessFakeProvider,
  createConstrainedMessageFakeProvider,
  createFileCapableFakeProvider,
} from '@open-cowork/gateway-testing'

import {
  executeRenderOperation,
  getGatewayRenderProfile,
  normalizeChannelCapabilities,
} from '../dist/index.js'

test('normalizes provider capabilities with render-operation defaults and overrides', () => {
  const normalized = normalizeChannelCapabilities({
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: false,
    typingIndicator: true,
    maxTextLength: 4096,
    preferredParseMode: 'markdown',
    parseModes: ['plain'],
    maxButtonsPerMessage: 3,
    maxButtonTokenBytes: 32,
    supportsEphemeralResponses: true,
  })

  assert.deepEqual(normalized.parseModes.sort(), ['markdown', 'plain'])
  assert.equal(normalized.maxButtonsPerMessage, 3)
  assert.equal(normalized.maxButtonRowsPerMessage, 4)
  assert.equal(normalized.maxButtonTokenBytes, 32)
  assert.equal(normalized.supportsEphemeralResponses, true)
})

test('render profile keeps provider identity separate from normalized capabilities', () => {
  const provider = createButtonCapableFakeProvider()
  const profile = getGatewayRenderProfile(provider)

  assert.equal(profile.providerId, 'cli')
  assert.equal(profile.capabilities.inlineButtons, true)
  assert.equal(profile.capabilities.maxButtonsPerMessage, 8)
})

test('capability matrix executes supported operations and rejects unsupported button/edit/file operations', async () => {
  const buttonCapable = createButtonCapableFakeProvider()
  const buttonless = createButtonlessFakeProvider()
  const noFile = createButtonlessFakeProvider({ capabilities: { fileDownloads: false } })
  const fileCapable = createFileCapableFakeProvider()
  const constrained = createConstrainedMessageFakeProvider()
  const target = { provider: 'cli' as const, chatId: 'chat-1', threadId: 'thread-1' }

  const text = await executeRenderOperation(buttonCapable, {
    type: 'send_text',
    target,
    text: 'hello',
  })
  assert.equal(text.handled, true)
  assert.equal(text.sentMessage?.messageId, '1')

  await executeRenderOperation(buttonCapable, {
    type: 'edit_text',
    target,
    messageId: text.sentMessage?.messageId ?? '1',
    text: 'hello edited',
  })
  assert.equal(buttonCapable.sent.at(-1)?.kind, 'edit')

  const buttons = await executeRenderOperation(buttonCapable, {
    type: 'send_buttons',
    target,
    text: 'approve?',
    buttons: [[{ label: 'Approve', token: 'approve-token', style: 'success' }]],
  })
  assert.equal(buttons.sentMessage?.messageId, '3')

  const typing = await executeRenderOperation(buttonCapable, {
    type: 'set_typing',
    target,
  })
  assert.equal(typing.handled, true)
  assert.equal(buttonCapable.typing.length, 1)

  const ack = await executeRenderOperation(buttonCapable, {
    type: 'acknowledge_interaction',
    interactionId: 'callback-1',
    text: 'Approved',
  })
  assert.equal(ack.handled, true)
  assert.deepEqual(buttonCapable.answered, [{ interactionId: 'callback-1', text: 'Approved', alert: undefined }])

  const file = await executeRenderOperation(fileCapable, {
    type: 'send_file',
    target,
    file: { filename: 'artifact.txt', data: new TextEncoder().encode('ok') },
  })
  assert.equal(file.sentMessage?.messageId, '1')

  const artifactLink = await executeRenderOperation(buttonless, {
    type: 'send_artifact_link',
    target,
    artifact: { filename: 'report.md', url: 'https://cloud.example.test/artifacts/report' },
  })
  assert.equal(artifactLink.handled, true)
  assert.equal(buttonless.sent[0]?.text, 'report.md: https://cloud.example.test/artifacts/report')

  const unsupportedTyping = await executeRenderOperation(buttonless, {
    type: 'set_typing',
    target,
  })
  assert.equal(unsupportedTyping.handled, false)
  assert.equal(unsupportedTyping.skippedReason, 'unsupported_capability')

  await assert.rejects(
    executeRenderOperation(buttonless, {
      type: 'send_buttons',
      target,
      text: 'approve?',
      buttons: [[{ label: 'Approve', token: 'approve-token' }]],
    }),
    /inline buttons/,
  )
  await assert.rejects(
    executeRenderOperation(buttonless, {
      type: 'edit_text',
      target,
      messageId: '1',
      text: 'edit',
    }),
    /message editing/,
  )
  await assert.rejects(
    executeRenderOperation(noFile, {
      type: 'send_file',
      target,
      file: { filename: 'artifact.txt', data: new Uint8Array() },
    }),
    /outgoing files/,
  )
  await assert.rejects(
    executeRenderOperation(constrained, {
      type: 'send_text',
      target,
      text: 'x'.repeat(129),
    }),
    /maxTextLength 128/,
  )
  await assert.rejects(
    executeRenderOperation(constrained, {
      type: 'send_buttons',
      target,
      text: 'approve?',
      buttons: [[{ label: 'Approve', token: 'x'.repeat(25) }]],
    }),
    /maxButtonTokenBytes 24/,
  )
})
