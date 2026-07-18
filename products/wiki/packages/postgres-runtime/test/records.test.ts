import assert from "node:assert/strict";
import test from "node:test";
import { OpenWikiValidationError } from "@openwiki/core";
import {
  runtimeIndexedRecordJsonFromJson,
  runtimeRecordFromJson,
  runtimeWorkspaceConfigFromJson,
} from "../src/records.ts";

const runRecord = {
  id: "run:2026-05-29-001",
  uri: "openwiki://run/2026-05-29-001",
  type: "run",
  run_type: "job.test",
  status: "queued",
  actor_id: "actor:user:test",
  workspace_id: "workspace:test",
  created_at: "2026-05-29T00:00:00.000Z",
  path: "runs/run-index.jsonl",
};

const workspaceConfig = {
  protocol_version: "0.1",
  workspace_id: "workspace:test",
  title: "Test Wiki",
  repo_format: "openwiki-repo-v0",
  created_at: "2026-05-29T00:00:00.000Z",
};

test("postgres runtime record JSON validates before casting DB rows", () => {
  const record = runtimeRecordFromJson<typeof runRecord>(JSON.stringify(runRecord), "run");
  assert.equal(record.id, runRecord.id);
  assert.throws(
    () => runtimeRecordFromJson(JSON.stringify({ ...runRecord, path: undefined }), "run"),
    OpenWikiValidationError,
  );
});

test("postgres runtime validates workspace, policy, and section JSON boundaries", () => {
  assert.equal(runtimeWorkspaceConfigFromJson(JSON.stringify(workspaceConfig)).repo_format, "openwiki-repo-v0");
  assert.equal(
    runtimeIndexedRecordJsonFromJson(JSON.stringify({ id: "policy:sections", type: "policy", body: [] }), "policy").id,
    "policy:sections",
  );
  assert.throws(
    () => runtimeIndexedRecordJsonFromJson(JSON.stringify({ id: "policy:sections", body: [] }), "policy"),
    OpenWikiValidationError,
  );
});
