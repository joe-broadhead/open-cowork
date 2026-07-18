import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedOpenWikiListLimit,
  openWikiProposalSectionIds,
  openWikiProposalTargetPaths,
  openWikiProposalTargetsPath,
  openWikiProposalUpdatedAt,
  openWikiOffsetCursor,
  openWikiPathPatternMatches,
  openWikiRepoRelativePath,
  paginateEventRecords,
  tokenizeOpenWikiText,
  uniqueStrings,
  uriToId,
  validationReportFromUnknown,
  type EventRecord,
  type ProposalRecord,
} from "@openwiki/core";

test("OpenWiki path patterns preserve globstar semantics", () => {
  assert.equal(openWikiPathPatternMatches("wiki/**/agent-memory.md", "wiki/agent-memory.md"), true);
  assert.equal(openWikiPathPatternMatches("wiki/**/agent-memory.md", "wiki/concepts/agent-memory.md"), true);
  assert.equal(openWikiPathPatternMatches("wiki/**/agent-memory.md", "wiki/concepts/agents/agent-memory.md"), true);
  assert.equal(openWikiPathPatternMatches("wiki/**/*.md", "wiki/concepts/agents/retrieval.md"), true);
  assert.equal(openWikiPathPatternMatches("wiki/**/*.md", "wiki/concepts/agents/retrieval.txt"), false);
  assert.equal(openWikiPathPatternMatches("wiki/*/agent-memory.md", "wiki/concepts/agents/agent-memory.md"), false);
});

test("uriToId reports malformed OpenWiki URIs as validation errors", () => {
  assert.equal(uriToId("openwiki://page/concept/agent-memory"), "page:concept:agent-memory");
  assert.throws(() => uriToId("not a uri%"), /Invalid OpenWiki URI/);
});

test("event pagination sorts before applying audit cursors", () => {
  const events = [
    event("event:2026-05-21-001", "2026-05-21T10:00:00.000Z"),
    event("event:2026-05-21-003", "2026-05-21T12:00:00.000Z"),
    event("event:2026-05-21-002", "2026-05-21T11:00:00.000Z"),
  ];
  const first = paginateEventRecords(events, 2, undefined);
  assert.deepEqual(first.events.map((entry) => entry.id), ["event:2026-05-21-003", "event:2026-05-21-002"]);
  assert.ok(first.next_cursor);
  const second = paginateEventRecords(events, 2, first.next_cursor);
  assert.deepEqual(second.events.map((entry) => entry.id), ["event:2026-05-21-001"]);
});

test("uniqueStrings preserves legacy filtering options", () => {
  assert.deepEqual(uniqueStrings([" a ", "a", " a ", ""]), [" a ", "a", ""]);
  assert.deepEqual(uniqueStrings([" a ", "a", " a ", "  ", ""], { omitEmpty: true }), [" a ", "a"]);
  assert.deepEqual(uniqueStrings([" a ", "a", " a ", "  ", ""], { trim: true, omitEmpty: true }), ["a"]);
});

test("shared utility helpers preserve adapter pagination, tokenization, and paths", () => {
  assert.equal(openWikiOffsetCursor(42), "offset:42");
  assert.equal(boundedOpenWikiListLimit(undefined, 50, 1000), 50);
  assert.equal(boundedOpenWikiListLimit(Number.POSITIVE_INFINITY, 50, 1000), 50);
  assert.equal(boundedOpenWikiListLimit(5000, 50, 1000), 1000);
  assert.deepEqual(tokenizeOpenWikiText("Team-Wiki_agent v2!"), ["team", "wiki_agent", "v2"]);
  assert.equal(openWikiRepoRelativePath("/repo/wiki", "/repo/wiki/pages/home.md"), "pages/home.md");
});

test("proposal path helpers centralize adapter filtering semantics", () => {
  const proposal = proposalRecord();
  assert.equal(openWikiProposalUpdatedAt(proposal), "2026-05-30T09:00:00.000Z");
  assert.deepEqual(openWikiProposalTargetPaths(proposal, ["wiki/team/overview.md", "wiki/team/overview.md"]), [
    "wiki/team/overview.md",
    "proposals/snapshots/proposal-1.md",
  ]);
  assert.equal(openWikiProposalTargetsPath(proposal, "/wiki/team/overview.md"), true);
  assert.deepEqual(
    openWikiProposalSectionIds(proposal, [
      { id: "section:team", paths: ["wiki/team/**"] },
      { id: "section:other", paths: ["wiki/other/**"] },
    ]),
    ["section:team"],
  );
});

test("validation reports are validated after JSON parse", () => {
  const report = validationReportFromUnknown({
    id: "validation:proposal-1",
    proposal_id: "proposal:1",
    status: "passed",
    checked_at: "2026-05-30T09:00:00.000Z",
    issues: [{ severity: "warning", code: "demo", message: "Demo warning", path: "wiki/demo.md" }],
  });
  assert.equal(report.issues[0]?.severity, "warning");
  assert.throws(
    () =>
      validationReportFromUnknown({
        id: "validation:proposal-1",
        proposal_id: "proposal:1",
        status: "maybe",
        checked_at: "2026-05-30T09:00:00.000Z",
        issues: [],
      }),
    /status must be passed or failed/,
  );
});

function event(id: string, occurredAt: string): EventRecord {
  return {
    id,
    uri: `openwiki://event/${id.slice("event:".length)}`,
    type: "test.event",
    workspace_id: "workspace:test",
    actor_id: "actor:user:test",
    operation: "wiki.list_events",
    occurred_at: occurredAt,
    path: "events/events.jsonl",
  };
}

function proposalRecord(): ProposalRecord {
  return {
    id: "proposal:1",
    uri: "openwiki://proposal/1",
    type: "proposal",
    title: "Update team overview",
    status: "closed",
    actor_id: "actor:user:test",
    target_ids: ["page:team:overview"],
    target_path: "wiki/team/overview.md",
    created_at: "2026-05-29T09:00:00.000Z",
    closed_at: "2026-05-30T09:00:00.000Z",
    path: "proposals/proposal-1.yaml",
    diff: { format: "unified", path: "wiki/team/overview.md" },
    snapshot_path: "proposals/snapshots/proposal-1.md",
    validation_report_path: "proposals/validation/proposal-1.json",
  };
}
