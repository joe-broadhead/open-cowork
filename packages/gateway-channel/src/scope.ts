import { createHash } from "node:crypto";
import type { ChannelTarget } from "./provider.js";

export function buildScopeKey(target: ChannelTarget): string {
  if (!target.chatId) {
    throw new Error("Channel target chatId is required");
  }

  if (target.isDirect === true || (target.userId && target.chatId === target.userId)) {
    return `${target.provider}:dm:${scopeComponent(target.userId ?? target.chatId)}`;
  }

  const base = `${target.provider}:chat:${scopeComponent(target.chatId)}`;
  if (target.threadId && target.threadId.length > 0) {
    return `${base}:topic:${scopeComponent(target.threadId)}`;
  }

  return base;
}

export function isSafeScopeKey(scopeKey: string): boolean {
  return /^[a-z]+:(dm|chat):[-_a-zA-Z0-9:]+$/.test(scopeKey);
}

function scopeComponent(value: string): string {
  if (isPlainScopeComponent(value)) {
    return value;
  }
  const digest = createHash("sha256").update(value).digest("base64url").slice(0, 32);
  return `h_${digest}`;
}

function isPlainScopeComponent(value: string): boolean {
  return /^-?[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
