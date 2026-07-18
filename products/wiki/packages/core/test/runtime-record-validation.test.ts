import assert from "node:assert/strict";
import test from "node:test";
import { OpenWikiValidationError, openWikiDerivedRecordFromUnknown } from "../src/index.ts";

test("openWikiDerivedRecordFromUnknown validates typed derived-store records", () => {
  const page = openWikiDerivedRecordFromUnknown(
    {
      id: "page:handbook:intro",
      uri: "openwiki://page/handbook/intro",
      type: "page",
      page_type: "article",
      title: "Intro",
      body_format: "markdown",
      body: "# Intro",
      path: "wiki/handbook/intro.md",
      source_ids: [],
      claim_ids: [],
      status: "published",
      topics: ["handbook"],
      created_at: "2026-05-29T00:00:00.000Z",
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    "page",
  );

  assert.equal(page.title, "Intro");
});

test("openWikiDerivedRecordFromUnknown rejects mismatched record types", () => {
  assert.throws(
    () =>
      openWikiDerivedRecordFromUnknown(
        {
          id: "page:handbook:intro",
          uri: "openwiki://page/handbook/intro",
          type: "source",
          title: "Intro",
          source_type: "manual",
          retrieved_at: "2026-05-29T00:00:00.000Z",
          path: "sources/intro.md",
        },
        "page",
      ),
    OpenWikiValidationError,
  );
});

test("openWikiDerivedRecordFromUnknown accepts event names stored in event rows", () => {
  const event = openWikiDerivedRecordFromUnknown(
    {
      id: "event:2026-05-29:000001",
      uri: "openwiki://event/2026-05-29/000001",
      type: "proposal.created",
      workspace_id: "workspace:local",
      occurred_at: "2026-05-29T00:00:00.000Z",
      path: "events/events.jsonl",
    },
    "event",
  );

  assert.equal(event.type, "proposal.created");
});
