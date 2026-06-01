import test from "node:test";
import assert from "node:assert/strict";

import { runStandaloneGatewaySmoke } from "../dist/smoke.js";

test("standalone smoke exercises channel message to private OpenCode projection", async () => {
  const result = await runStandaloneGatewaySmoke();

  assert.deepEqual(result, { ok: true, sessionCount: 1, promptCount: 1 });
});
