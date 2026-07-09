export type ChannelProviderKind =
  | "telegram"
  | "slack"
  | "email"
  | "discord"
  | "whatsapp"
  | "signal"
  | "webhook"
  | "cli";

export type ChannelProviderInstanceId = `${ChannelProviderKind}-${string}`;
export type ChannelProviderId = ChannelProviderKind | ChannelProviderInstanceId;
export type ChannelFileInputMode = "provider_file_id" | "download_url" | "inline_buffer";
export type ChannelFileOutputMode = "local_path" | "inline_buffer" | "provider_file_id";
export type ChannelParseMode = "plain" | "markdown" | "html";
export type ChannelEditSemantics = "none" | "text" | "message";
export type ChannelInteractionAcknowledgement = "none" | "optional" | "required";
export type ChannelRateLimitStrategy = "none" | "retry_after" | "fixed_backoff";
export type ChannelProviderLifecycleState = "starting" | "ready" | "degraded" | "failed" | "stopping" | "stopped";

export interface ChannelProviderRetryState {
  active: boolean;
  attempt: number;
  nextRetryAt: string | null;
  backoffMs: number | null;
}

export interface ChannelProviderHealthPatch {
  state?: ChannelProviderLifecycleState;
  retry?: ChannelProviderRetryState;
}

export interface ChannelProviderHealth {
  ok: boolean;
  state?: ChannelProviderLifecycleState;
  error?: string | null;
}

export interface ChannelProviderHealthReporter {
  ready(patch?: ChannelProviderHealthPatch): void;
  degraded(error: unknown, patch?: ChannelProviderHealthPatch): void;
  failed(error: unknown, patch?: ChannelProviderHealthPatch): void;
  retrying(error: unknown, patch?: ChannelProviderHealthPatch): void;
  inbound(): void;
  outbound(): void;
}

const channelProviderKinds = [
    "telegram",
    "slack",
    "email",
    "discord",
    "whatsapp",
    "signal",
    "webhook",
    "cli"
] as const satisfies readonly ChannelProviderKind[];

export function isChannelProviderKind(value: unknown): value is ChannelProviderKind {
  return typeof value === "string" && (channelProviderKinds as readonly string[]).includes(value);
}

export function isChannelProviderInstanceId(value: unknown): value is ChannelProviderInstanceId {
  return typeof value === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value) &&
    value.includes("-") &&
    !isChannelProviderKind(value) &&
    channelProviderKindFromId(value) !== null;
}

export function isChannelProviderId(value: unknown): value is ChannelProviderId {
  return isChannelProviderKind(value) || isChannelProviderInstanceId(value);
}

export function isChannelProviderInstanceIdForKind(
  value: unknown,
  kind: unknown,
): value is ChannelProviderInstanceId {
  return isChannelProviderInstanceId(value) &&
    isChannelProviderKind(kind) &&
    value.startsWith(`${kind}-`);
}

export function channelProviderKindFromId(value: unknown): ChannelProviderKind | null {
  if (isChannelProviderKind(value)) return value;
  if (typeof value !== "string") return null;
  const match = /^([a-z][a-z0-9]*)-/.exec(value);
  const kind = match?.[1];
  return isChannelProviderKind(kind) ? kind : null;
}

export function normalizeChannelProviderIdentity(
  kind: ChannelProviderKind,
  providerId?: string | null,
): { providerId: ChannelProviderId; providerKind: ChannelProviderKind } {
  const id = providerId?.trim() || kind;
  if (id === kind) {
    return { providerId: kind, providerKind: kind };
  }
  if (!isChannelProviderInstanceIdForKind(id, kind)) {
    throw new Error(`Channel provider id ${id} must equal ${kind} or start with ${kind}-.`);
  }
  return { providerId: id, providerKind: kind };
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
  inboundFileModes?: ChannelFileInputMode[];
  outboundFileModes?: ChannelFileOutputMode[];
  editSemantics?: ChannelEditSemantics;
  interactionAcknowledgement?: ChannelInteractionAcknowledgement;
  rateLimitStrategy?: ChannelRateLimitStrategy;
  supportsEphemeralResponses?: boolean;
}

export interface ChannelTarget {
  provider: ChannelProviderId;
  providerKind?: ChannelProviderKind;
  chatId: string;
  isDirect?: boolean;
  threadId?: string | null;
  userId?: string | null;
  messageId?: string | null;
}

export interface ChannelAttachment {
  providerFileId?: string;
  downloadUrl?: string;
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
  providerInstanceId?: ChannelProviderId;
  providerEventId?: string;
  providerMessageId?: string | null;
  provider: ChannelProviderId;
  providerKind?: ChannelProviderKind;
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
  deliveryId?: string;
}

export interface SentMessage {
  provider: ChannelProviderId;
  providerKind?: ChannelProviderKind;
  chatId: string;
  messageId: string;
  threadId?: string | null;
  providerDeliveryId?: string;
  sentAt: Date;
}

export interface OutgoingFile {
  filename: string;
  mimeType?: string;
  localPath?: string;
  data?: Uint8Array;
}

export interface ChannelProvider {
  readonly id: ChannelProviderId;
  readonly kind: ChannelProviderKind;
  readonly capabilities: ChannelCapabilities;
  health?(): ChannelProviderHealth;
  setHealthReporter?(reporter: ChannelProviderHealthReporter): void;

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
    options?: SendOptions,
  ): Promise<SentMessage>;
  downloadAttachment?(attachment: ChannelAttachment, options?: { maxBytes?: number }): Promise<Uint8Array | undefined>;
  answerInteraction?(interactionId: string, text?: string, alert?: boolean): Promise<void>;
  setTyping?(target: ChannelTarget): Promise<void>;
}

export interface OutgoingFileSource {
  data?: Uint8Array;
  localPath?: string;
}

export function normalizeChannelCapabilities(capabilities: ChannelCapabilities): ChannelCapabilities {
  const maxFileBytes = positiveInteger(capabilities.maxFileBytes ?? 25 * 1024 * 1024, "maxFileBytes");
  const preferredParseMode = parseMode(capabilities.preferredParseMode);
  const parseModes = capabilities.parseModes?.length
    ? Array.from(new Set(capabilities.parseModes.map(parseMode)))
    : [preferredParseMode];
  if (!parseModes.includes(preferredParseMode)) parseModes.unshift(preferredParseMode);
  return {
    ...capabilities,
    preferredParseMode,
    parseModes,
    maxButtonsPerMessage: nonNegativeInteger(capabilities.maxButtonsPerMessage ?? (capabilities.inlineButtons ? 8 : 0), "maxButtonsPerMessage"),
    maxButtonRowsPerMessage: nonNegativeInteger(capabilities.maxButtonRowsPerMessage ?? (capabilities.inlineButtons ? 4 : 0), "maxButtonRowsPerMessage"),
    maxButtonTokenBytes: nonNegativeInteger(capabilities.maxButtonTokenBytes ?? (capabilities.inlineButtons ? 64 : 0), "maxButtonTokenBytes"),
    maxFileBytes,
    inboundFileModes: capabilities.inboundFileModes ?? (capabilities.fileDownloads ? ["provider_file_id", "download_url", "inline_buffer"] : []),
    outboundFileModes: capabilities.outboundFileModes ?? (capabilities.fileUploads ? ["local_path", "inline_buffer"] : []),
    editSemantics: capabilities.editSemantics ?? (capabilities.messageEditing ? "message" : "none"),
    interactionAcknowledgement: capabilities.interactionAcknowledgement ?? (capabilities.inlineButtons ? "optional" : "none"),
    rateLimitStrategy: capabilities.rateLimitStrategy ?? "fixed_backoff",
    supportsEphemeralResponses: capabilities.supportsEphemeralResponses ?? false
  };
}

export function validateOutgoingFilePayload(file: OutgoingFile): string[] {
  const violations: string[] = [];
  const filename = file.filename.trim();
  const localPath = file.localPath;
  if (!filename) violations.push("outgoing file filename is required");
  if (file.data && localPath) {
    violations.push("outgoing file cannot set both inline data and a local path");
  }
  if (!file.data && !localPath) {
    violations.push("outgoing file requires inline data or localPath");
  }
  if (file.data && !(file.data instanceof Uint8Array)) {
    violations.push("outgoing file data must be a Uint8Array");
  }
  return violations;
}

export function resolveOutgoingFileSource(file: OutgoingFile): OutgoingFileSource {
  const violations = validateOutgoingFilePayload(file);
  if (violations.length > 0) throw new Error(violations.join("; "));
  return {
    data: file.data,
    localPath: file.localPath
  };
}

function parseMode(value: unknown): ChannelParseMode {
  return value === "markdown" || value === "html" ? value : "plain";
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}
