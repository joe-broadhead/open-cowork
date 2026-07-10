import {
  isChannelProviderId,
  isChannelProviderKind,
  normalizeChannelCapabilities,
  validateOutgoingFilePayload,
  type ChannelAttachment,
  type ChannelProvider,
  type ChannelTarget,
  type IncomingChannelMessage,
  type SentMessage,
} from "./provider.js";
import { createProviderToken } from "./tokens.js";

export interface ChannelProviderInboundExpectation {
  text?: string;
  chatId?: string;
  threadId?: string | null;
  isDirect?: boolean;
  command?: string;
  interactionToken?: string;
  attachmentCount?: number;
}

export interface ChannelProviderInboundCase {
  name: string;
  emit: () => Promise<void>;
  expected?: ChannelProviderInboundExpectation;
}

export interface ChannelProviderConformanceInput {
  provider: ChannelProvider;
  target: ChannelTarget;
  inbound?: ChannelProviderInboundCase[];
  downloadableAttachment?: ChannelAttachment;
}

export interface ChannelProviderConformanceViolation {
  check: string;
  message: string;
}

export interface ChannelProviderConformanceReport {
  providerId: string;
  providerKind: string;
  checks: string[];
  violations: ChannelProviderConformanceViolation[];
  passed: boolean;
}

export async function runChannelProviderConformance(
  input: ChannelProviderConformanceInput,
): Promise<ChannelProviderConformanceReport> {
  const checks: string[] = [];
  const violations: ChannelProviderConformanceViolation[] = [];
  const received: IncomingChannelMessage[] = [];
  const provider = input.provider;

  const check = async (name: string, operation: () => Promise<void> | void): Promise<void> => {
    checks.push(name);
    try {
      await operation();
    } catch (error) {
      violations.push({ check: name, message: errorMessage(error) });
    }
  };

  await check("provider identity", () => {
    if (!isChannelProviderKind(provider.kind)) {
      throw new Error(`provider kind is invalid: ${String(provider.kind)}`);
    }
    if (!isChannelProviderId(provider.id)) {
      throw new Error(`provider id is invalid: ${String(provider.id)}`);
    }
    if (input.target.provider !== provider.id) {
      throw new Error(`sample target provider ${input.target.provider} does not match ${provider.id}`);
    }
    if (input.target.providerKind !== provider.kind) {
      throw new Error(`sample target kind ${input.target.providerKind ?? "(missing)"} does not match ${provider.kind}`);
    }
  });

  await check("provider capabilities", () => {
    validateProviderCapabilities(provider);
  });

  await check("provider start", async () => {
    await provider.start(async (message) => {
      received.push(message);
    });
  });

  for (const inbound of input.inbound ?? []) {
    await check(`inbound normalization: ${inbound.name}`, async () => {
      const before = received.length;
      await inbound.emit();
      const emitted = received.slice(before);
      if (emitted.length !== 1) {
        throw new Error(`expected one normalized message, got ${emitted.length}`);
      }
      validateIncomingChannelMessage(emitted[0]!, provider);
      validateInboundExpectation(emitted[0]!, inbound.expected);
    });
  }

  await check("send text", async () => {
    const deliveryId = "provider-conformance-text";
    const sent = await provider.sendText(input.target, "provider conformance text", {
      deliveryId,
    });
    validateSentMessage(sent, input.target, provider);
    validateProviderDeliveryId(sent, deliveryId);
  });

  if (provider.capabilities.messageEditing) {
    await check("edit text", async () => {
      await provider.editText(input.target, input.target.messageId ?? "1", "provider conformance edit");
    });
  }

  if (provider.capabilities.inlineButtons) {
    await check("send buttons", async () => {
      const deliveryId = "provider-conformance-buttons";
      const sent = await provider.sendButtons(input.target, "provider conformance buttons", [
        [{ label: "Approve", token: createProviderToken("p") }],
        [{ label: "Deny", token: createProviderToken("p"), style: "danger" }],
      ], {
        deliveryId,
      });
      validateSentMessage(sent, input.target, provider);
      validateProviderDeliveryId(sent, deliveryId);
    });
  }

  if (provider.capabilities.interactionAcknowledgement !== "none") {
    await check("answer interaction", async () => {
      if (!provider.answerInteraction) {
        throw new Error("provider advertises interaction acknowledgement but does not implement answerInteraction");
      }
      await provider.answerInteraction("provider-conformance-interaction", "ok", false);
    });
  }

  if (provider.capabilities.fileUploads) {
    await check("send file", async () => {
      const file = {
        filename: "provider-conformance.txt",
        mimeType: "text/plain",
        data: new TextEncoder().encode("provider conformance file"),
      };
      const fileViolations = validateOutgoingFilePayload(file);
      if (fileViolations.length > 0) {
        throw new Error(fileViolations.join("; "));
      }
      const sent = await provider.sendFile(input.target, file);
      validateSentMessage(sent, input.target, provider);
    });
  }

  if (provider.capabilities.fileDownloads) {
    await check("download attachment", async () => {
      if (!provider.downloadAttachment) {
        throw new Error("provider advertises file downloads but does not implement downloadAttachment");
      }
      if (!input.downloadableAttachment) {
        throw new Error("file-download providers require a downloadableAttachment conformance sample");
      }
      const bytes = await provider.downloadAttachment(input.downloadableAttachment, { maxBytes: 1024 * 1024 });
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error("downloadAttachment must return non-empty Uint8Array data");
      }
    });
  }

  if (provider.capabilities.typingIndicator) {
    await check("typing indicator", async () => {
      if (!provider.setTyping) {
        throw new Error("provider advertises typing indicators but does not implement setTyping");
      }
      await provider.setTyping(input.target);
    });
  }

  await check("provider stop", async () => {
    await provider.stop();
  });

  return {
    providerId: String(provider.id),
    providerKind: provider.kind,
    checks,
    violations,
    passed: violations.length === 0,
  };
}

export function validateIncomingChannelMessage(
  message: IncomingChannelMessage,
  provider: Pick<ChannelProvider, "id" | "kind">,
): void {
  const violations: string[] = [];
  if (!message.id) violations.push("message id is required");
  if (message.provider !== provider.id) {
    violations.push(`message provider ${message.provider} does not match ${provider.id}`);
  }
  if (message.providerKind !== provider.kind) {
    violations.push(`message providerKind ${message.providerKind ?? "(missing)"} does not match ${provider.kind}`);
  }
  if (message.target.provider !== provider.id) {
    violations.push(`target provider ${message.target.provider} does not match ${provider.id}`);
  }
  if (message.target.providerKind !== provider.kind) {
    violations.push(`target providerKind ${message.target.providerKind ?? "(missing)"} does not match ${provider.kind}`);
  }
  if (!message.target.chatId) violations.push("target chatId is required");
  if (!message.sender.providerUserId) violations.push("sender providerUserId is required");
  if (typeof message.text !== "string") violations.push("message text must be a string");
  if (typeof message.rawText !== "string") violations.push("message rawText must be a string");
  if (message.isCommand && !message.command) violations.push("command messages must include command");
  if (!message.providerEventId) violations.push("providerEventId is required");
  if (message.providerMessageId !== undefined &&
    message.providerMessageId !== null &&
    (typeof message.providerMessageId !== "string" || message.providerMessageId.length === 0)) {
    violations.push("providerMessageId must be a non-empty string or null when present");
  }
  if (!Array.isArray(message.attachments)) {
    violations.push("attachments must be an array");
  } else {
    for (const attachment of message.attachments) validateAttachment(attachment, violations);
  }
  if (!(message.receivedAt instanceof Date) || Number.isNaN(message.receivedAt.getTime())) {
    violations.push("receivedAt must be a valid Date");
  }
  if (message.interaction) {
    if (!message.interaction.id) violations.push("interaction id is required");
    if (!message.interaction.token) violations.push("interaction token is required");
    if (Buffer.byteLength(message.interaction.token, "utf8") > 64) {
      violations.push("interaction token cannot exceed 64 bytes");
    }
    if (message.interaction.kind !== "button" && message.interaction.kind !== "command") {
      violations.push("interaction kind must be button or command");
    }
  }
  if (violations.length > 0) throw new Error(violations.join("; "));
}

export function validateSentMessage(
  sent: SentMessage,
  target: ChannelTarget,
  provider: Pick<ChannelProvider, "id" | "kind">,
): void {
  const violations: string[] = [];
  if (sent.provider !== provider.id) violations.push(`sent provider ${sent.provider} does not match ${provider.id}`);
  if (sent.providerKind !== provider.kind) {
    violations.push(`sent providerKind ${sent.providerKind ?? "(missing)"} does not match ${provider.kind}`);
  }
  if (sent.chatId !== target.chatId) violations.push(`sent chatId ${sent.chatId} does not match target ${target.chatId}`);
  if ((sent.threadId ?? null) !== (target.threadId ?? null)) {
    violations.push(`sent threadId ${sent.threadId ?? "(none)"} does not match target ${target.threadId ?? "(none)"}`);
  }
  if (!sent.messageId) violations.push("sent messageId is required");
  if (!(sent.sentAt instanceof Date) || Number.isNaN(sent.sentAt.getTime())) {
    violations.push("sentAt must be a valid Date");
  }
  if (violations.length > 0) throw new Error(violations.join("; "));
}

function validateProviderDeliveryId(sent: SentMessage, expectedDeliveryId: string): void {
  if (sent.providerDeliveryId !== undefined && sent.providerDeliveryId !== expectedDeliveryId) {
    throw new Error(`sent providerDeliveryId ${sent.providerDeliveryId} does not match deliveryId ${expectedDeliveryId}`);
  }
}

function validateProviderCapabilities(provider: ChannelProvider): void {
  const capabilities = normalizeChannelCapabilities(provider.capabilities);
  const violations: string[] = [];
  for (const field of ["threads", "messageEditing", "inlineButtons", "fileUploads", "fileDownloads", "typingIndicator"] as const) {
    if (typeof capabilities[field] !== "boolean") violations.push(`capabilities.${field} must be boolean`);
  }
  for (const [field, allowZero] of [
    ["maxTextLength", false],
    ["maxButtonsPerMessage", !capabilities.inlineButtons],
    ["maxButtonRowsPerMessage", !capabilities.inlineButtons],
    ["maxButtonTokenBytes", !capabilities.inlineButtons],
    ["maxFileBytes", false],
  ] as const) {
    const value = capabilities[field] ?? 0;
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
      violations.push(`capabilities.${field} must be a ${allowZero ? "non-negative" : "positive"} integer`);
    }
  }
  if (!Array.isArray(capabilities.inboundFileModes)) violations.push("capabilities.inboundFileModes must be an array");
  if (!Array.isArray(capabilities.outboundFileModes)) violations.push("capabilities.outboundFileModes must be an array");
  if (!["none", "text", "message"].includes(capabilities.editSemantics ?? "none")) {
    violations.push("capabilities.editSemantics must be none, text, or message");
  }
  if (!["none", "optional", "required"].includes(capabilities.interactionAcknowledgement ?? "none")) {
    violations.push("capabilities.interactionAcknowledgement must be none, optional, or required");
  }
  if (!["none", "retry_after", "fixed_backoff"].includes(capabilities.rateLimitStrategy ?? "none")) {
    violations.push("capabilities.rateLimitStrategy must be none, retry_after, or fixed_backoff");
  }
  if (!["plain", "markdown", "html"].includes(capabilities.preferredParseMode)) {
    violations.push("capabilities.preferredParseMode must be plain, markdown, or html");
  }
  if (violations.length > 0) throw new Error(violations.join("; "));
}

function validateInboundExpectation(message: IncomingChannelMessage, expected: ChannelProviderInboundExpectation | undefined): void {
  if (!expected) return;
  const violations: string[] = [];
  if (expected.text !== undefined && message.text !== expected.text) violations.push(`expected text ${expected.text}, got ${message.text}`);
  if (expected.chatId !== undefined && message.target.chatId !== expected.chatId) violations.push(`expected chatId ${expected.chatId}, got ${message.target.chatId}`);
  if (expected.threadId !== undefined && (message.target.threadId ?? null) !== expected.threadId) {
    violations.push(`expected threadId ${expected.threadId ?? "(none)"}, got ${message.target.threadId ?? "(none)"}`);
  }
  if (expected.isDirect !== undefined && message.target.isDirect !== expected.isDirect) {
    violations.push(`expected isDirect ${String(expected.isDirect)}, got ${String(message.target.isDirect)}`);
  }
  if (expected.command !== undefined && message.command !== expected.command) {
    violations.push(`expected command ${expected.command}, got ${message.command ?? "(none)"}`);
  }
  if (expected.interactionToken !== undefined && message.interaction?.token !== expected.interactionToken) {
    violations.push(`expected interaction token ${expected.interactionToken}, got ${message.interaction?.token ?? "(none)"}`);
  }
  if (expected.attachmentCount !== undefined && message.attachments.length !== expected.attachmentCount) {
    violations.push(`expected ${expected.attachmentCount} attachments, got ${message.attachments.length}`);
  }
  if (violations.length > 0) throw new Error(violations.join("; "));
}

function validateAttachment(attachment: ChannelAttachment, violations: string[]): void {
  if (!attachment.filename.trim()) violations.push("attachment filename is required");
  if (attachment.providerFileId !== undefined && typeof attachment.providerFileId !== "string") {
    violations.push("attachment providerFileId must be a string");
  }
  if (attachment.downloadUrl !== undefined && typeof attachment.downloadUrl !== "string") {
    violations.push("attachment downloadUrl must be a string");
  }
  if (attachment.buffer && !(attachment.buffer instanceof Uint8Array)) {
    violations.push("attachment buffer must be a Uint8Array");
  }
  if (attachment.sizeBytes !== undefined && (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0)) {
    violations.push("attachment sizeBytes must be a non-negative integer");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
