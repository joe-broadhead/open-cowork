import { test } from "node:test";
import assert from "node:assert/strict";

import { redactSecretText, redactSecretRecord } from "./redaction.ts";

test("standalone gateway redaction now catches the token families the local list missed (P2)", () => {
  // Tokens are assembled at runtime so the source carries no literal token shapes (the repo's
  // own secret scanner would otherwise flag the fixtures), while the runtime values still match.
  const ya29 = `ya29.${"a".repeat(24)}`;
  const aiza = `AIza${"x".repeat(35)}`;
  const jwt = `eyJ${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}`;
  const ghp = `ghp_${"0".repeat(36)}`;
  const githubPat = `github_pat_${"1".repeat(22)}_${"a".repeat(20)}`;
  for (const token of [ya29, aiza, jwt, ghp, githubPat]) {
    const redacted = redactSecretText(`error context ${token} trailing`);
    assert.match(redacted, /REDACTED/, `expected ${token.slice(0, 6)}… to be redacted`);
    assert.doesNotMatch(redacted, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("standalone gateway redaction still scrubs the structured forms it already handled (P2)", () => {
  // The shared sanitizer collapses the whole header to its marker; still fully redacted.
  assert.match(redactSecretText("Authorization: Bearer sekret-value"), /REDACTED/i);
  assert.doesNotMatch(redactSecretText("Authorization: Bearer sekret-value"), /sekret-value/);
  assert.match(redactSecretText("postgres://user:hunter2@db:5432/x"), /:\[redacted\]@/);
  const record = redactSecretRecord({ note: "ok", apiKey: "sk-secret", nested: { token: "t" } });
  assert.equal(record.apiKey, "[redacted]");
  assert.deepEqual(record.nested, { token: "[redacted]" });
});
