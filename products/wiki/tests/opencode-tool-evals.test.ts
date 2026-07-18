import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = process.cwd();
const discoveryModuleUrl = pathToFileURL(path.join(ROOT, "scripts", "opencode-tool-evals", "recorder-discovery.mjs")).href;

test("OpenCode eval recorder discovery is explicit and deterministic", async () => {
  const discovery = await import(discoveryModuleUrl);
  const repoRoot = path.join(ROOT, "tmp", "openwiki-recorder-discovery");
  const envPath = path.join(repoRoot, "configured", "opencode_eval_recorder.ts");
  const siblingPath = path.join(repoRoot, "..", "opencode-tools", "plugins", "opencode_eval_recorder.ts");
  const packagePath = path.join(repoRoot, "node_modules", "@joe-broadhead", "opencode-tools", "plugins", "opencode_eval_recorder.ts");
  const exists = (available: string[]) => (candidate: string) => available.includes(candidate);

  const envResolution = discovery.resolveOpenCodeEvalRecorderPlugin(repoRoot, {
    env: { OPENCODE_EVAL_RECORDER_PLUGIN: envPath },
    exists: exists([envPath, siblingPath]),
  });
  assert.equal(envResolution.path, envPath);
  assert.equal(envResolution.source, "env");
  assert.equal(envResolution.candidates[0].label, "OPENCODE_EVAL_RECORDER_PLUGIN");
  assert.equal(envResolution.candidates[0].exists, true);

  assert.throws(
    () =>
      discovery.resolveOpenCodeEvalRecorderPlugin(repoRoot, {
        env: { OPENCODE_EVAL_RECORDER_PLUGIN: envPath },
        exists: exists([siblingPath]),
      }),
    /configured by OPENCODE_EVAL_RECORDER_PLUGIN does not exist/,
  );

  const siblingResolution = discovery.resolveOpenCodeEvalRecorderPlugin(repoRoot, {
    env: {},
    exists: exists([siblingPath, packagePath]),
  });
  assert.equal(siblingResolution.path, siblingPath);
  assert.equal(siblingResolution.source, "sibling");

  const packageResolution = discovery.resolveOpenCodeEvalRecorderPlugin(repoRoot, {
    env: {},
    exists: exists([packagePath]),
  });
  assert.equal(packageResolution.path, packagePath);
  assert.equal(packageResolution.source, "package");

  const unavailable = discovery.describeOpenCodeEvalRecorderAvailability(repoRoot, {
    env: {},
    exists: exists([]),
  });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /OpenCode eval recorder plugin not found/);
  assert.deepEqual(
    unavailable.candidates.map((candidate: { exists: boolean }) => candidate.exists),
    [false, false, false],
  );
  assert.equal(discovery.openCodeEvalRecorderPluginCandidates(repoRoot, {}).length, 3);
});
