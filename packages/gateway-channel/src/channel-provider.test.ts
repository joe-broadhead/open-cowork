import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import {
  buildScopeKey,
  chunkText,
  createProviderToken,
  fitText,
  isChannelProviderId,
  isSafeScopeKey,
  isValidProviderToken
} from "@open-cowork/gateway-channel";

describe("channel provider utilities", () => {
  it("builds telegram dm scope keys", () => {
    expect(
      buildScopeKey({
        provider: "telegram",
        chatId: "123",
        userId: "123"
      }),
    ).toBe("telegram:dm:123");
  });

  it("builds provider-neutral dm scope keys", () => {
    expect(
      buildScopeKey({
        provider: "webhook",
        chatId: "user-123",
        userId: "user-123"
      }),
    ).toBe("webhook:dm:user-123");
  });

  it("builds explicit direct-message scope keys when provider chat and user ids differ", () => {
    expect(
      buildScopeKey({
        provider: "slack",
        chatId: "D123",
        userId: "U123",
        isDirect: true
      }),
    ).toBe("slack:dm:U123");
  });

  it("hashes unsafe provider id components before they enter scope keys", () => {
    const scope = buildScopeKey({
      provider: "webhook",
      chatId: "team:prod\n/launch",
      userId: "alice@example.com",
      threadId: "roadmap:2026"
    });

    expect(scope).toMatch(/^webhook:chat:h_[0-9A-Za-z_-]{32}:topic:h_[0-9A-Za-z_-]{32}$/);
    expect(scope).not.toContain("team:prod");
    expect(scope).not.toContain("roadmap:2026");
    expect(scope).not.toContain("alice@example.com");
    expect(isSafeScopeKey(scope)).toBe(true);
  });

  it("hashes unsafe provider dm identifiers deterministically", () => {
    const target = {
      provider: "webhook" as const,
      chatId: "+15551234567@s.whatsapp.net",
      userId: "+15551234567@s.whatsapp.net"
    };

    expect(buildScopeKey(target)).toBe(buildScopeKey(target));
    expect(buildScopeKey(target)).toMatch(/^webhook:dm:h_[0-9A-Za-z_-]{32}$/);
  });

  it("builds telegram topic scope keys", () => {
    const scope = buildScopeKey({
      provider: "telegram",
      chatId: "-100123",
      userId: "99",
      threadId: "456"
    });

    expect(scope).toBe("telegram:chat:-100123:topic:456");
    expect(isSafeScopeKey(scope)).toBe(true);
  });

  it("chunks text within provider limits", () => {
    const chunks = chunkText("a ".repeat(600), 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
  });

  it("repairs code fences when chunking through long code blocks", () => {
    const code = [
      "Before",
      "```ts",
      ...Array.from({ length: 18 }, (_, index) => `const value${index} = ${index};`),
      "```",
      "After"
    ].join("\n");
    const chunks = chunkText(code, 180);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(chunks.every((chunk) => fenceCount(chunk) % 2 === 0)).toBe(true);
    expect(chunks.join("\n")).toContain("const value17 = 17;");
  });

  it("fits unchunkable provider messages within hard limits", () => {
    const fitted = fitText("important ".repeat(80), 120);
    expect(fitted.length).toBeLessThanOrEqual(120);
    expect(fitted).toContain("[truncated]");
  });

  it("generates compact callback tokens", () => {
    const token = createProviderToken("p");
    expect(isValidProviderToken(token)).toBe(true);
    expect(token.length).toBeLessThanOrEqual(64);
  });

  it("recognizes supported provider ids", () => {
    expect(isChannelProviderId("telegram")).toBe(true);
    expect(isChannelProviderId("whatsapp")).toBe(true);
    expect(isChannelProviderId("matrix")).toBe(false);
  });
});

function fenceCount(value: string): number {
  return value.split("\n").filter((line) => /^\s*```/.test(line)).length;
}
