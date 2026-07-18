import assert from "node:assert/strict";
import test from "node:test";
import { searchIndexRecordFromJson } from "../src/records.ts";

const searchRecord = {
  id: "page:concept:search-validation",
  type: "page",
  title: "Search Validation",
  summary: "Search JSON boundary fixture",
  uri: "openwiki://page/concept/search-validation",
  path: "wiki/concepts/search-validation.md",
  body: "# Search Validation",
  topics: ["search"],
  source_ids: [],
  status: "published",
  updated_at: "2026-05-29T00:00:00.000Z",
};

test("search index rows validate JSON shape before query fusion", () => {
  assert.equal(searchIndexRecordFromJson(JSON.stringify(searchRecord)).id, searchRecord.id);
  assert.throws(
    () => searchIndexRecordFromJson(JSON.stringify({ ...searchRecord, topics: ["search", 1] })),
    /Invalid search index record JSON/,
  );
});
