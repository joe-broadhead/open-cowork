import assert from "node:assert/strict";
import test from "node:test";
import { OpenWikiValidationError } from "@openwiki/core";
import {
  indexStoreIndexedRecordJsonFromJson,
  indexStoreRecordFromJson,
  indexStoreWorkspaceConfigFromJson,
} from "../src/records.ts";

const pageRecord = {
  id: "page:concept:runtime-validation",
  uri: "openwiki://page/concept/runtime-validation",
  type: "page",
  page_type: "concept",
  title: "Runtime Validation",
  body_format: "markdown",
  body: "# Runtime Validation",
  path: "wiki/concepts/runtime-validation.md",
  source_ids: [],
  claim_ids: [],
  status: "published",
  topics: [],
  created_at: "2026-05-29T00:00:00.000Z",
  updated_at: "2026-05-29T00:00:00.000Z",
};

const workspaceConfig = {
  protocol_version: "0.1",
  workspace_id: "workspace:test",
  title: "Test Wiki",
  repo_format: "openwiki-repo-v0",
  created_at: "2026-05-29T00:00:00.000Z",
};

test("index-store record JSON validates derived record shape", () => {
  const record = indexStoreRecordFromJson<typeof pageRecord>(JSON.stringify(pageRecord), "page");
  assert.equal(record.id, pageRecord.id);
  assert.throws(
    () => indexStoreRecordFromJson(JSON.stringify({ ...pageRecord, source_ids: undefined }), "page"),
    OpenWikiValidationError,
  );
});

test("index-store workspace and synthetic indexed rows validate their JSON shape", () => {
  assert.equal(indexStoreWorkspaceConfigFromJson(JSON.stringify(workspaceConfig)).workspace_id, "workspace:test");
  assert.deepEqual(
    indexStoreIndexedRecordJsonFromJson(JSON.stringify({ id: "section:team", title: "Team", paths: ["wiki/**"] }), "section"),
    { id: "section:team", title: "Team", paths: ["wiki/**"] },
  );
  assert.throws(
    () => indexStoreIndexedRecordJsonFromJson(JSON.stringify({ id: "section:bad", title: "Bad" }), "section"),
    OpenWikiValidationError,
  );
});
