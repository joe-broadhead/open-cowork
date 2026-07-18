import type {
  ChannelButton,
  ChannelCapabilities,
  ChannelProvider,
  ChannelTarget,
  OutgoingFile,
  SendOptions,
  SentMessage,
} from '@open-cowork/gateway-channel'

export type ChannelParseMode = 'plain' | 'markdown' | 'html'

export type NormalizedChannelCapabilities = {
  threads: boolean
  messageEditing: boolean
  inlineButtons: boolean
  fileUploads: boolean
  fileDownloads: boolean
  typingIndicator: boolean
  maxTextLength: number
  preferredParseMode: ChannelParseMode
  parseModes: ChannelParseMode[]
  maxButtonsPerMessage: number
  maxButtonRowsPerMessage: number
  maxButtonTokenBytes: number
  maxFileBytes: number
  supportsEphemeralResponses: boolean
}

export type GatewayRenderOperation =
  | {
    type: 'send_text'
    target: ChannelTarget
    text: string
    options?: SendOptions
  }
  | {
    type: 'edit_text'
    target: ChannelTarget
    messageId: string
    text: string
    options?: SendOptions
  }
  | {
    type: 'send_buttons'
    target: ChannelTarget
    text: string
    buttons: ChannelButton[][]
  }
  | {
    type: 'send_file'
    target: ChannelTarget
    file: OutgoingFile
  }
  | {
    type: 'send_artifact_link'
    target: ChannelTarget
    artifact: {
      url: string
      filename?: string
      label?: string
    }
    options?: SendOptions
  }
  | {
    type: 'set_typing'
    target: ChannelTarget
  }
  | {
    type: 'acknowledge_interaction'
    interactionId: string
    text?: string
    alert?: boolean
  }

export type GatewayRenderOperationResult = {
  operationType: GatewayRenderOperation['type']
  handled: boolean
  sentMessage?: SentMessage
  skippedReason?: 'unsupported_capability'
}

export type GatewayRenderProfile = {
  providerId: ChannelProvider['id']
  capabilities: NormalizedChannelCapabilities
}

export function getGatewayRenderProfile(provider: Pick<ChannelProvider, 'id' | 'capabilities'>): GatewayRenderProfile {
  return {
    providerId: provider.id,
    capabilities: normalizeChannelCapabilities(provider.capabilities),
  }
}

export function normalizeChannelCapabilities(capabilities: ChannelCapabilities): NormalizedChannelCapabilities {
  const preferredParseMode = capabilities.preferredParseMode
  const parseModes = normalizeParseModes(capabilities.parseModes, preferredParseMode)

  return {
    threads: capabilities.threads,
    messageEditing: capabilities.messageEditing,
    inlineButtons: capabilities.inlineButtons,
    fileUploads: capabilities.fileUploads,
    fileDownloads: capabilities.fileDownloads,
    typingIndicator: capabilities.typingIndicator,
    maxTextLength: positiveInteger(capabilities.maxTextLength, 'maxTextLength'),
    preferredParseMode,
    parseModes,
    maxButtonsPerMessage: positiveInteger(capabilities.maxButtonsPerMessage ?? 8, 'maxButtonsPerMessage'),
    maxButtonRowsPerMessage: positiveInteger(capabilities.maxButtonRowsPerMessage ?? 4, 'maxButtonRowsPerMessage'),
    maxButtonTokenBytes: positiveInteger(capabilities.maxButtonTokenBytes ?? 128, 'maxButtonTokenBytes'),
    maxFileBytes: positiveInteger(capabilities.maxFileBytes ?? 25 * 1024 * 1024, 'maxFileBytes'),
    supportsEphemeralResponses: capabilities.supportsEphemeralResponses ?? false,
  }
}

export async function executeRenderOperation(
  provider: ChannelProvider,
  operation: GatewayRenderOperation,
): Promise<GatewayRenderOperationResult> {
  const capabilities = normalizeChannelCapabilities(provider.capabilities)

  switch (operation.type) {
    case 'send_text': {
      assertTextFits(operation.text, capabilities)
      const sentMessage = await provider.sendText(operation.target, operation.text, withDefaultParseMode(operation.options, capabilities))
      return { operationType: operation.type, handled: true, sentMessage }
    }
    case 'edit_text': {
      if (!capabilities.messageEditing) {
        throw new Error('Channel provider does not support message editing.')
      }
      assertTextFits(operation.text, capabilities)
      await provider.editText(operation.target, operation.messageId, operation.text, withDefaultParseMode(operation.options, capabilities))
      return { operationType: operation.type, handled: true }
    }
    case 'send_buttons': {
      if (!capabilities.inlineButtons) {
        throw new Error('Channel provider does not support inline buttons.')
      }
      assertTextFits(operation.text, capabilities)
      assertButtonsFit(operation.buttons, capabilities)
      const sentMessage = await provider.sendButtons(operation.target, operation.text, operation.buttons)
      return { operationType: operation.type, handled: true, sentMessage }
    }
    case 'send_file': {
      if (!capabilities.fileDownloads) {
        throw new Error('Channel provider does not support outgoing files.')
      }
      const size = operation.file.data?.byteLength
      if (typeof size === 'number' && size > capabilities.maxFileBytes) {
        throw new Error(`Rendered file exceeds provider maxFileBytes ${capabilities.maxFileBytes}.`)
      }
      const sentMessage = await provider.sendFile(operation.target, operation.file)
      return { operationType: operation.type, handled: true, sentMessage }
    }
    case 'send_artifact_link': {
      const text = formatArtifactLink(operation.artifact)
      assertTextFits(text, capabilities)
      const sentMessage = await provider.sendText(operation.target, text, withDefaultParseMode(operation.options, capabilities))
      return { operationType: operation.type, handled: true, sentMessage }
    }
    case 'set_typing': {
      if (!capabilities.typingIndicator || !provider.setTyping) {
        return { operationType: operation.type, handled: false, skippedReason: 'unsupported_capability' }
      }
      await provider.setTyping(operation.target)
      return { operationType: operation.type, handled: true }
    }
    case 'acknowledge_interaction': {
      if (!provider.answerInteraction) {
        return { operationType: operation.type, handled: false, skippedReason: 'unsupported_capability' }
      }
      await provider.answerInteraction(operation.interactionId, operation.text, operation.alert)
      return { operationType: operation.type, handled: true }
    }
  }
}

function normalizeParseModes(
  parseModes: ChannelCapabilities['parseModes'],
  preferredParseMode: ChannelParseMode,
): ChannelParseMode[] {
  const unique = new Set<ChannelParseMode>(parseModes?.length ? parseModes : [preferredParseMode])
  unique.add(preferredParseMode)
  return Array.from(unique)
}

function withDefaultParseMode(options: SendOptions | undefined, capabilities: NormalizedChannelCapabilities): SendOptions {
  return {
    ...options,
    parseMode: options?.parseMode ?? capabilities.preferredParseMode,
  }
}

function assertTextFits(text: string, capabilities: NormalizedChannelCapabilities) {
  if (text.length > capabilities.maxTextLength) {
    throw new Error(`Rendered text exceeds provider maxTextLength ${capabilities.maxTextLength}.`)
  }
}

function assertButtonsFit(buttons: ChannelButton[][], capabilities: NormalizedChannelCapabilities) {
  if (buttons.length > capabilities.maxButtonRowsPerMessage) {
    throw new Error(`Rendered buttons exceed provider maxButtonRowsPerMessage ${capabilities.maxButtonRowsPerMessage}.`)
  }
  const flat = buttons.flat()
  if (flat.length > capabilities.maxButtonsPerMessage) {
    throw new Error(`Rendered buttons exceed provider maxButtonsPerMessage ${capabilities.maxButtonsPerMessage}.`)
  }
  for (const button of flat) {
    if (new TextEncoder().encode(button.token).byteLength > capabilities.maxButtonTokenBytes) {
      throw new Error(`Rendered button token exceeds provider maxButtonTokenBytes ${capabilities.maxButtonTokenBytes}.`)
    }
  }
}

function formatArtifactLink(artifact: { url: string, filename?: string, label?: string }) {
  const label = artifact.label || artifact.filename || 'Artifact available'
  return `${label}: ${artifact.url}`
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Channel capability ${field} must be a positive integer.`)
  }
  return value
}
