/**
 * Abstract channel adapter interface.
 * Channels convert external messages into OpenCode session prompts.
 *
 * Adding a new channel: implement this interface, then wire the adapter from daemon startup
 * or the channel connector registry.
 */

import type { ChannelCapabilities, StructuredGatewayMessage } from './renderer.js'

export interface ChannelMessage {
  provider: string     // 'telegram' | 'slack' | 'whatsapp' | 'opencode'
  chatId: string       // conversation identifier
  threadId?: string    // optional channel-native thread/topic identifier
  messageId?: string   // optional provider-native event/message id for idempotency
  userId: string       // sender identifier
  text: string         // normalized message text
  attachments?: Array<{ name: string; url: string; mimeType: string }>
  timestamp: string
}

export interface ChannelAdapter {
  name: string
  capabilities: ChannelCapabilities
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(chatId: string, text: string, options?: { threadId?: string; idempotencyKey?: string }): Promise<void>
  sendStructuredMessage?(chatId: string, message: StructuredGatewayMessage, options?: { threadId?: string }): Promise<void>
  sendCommandMenu?(chatId: string, text: string, actions: Array<{ label: string; command: string; description?: string }>, options?: { threadId?: string }): Promise<void>
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void
}
