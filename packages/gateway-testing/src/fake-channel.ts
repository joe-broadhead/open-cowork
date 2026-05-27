import type {
  ChannelButton,
  ChannelCapabilities,
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  OutgoingFile,
  SendOptions,
  SentMessage
} from "@open-cowork/gateway-channel";

export class FakeChannelProvider implements ChannelProvider {
  readonly id = "cli" as const;
  readonly capabilities: ChannelCapabilities = {
    threads: false,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: false,
    maxTextLength: 4096,
    preferredParseMode: "plain"
  };

  readonly sent: Array<{ target: ChannelTarget; text?: string; file?: OutgoingFile; buttons?: ChannelButton[][] }> = [];
  private handler?: (message: IncomingChannelMessage) => Promise<void>;

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
    this.sent.push({ target, text });
    return sent(target, this.sent.length);
  }

  async editText(target: ChannelTarget, messageId: string, text: string): Promise<void> {
    this.sent.push({ target: { ...target, messageId }, text });
  }

  async sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage> {
    this.sent.push({ target, file });
    return sent(target, this.sent.length);
  }

  async sendButtons(
    target: ChannelTarget,
    text: string,
    buttons: ChannelButton[][],
  ): Promise<SentMessage> {
    this.sent.push({ target, text, buttons });
    return sent(target, this.sent.length);
  }
}

function sent(target: ChannelTarget, id: number): SentMessage {
  return {
    provider: target.provider,
    chatId: target.chatId,
    threadId: target.threadId,
    messageId: String(id),
    sentAt: new Date()
  };
}
