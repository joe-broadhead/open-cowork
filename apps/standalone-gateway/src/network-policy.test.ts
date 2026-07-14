import test from "node:test";
import assert from "node:assert/strict";

import { assertPrivateBindHost, assertPrivateOpenCodeEndpoint, isLoopbackOrPrivateHost } from "../dist/network-policy.js";

test("private OpenCode policy allows loopback and RFC1918 addresses", () => {
  assert.equal(isLoopbackOrPrivateHost("127.0.0.1"), true);
  assert.equal(isLoopbackOrPrivateHost("10.0.1.5"), true);
  assert.equal(isLoopbackOrPrivateHost("172.20.1.5"), true);
  assert.equal(isLoopbackOrPrivateHost("192.168.1.5"), true);
  assert.equal(isLoopbackOrPrivateHost("100.64.0.1"), true);
  assert.equal(isLoopbackOrPrivateHost("fd00::1"), true);
  assert.equal(isLoopbackOrPrivateHost("fe80::1"), true);
  assert.equal(isLoopbackOrPrivateHost("::ffff:7f00:1"), true);
  assert.equal(isLoopbackOrPrivateHost("::ffff:a00:1"), true);
  assert.equal(isLoopbackOrPrivateHost("::ffff:808:808"), false);
  assert.equal(assertPrivateOpenCodeEndpoint("http://127.0.0.1:4096").hostname, "127.0.0.1");
});

test("private OpenCode policy rejects public endpoints and wildcard hosts", () => {
  assert.throws(() => assertPrivateOpenCodeEndpoint("https://api.example.com"), /public OpenCode endpoint/);
  assert.throws(() => assertPrivateOpenCodeEndpoint("https://127.attacker.example"), /public OpenCode endpoint/);
  assert.throws(() => assertPrivateOpenCodeEndpoint("https://10.attacker.example"), /public OpenCode endpoint/);
  assert.throws(() => assertPrivateOpenCodeEndpoint("https://fc-attacker.example"), /public OpenCode endpoint/);
  assert.throws(() => assertPrivateOpenCodeEndpoint("ftp://127.0.0.1"), /HTTP or HTTPS/);
  assert.throws(() => assertPrivateBindHost("gateway.example.com"), /loopback\/private/);
});
