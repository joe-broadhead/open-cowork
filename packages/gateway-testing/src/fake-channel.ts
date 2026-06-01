import type {
  ChannelButton,
  ChannelCapabilities,
  ChannelProviderKind,
  ChannelProvider,
  ChannelProviderId,
  ChannelTarget,
  ChannelAttachment,
  IncomingChannelMessage,
  OutgoingFile,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";
import { normalizeChannelCapabilities, normalizeChannelProviderIdentity } from "@open-cowork/gateway-channel";

export type FakeChannelSentEntry = {
  kind: "text" | "edit" | "buttons" | "file";
  target: ChannelTarget;
  text?: string;
  file?: OutgoingFile;
  buttons?: ChannelButton[][];
  messageId?: string;
  options?: SendOptions;
};

export type FakeChannelProviderOptions = {
  id?: ChannelProviderId;
  capabilities?: Partial<ChannelCapabilities>;
  now?: () => Date;
};

const defaultFakeCapabilities: ChannelCapabilities = {
  threads: false,
  messageEditing: true,
  inlineButtons: true,
  fileUploads: true,
  fileDownloads: true,
  typingIndicator: false,
  maxTextLength: 4096,
  preferredParseMode: "plain",
  parseModes: ["plain"],
  maxButtonsPerMessage: 8,
  maxButtonRowsPerMessage: 4,
  maxButtonTokenBytes: 128,
  maxFileBytes: 25 * 1024 * 1024,
  maxFileSizeBytes: 25 * 1024 * 1024,
  inboundFileModes: ["inline_buffer"],
  outboundFileModes: ["inline_buffer"],
  editSemantics: "message",
  interactionAcknowledgement: "optional",
  rateLimitStrategy: "none",
  supportsEphemeralResponses: true
};

export class FakeChannelProvider implements ChannelProvider {
  readonly kind: ChannelProviderKind;
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;

  readonly sent: FakeChannelSentEntry[] = [];
  readonly answered: Array<{ interactionId: string; text?: string; alert?: boolean }> = [];
  readonly typing: ChannelTarget[] = [];
  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: FakeChannelProviderOptions = {}) {
    const identity = normalizeChannelProviderIdentity("cli", options.id ?? "cli");
    this.kind = identity.providerKind;
    this.id = identity.providerId;
    this.capabilities = normalizeChannelCapabilities({
      ...defaultFakeCapabilities,
      ...options.capabilities
    });
    this.now = options.now ?? (() => new Date());
  }

  async start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async emit(message: IncomingChannelMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("Fake channel provider is not started");
    }
    await this.handler(message);
  }

  async sendText(target: ChannelTarget, text: string, _options?: SendOptions): Promise<SentMessage> {
    assertTextWithinLimit(text, this.capabilities.maxTextLength);
    this.sent.push({ kind: "text", target, text, options: _options });
    return sent(target, this.sent.length, this.now());
  }

  async editText(target: ChannelTarget, messageId: string, text: string): Promise<void> {
    if (!this.capabilities.messageEditing) {
      throw new Error("Fake channel provider does not support message editing");
    }
    assertTextWithinLimit(text, this.capabilities.maxTextLength);
    this.sent.push({ kind: "edit", target: { ...target, messageId }, text, messageId });
  }

  async sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage> {
    if (!this.capabilities.fileDownloads) {
      throw new Error("Fake channel provider does not support outgoing files");
    }
    if (file.data && file.data.byteLength > (this.capabilities.maxFileBytes ?? 25 * 1024 * 1024)) {
      throw new Error(`Fake channel file exceeds maxFileBytes ${this.capabilities.maxFileBytes}`);
    }
    this.sent.push({ kind: "file", target, file });
    return sent(target, this.sent.length, this.now());
  }

  async sendButtons(
    target: ChannelTarget,
    text: string,
    buttons: ChannelButton[][],
  ): Promise<SentMessage> {
    if (!this.capabilities.inlineButtons) {
      throw new Error("Fake channel provider does not support inline buttons");
    }
    assertTextWithinLimit(text, this.capabilities.maxTextLength);
    assertButtonsWithinLimits(buttons, this.capabilities);
    this.sent.push({ kind: "buttons", target, text, buttons });
    return sent(target, this.sent.length, this.now());
  }

  async answerInteraction(interactionId: string, text?: string, alert?: boolean): Promise<void> {
    this.answered.push({ interactionId, text, alert });
  }

  async setTyping(target: ChannelTarget): Promise<void> {
    if (!this.capabilities.typingIndicator) {
      throw new Error("Fake channel provider does not support typing indicators");
    }
    this.typing.push(target);
  }

  async downloadAttachment(attachment: ChannelAttachment): Promise<Uint8Array> {
    if (!this.capabilities.fileUploads) {
      throw new Error("Fake channel provider does not support incoming files");
    }
    if (attachment.buffer) return attachment.buffer;
    throw new Error("Fake attachment has no buffer");
  }
}

function sent(target: ChannelTarget, id: number, sentAt: Date): SentMessage {
  return {
    provider: target.provider,
    providerKind: target.providerKind,
    chatId: target.chatId,
    threadId: target.threadId,
    messageId: String(id),
    sentAt
  };
}

export function createButtonCapableFakeProvider(options: FakeChannelProviderOptions = {}): FakeChannelProvider {
  return new FakeChannelProvider({
    ...options,
    capabilities: {
      messageEditing: true,
      inlineButtons: true,
      typingIndicator: true,
      supportsEphemeralResponses: true,
      ...options.capabilities
    }
  });
}

export function createButtonlessFakeProvider(options: FakeChannelProviderOptions = {}): FakeChannelProvider {
  return new FakeChannelProvider({
    ...options,
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      typingIndicator: false,
      supportsEphemeralResponses: false,
      ...options.capabilities
    }
  });
}

export function createFileCapableFakeProvider(options: FakeChannelProviderOptions = {}): FakeChannelProvider {
  return new FakeChannelProvider({
    ...options,
    capabilities: {
      fileUploads: true,
      fileDownloads: true,
      ...options.capabilities
    }
  });
}

export function createConstrainedMessageFakeProvider(options: FakeChannelProviderOptions = {}): FakeChannelProvider {
  return new FakeChannelProvider({
    ...options,
    capabilities: {
      messageEditing: false,
      inlineButtons: true,
      maxTextLength: 128,
      maxButtonsPerMessage: 2,
      maxButtonRowsPerMessage: 1,
      maxButtonTokenBytes: 24,
      supportsEphemeralResponses: false,
      ...options.capabilities
    }
  });
}

function assertTextWithinLimit(text: string, maxTextLength: number) {
  if (text.length > maxTextLength) {
    throw new Error(`Fake channel text exceeds maxTextLength ${maxTextLength}`);
  }
}

function assertButtonsWithinLimits(buttons: ChannelButton[][], capabilities: ChannelCapabilities) {
  const maxRows = capabilities.maxButtonRowsPerMessage ?? 4;
  const maxButtons = capabilities.maxButtonsPerMessage ?? 8;
  const maxTokenBytes = capabilities.maxButtonTokenBytes ?? 128;
  const flattened = buttons.flat();
  if (buttons.length > maxRows) {
    throw new Error(`Fake channel buttons exceed maxButtonRowsPerMessage ${maxRows}`);
  }
  if (flattened.length > maxButtons) {
    throw new Error(`Fake channel buttons exceed maxButtonsPerMessage ${maxButtons}`);
  }
  for (const button of flattened) {
    if (new TextEncoder().encode(button.token).byteLength > maxTokenBytes) {
      throw new Error(`Fake channel button token exceeds maxButtonTokenBytes ${maxTokenBytes}`);
    }
  }
}
