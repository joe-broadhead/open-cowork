import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { telegramRetryDelayMs, withTelegramRetry } from "@open-cowork/gateway-provider-telegram";

describe("telegram retry handling", () => {
  it("uses Telegram retry_after for rate limits", () => {
    expect(telegramRetryDelayMs({
      error_code: 429,
      parameters: { retry_after: 3 }
    }, 1)).toBe(3000);
  });

  it("retries 5xx errors with capped exponential backoff", () => {
    expect(telegramRetryDelayMs({ error_code: 502 }, 1)).toBe(1000);
    expect(telegramRetryDelayMs({ response: { status: 503 } }, 3)).toBe(4000);
  });

  it("does not retry non-transient Telegram errors", () => {
    expect(telegramRetryDelayMs({ error_code: 400 }, 1)).toBeNull();
  });

  it("retries operations until they succeed", async () => {
    const sleeps: number[] = [];
    const rateLimits: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;

    await expect(withTelegramRetry(async () => {
      calls += 1;
      if (calls === 1) {
        throw { error_code: 429, parameters: { retry_after: 1 } };
      }
      return "ok";
    }, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRateLimit: (event) => {
        rateLimits.push(event);
      }
    })).resolves.toBe("ok");

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(rateLimits).toEqual([{ attempt: 1, delayMs: 1000 }]);
  });
});
