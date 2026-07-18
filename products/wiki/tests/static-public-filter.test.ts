import assert from "node:assert/strict";
import test from "node:test";
import { OPENWIKI_PROTOCOL_VERSION, OPENWIKI_REPO_FORMAT, type EventRecord, type RunRecord } from "@openwiki/core";
import type { LoadedOpenWikiRepo } from "@openwiki/repo";
import { eventPublicAllowed, runPublicAllowed } from "../packages/static-export/src/public-filter.ts";

test("static public filters treat sensitive path keys as subject paths", () => {
  const repo = publicLedgerPrivateWikiRepo();
  repo.pages.push({
    id: "page:public",
    uri: "openwiki://page/public",
    type: "page",
    page_type: "concept",
    title: "Public",
    body_format: "markdown",
    body: "Public",
    path: "wiki/public.md",
    source_ids: [],
    claim_ids: [],
    status: "published",
    topics: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const event: EventRecord = {
    id: "event:2026-01-01-001",
    uri: "openwiki://event/2026-01-01-001",
    type: "audit.secret",
    workspace_id: "workspace:test",
    occurred_at: "2026-01-01T00:00:00.000Z",
    path: "events/events.jsonl",
    record_id: "page:public",
    data: { secret_paths: ["wiki/private.md"] },
  };
  const run: RunRecord = {
    id: "run:2026-01-01-001",
    uri: "openwiki://run/2026-01-01-001",
    type: "run",
    run_type: "test",
    status: "succeeded",
    actor_id: "actor:user:local",
    workspace_id: "workspace:test",
    created_at: "2026-01-01T00:00:00.000Z",
    subject_ids: ["page:public"],
    input: { token_path: "wiki/private.md" },
    path: "runs/runs.jsonl",
  };

  assert.equal(eventPublicAllowed(repo, event, new Set(), []), false);
  assert.equal(runPublicAllowed(repo, run), false);
});

function publicLedgerPrivateWikiRepo(): LoadedOpenWikiRepo {
  return {
    root: "/tmp/openwiki-static-filter-test",
    config: {
      protocol_version: OPENWIKI_PROTOCOL_VERSION,
      workspace_id: "workspace:test",
      title: "Static Filter Test",
      repo_format: OPENWIKI_REPO_FORMAT,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    pages: [],
    sources: [],
    claims: [],
    facts: [],
    takes: [],
    inbox: [],
    proposals: [],
    comments: [],
    decisions: [],
    events: [],
    runs: [],
    policy: {
      sections: [
        { id: "ledger", title: "Ledger", paths: ["events/**", "runs/**"], visibility: "public" },
        { id: "wiki", title: "Wiki", paths: ["wiki/public.md"], visibility: "public" },
        { id: "private", title: "Private", paths: ["wiki/private.md"], visibility: "private" },
      ],
      grants: [
        { principal: "group:all-users", section: "ledger", role: "viewer" },
        { principal: "group:all-users", section: "wiki", role: "viewer" },
      ],
      approval_rules: [],
    },
  };
}
