import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackRemoteAddress, resolveHttpPolicy, scopeTokenAuthAllowed } from "../src/auth.ts";

test("scopeTokenAuthAllowed is loopback-only by default (JOE-972)", () => {
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "127.0.0.1", env: {} }), true);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "::1", env: {} }), true);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "::ffff:127.0.0.1", env: {} }), true);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "203.0.113.10", env: {} }), false);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "10.0.0.5", env: {} }), false);
  // In-process callers without a socket keep local convenience.
  assert.equal(scopeTokenAuthAllowed({ env: {} }), true);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "203.0.113.10", env: { OPENWIKI_ALLOW_SCOPE_TOKEN: "1" } }), true);
  assert.equal(scopeTokenAuthAllowed({ remoteAddress: "127.0.0.1", env: { OPENWIKI_ALLOW_SCOPE_TOKEN: "0" } }), false);
  assert.equal(scopeTokenAuthAllowed({ allowScopeToken: false, remoteAddress: "127.0.0.1", env: {} }), false);
});

test("isLoopbackRemoteAddress normalizes IPv4-mapped IPv6", () => {
  assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("192.168.1.1"), false);
  assert.equal(isLoopbackRemoteAddress(undefined), false);
});

test("resolveHttpPolicy does not elevate scope-tokens from non-loopback remotes", async () => {
  const root = process.cwd();
  const token = "wiki:read wiki:search";
  const allowed = await resolveHttpPolicy(root, { token }, { remoteAddress: "127.0.0.1" });
  assert.equal(allowed.authMethod, "scope-token");
  assert.deepEqual(allowed.scopes?.slice().sort(), ["wiki:read", "wiki:search"].sort());

  const denied = await resolveHttpPolicy(root, { token }, { remoteAddress: "198.51.100.20" });
  assert.equal(denied.authMethod, undefined);
  assert.equal(denied.scopes, undefined);
  assert.equal(denied.token, token);
});
