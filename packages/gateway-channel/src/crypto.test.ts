import { describe, it } from "node:test";
import { expect } from "../../../tests/gateway-test-expect.ts";
import { constantTimeStringEqual } from "./crypto.ts";

describe("constantTimeStringEqual", () => {
  it("returns true only for byte-identical non-empty strings", () => {
    expect(constantTimeStringEqual("sig-abc", "sig-abc")).toBe(true);
    expect(constantTimeStringEqual("sig-abc", "sig-abd")).toBe(false);
  });

  it("returns false for length mismatches without throwing", () => {
    // timingSafeEqual throws on unequal-length buffers; the length short-circuit guards it.
    expect(constantTimeStringEqual("short", "longer-value")).toBe(false);
  });

  it("never authenticates empty, null, or undefined inputs", () => {
    expect(constantTimeStringEqual("", "")).toBe(false);
    expect(constantTimeStringEqual("secret", "")).toBe(false);
    expect(constantTimeStringEqual(null, "secret")).toBe(false);
    expect(constantTimeStringEqual("secret", undefined)).toBe(false);
    expect(constantTimeStringEqual(undefined, null)).toBe(false);
  });

  it("compares multibyte content by bytes", () => {
    expect(constantTimeStringEqual("café", "café")).toBe(true);
    expect(constantTimeStringEqual("café", "cafe")).toBe(false);
  });
});
