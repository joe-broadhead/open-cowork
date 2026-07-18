import assert from "node:assert/strict";
import test from "node:test";
import { openWikiDerivedEventSubjectView, openWikiDerivedRunSubjectView, openWikiEventSubjectPaths, openWikiRunSubjectPaths, openWikiSubjectPathsFromUnknown } from "../src/subjects.ts";

test("event subject paths prefer explicit paths over payload inference", () => {
  assert.deepEqual(openWikiEventSubjectPaths({
    explicitPaths: ["wiki/explicit.md"],
    data: { target_path: "wiki/inferred.md" },
  }), ["wiki/explicit.md"]);
});

test("run subject paths infer from input and output when explicit paths are absent", () => {
  assert.deepEqual(openWikiRunSubjectPaths({
    input: { source_path: "sources/manifests/source.yaml", secret_paths: ["wiki/private.md"] },
    output: { paths: ["wiki/result.md", "wiki/result.md"] },
  }), ["sources/manifests/source.yaml", "wiki/private.md", "wiki/result.md"]);
});

test("subject path extraction ignores URLs, ids, tokens, secrets, unsafe paths, and cycles", () => {
  const cyclic: Record<string, unknown> = {
    target_path: "wiki/safe.md",
    url: "https://example.test/wiki/leak.md",
    token_path: "wiki/token-leak.md",
    secret_paths: ["wiki/secret-leak.md"],
    page_id: "page:concept:safe",
    absolute_path: "/etc/passwd",
    parent_path: "../escape.md",
  };
  cyclic.self = cyclic;

  assert.deepEqual(openWikiSubjectPathsFromUnknown(cyclic), ["wiki/safe.md"]);
  assert.deepEqual(openWikiSubjectPathsFromUnknown(cyclic, { includeSensitivePathKeys: true }), ["wiki/safe.md", "wiki/token-leak.md", "wiki/secret-leak.md"]);
});

test("derived subject views redact source fetch run and event search text", () => {
  const runView = openWikiDerivedRunSubjectView({
    id: "run:2026-01-01-001",
    uri: "openwiki://run/2026-01-01-001",
    type: "run",
    run_type: "source.fetch",
    status: "succeeded",
    actor_id: "actor:user:local",
    workspace_id: "workspace:test",
    created_at: "2026-01-01T00:00:00.000Z",
    input: { title: "Safe", url: "https://secret.example/private", headers: { authorization: "Bearer secret" } },
    output: { source_id: "source:2026-01-01-001", raw_path: "sources/raw/source.txt", fetch: { status: 200, bytes: 10, final_url: "https://secret.example/private" } },
    path: "runs/runs.jsonl",
  });
  assert.equal(JSON.stringify(runView.record.input).includes("secret.example"), false);
  assert.equal(runView.searchText.includes("secret.example"), false);
  assert.match(runView.searchText, /source:2026-01-01-001/);

  const eventView = openWikiDerivedEventSubjectView({
    id: "event:2026-01-01-001",
    uri: "openwiki://event/2026-01-01-001",
    type: "run.completed",
    workspace_id: "workspace:test",
    occurred_at: "2026-01-01T00:00:00.000Z",
    path: "events/events.jsonl",
    data: {
      run_type: "source.fetch",
      input: { title: "Safe", url: "https://secret.example/private" },
      output: { raw_path: "sources/raw/source.txt", fetch: { status: 200, final_url: "https://secret.example/private" } },
    },
  });
  assert.equal(JSON.stringify(eventView.record.data).includes("secret.example"), false);
  assert.equal(eventView.searchText.includes("secret.example"), false);
});
