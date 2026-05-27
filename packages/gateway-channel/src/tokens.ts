import { randomBytes } from "node:crypto";

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const tokenLength = 18;

export function createProviderToken(prefix: "p" | "i" | "j" = "i"): string {
  return `${prefix}:${randomBase62(tokenLength)}`;
}

export function isValidProviderToken(token: string): boolean {
  return /^[pij]:[0-9A-Za-z]{18}$/.test(token);
}

function randomBase62(length: number): string {
  let value = "";
  while (value.length < length) {
    for (const byte of randomBytes(length)) {
      // 248 is the largest multiple of 62 below 256. Rejecting higher values
      // avoids modulo bias without needing an external random-id dependency.
      if (byte >= 248) continue;
      value += base62[byte % base62.length];
      if (value.length === length) return value;
    }
  }
  return value;
}
