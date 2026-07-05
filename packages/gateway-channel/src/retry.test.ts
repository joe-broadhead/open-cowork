import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import {
  boundedNonNegativeNumber,
  boundedPositiveInt,
  cappedBackoffMs,
  jitteredDelayMs,
  parseRetryAfterMs,
  withRetry,
} from "./retry.ts";

const noSleep = async () => {};

describe("withRetry", () => {
  it("returns immediately on success without retrying", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return "ok";
    }, { classifyDelayMs: () => 1, sleep: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient failures until success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return calls;
    }, { defaultAttempts: 5, classifyDelayMs: () => 1, sleep: noSleep });
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  it("clamps attempts to maxAttempts and rethrows", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error("always");
    }, { attempts: 100, maxAttempts: 4, classifyDelayMs: () => 1, sleep: noSleep })).rejects.toThrow("always");
    expect(calls).toBe(4);
  });

  it("rethrows without retrying when classifyDelayMs returns null", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error("permanent");
    }, { defaultAttempts: 5, classifyDelayMs: () => null, sleep: noSleep })).rejects.toThrow("permanent");
    expect(calls).toBe(1);
  });

  it("invokes onRetry before each sleep with the computed delay", async () => {
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "done";
    }, {
      defaultAttempts: 5,
      classifyDelayMs: (_error, attempt) => attempt * 10,
      onRetry: (_error, attempt, delayMs) => { seen.push({ attempt, delayMs }); },
      sleep: noSleep,
    });
    expect(seen).toEqual([{ attempt: 1, delayMs: 10 }, { attempt: 2, delayMs: 20 }]);
  });

  it("jitters the delay only when jitterForError allows it", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error(calls === 1 ? "jitter" : "exact");
      return "done";
    }, {
      defaultAttempts: 5,
      classifyDelayMs: () => 1000,
      jitterForError: (error) => (error as Error).message === "jitter",
      jitterRatio: 0.2,
      maxDelayMs: 10_000,
      random: () => 0.5, // mid-spread → equals base when centred
      onRetry: (_error, _attempt, delayMs) => { delays.push(delayMs); },
      sleep: noSleep,
    });
    // attempt 1 jittered (random 0.5 keeps it at base 1000), attempt 2 unjittered (1000).
    expect(delays).toEqual([1000, 1000]);
  });
});

describe("cappedBackoffMs", () => {
  it("grows exponentially then caps", () => {
    expect(cappedBackoffMs(1)).toBe(1000);
    expect(cappedBackoffMs(2)).toBe(2000);
    expect(cappedBackoffMs(3)).toBe(4000);
    expect(cappedBackoffMs(10)).toBe(10_000); // capped at maxDelayMs
  });

  it("honours custom initial/max/factor", () => {
    expect(cappedBackoffMs(1, { initialDelayMs: 500, factor: 3 })).toBe(500);
    expect(cappedBackoffMs(2, { initialDelayMs: 500, factor: 3 })).toBe(1500);
    expect(cappedBackoffMs(5, { initialDelayMs: 500, maxDelayMs: 2000, factor: 3 })).toBe(2000);
  });
});

describe("jitteredDelayMs", () => {
  it("returns the base delay when ratio is zero", () => {
    expect(jitteredDelayMs(1000, { jitterRatio: 0 }, () => 0)).toBe(1000);
  });

  it("spreads symmetrically around the base and clamps to maxDelayMs", () => {
    expect(jitteredDelayMs(1000, { jitterRatio: 0.2 }, () => 0)).toBe(800); // low end
    expect(jitteredDelayMs(1000, { jitterRatio: 0.2 }, () => 1)).toBe(1200); // high end (unclamped)
    expect(jitteredDelayMs(1000, { jitterRatio: 0.2, maxDelayMs: 1100 }, () => 1)).toBe(1100); // clamped
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP date relative to nowMs", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("2026-01-01T00:00:05Z", now)).toBe(5000);
    expect(parseRetryAfterMs("2025-01-01T00:00:00Z", now)).toBe(0); // past dates floor at 0
  });

  it("returns null for empty or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});

describe("bounded numeric helpers", () => {
  it("boundedPositiveInt falls back for non-positive or non-integer values", () => {
    expect(boundedPositiveInt(5, 3)).toBe(5);
    expect(boundedPositiveInt(0, 3)).toBe(3);
    expect(boundedPositiveInt(-1, 3)).toBe(3);
    expect(boundedPositiveInt(undefined, 3)).toBe(3);
  });

  it("boundedNonNegativeNumber accepts zero and rejects negatives", () => {
    expect(boundedNonNegativeNumber(0, 0.2)).toBe(0);
    expect(boundedNonNegativeNumber(0.5, 0.2)).toBe(0.5);
    expect(boundedNonNegativeNumber(-1, 0.2)).toBe(0.2);
    expect(boundedNonNegativeNumber(undefined, 0.2)).toBe(0.2);
  });
});
