import assert from "node:assert/strict";
import test from "node:test";
import { liveness } from "../src/routes/system.ts";

test("system route liveness response is stable for health probes", () => {
  const response = liveness();
  assert.equal(response.status, "alive");
  assert.equal(response.service, "openwiki");
  assert.ok(Number.isFinite(Date.parse(response.checked_at)));
});
