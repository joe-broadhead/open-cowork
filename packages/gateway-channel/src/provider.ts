export type ChannelProviderId =
  | "telegram"
  | "slack"
  | "email"
  | "discord"
  | "whatsapp"
  | "signal"
  | "webhook"
  | "cli";

export function isChannelProviderId(value: string): value is ChannelProviderId {
  return [
    "telegram",
    "slack",
    "email",
    "discord",
    "whatsapp",
    "signal",
    "webhook",
    "cli"
  ].includes(value);
}

export interface ChannelCapabilities {
  threads: boolean;
  messageEditing: boolean;
  inlineButtons: boolean;
  fileUploads: boolean;
  fileDownloads: boolean;
  typingIndicator: boolean;
  maxTextLength: number;
  preferredParseMode: "plain" | "markdown" | "html";
  parseModes?: Array<"plain" | "markdown" | "html">;
  maxButtonsPerMessage?: number;
  maxButtonRowsPerMessage?: number;
  maxButtonTokenBytes?: number;
  maxFileBytes?: number;
  supportsEphemeralResponses?: boolean;
}

export interface ChannelTarget {
  provider: ChannelProviderId;
  chatId: string;
  isDirect?: boolean;
  threadId?: string | null;
  userId?: string | null;
  messageId?: string | null;
}

export interface ChannelAttachment {
  providerFileId?: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  localPath?: string;
  buffer?: Uint8Array;
}

export interface ChannelInteraction {
  id: string;
  token: string;
  kind: "button" | "command";
}

export interface IncomingChannelMessage {
  id: string;
  provider: ChannelProviderId;
  target: ChannelTarget;
  sender: {
    providerUserId: string;
    username?: string | null;
    displayName?: string | null;
    isBot?: boolean;
  };
  text: string;
  rawText: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  attachments: ChannelAttachment[];
  interaction?: ChannelInteraction;
  receivedAt: Date;
  raw: unknown;
}

export interface ChannelButton {
  label: string;
  token: string;
  style?: "default" | "danger" | "success";
}

export interface SendOptions {
  replyToMessageId?: string;
  parseMode?: "plain" | "markdown" | "html";
  disableNotification?: boolean;
}

export interface SentMessage {
  provider: ChannelProviderId;
  chatId: string;
  messageId: string;
  threadId?: string | null;
  sentAt: Date;
}

export interface OutgoingFile {
  filename: string;
  mimeType?: string;
  path?: string;
  data?: Uint8Array;
}

export interface ChannelProvider {
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  health?(): { ok: boolean; error?: string | null };

  start(handler: (message: IncomingChannelMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;

  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SentMessage>;
  editText(
    target: ChannelTarget,
    messageId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void>;
  sendFile(target: ChannelTarget, file: OutgoingFile): Promise<SentMessage>;
  sendButtons(
    target: ChannelTarget,
    text: string,
    buttons: ChannelButton[][],
  ): Promise<SentMessage>;
  downloadAttachment?(attachment: ChannelAttachment): Promise<Uint8Array>;
  answerInteraction?(interactionId: string, text?: string, alert?: boolean): Promise<void>;
  setTyping?(target: ChannelTarget): Promise<void>;
}
