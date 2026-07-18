import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../packages/cli/src/args.ts";

test("parseArgs handles boolean flags", () => {
  const { command, options } = parseArgs([
    "lint",
    "--json",
    "--explain",
    "--highlights",
    "--fuzzy",
    "--commit",
    "--all",
    "--force",
    "--apply",
    "--citations",
    "--enqueue",
    "--once",
    "--create-token",
    "--skip-agent",
    "--dry-run",
    "--trust-headers",
    "--replace-grants",
  ]);
  assert.equal(command, "lint");
  for (const flag of [
    "json",
    "explain",
    "highlights",
    "fuzzy",
    "commit",
    "commitAll",
    "force",
    "applySynthesis",
    "citations",
    "enqueue",
    "once",
    "createToken",
    "skipAgent",
    "dryRun",
    "trustHeaders",
    "replaceGrants",
  ] as const) {
    assert.equal(options[flag], true, `expected ${flag} to be true`);
  }
});

test("parseArgs reads value flags with parsers and conversions", () => {
  const { command, args, options } = parseArgs([
    "search",
    "graph memory",
    "--root",
    "/tmp/wiki",
    "--limit",
    "12",
    "--offset",
    "4",
    "--title",
    "My Page",
    "--id",
    "page:concept:x",
    "--port",
    "3040",
    "--host",
    "0.0.0.0",
    "--out-dir",
    "public",
    "--base-url",
    "https://example.com",
    "--html-page-ceiling",
    "100",
    "--remote",
    "origin",
    "--branch",
    "main",
    "--remote-url",
    "https://example.com/wiki.git",
    "--expires-in-days",
    "30",
    "--server-url",
    "https://api.example.com",
    "--token-env",
    "OPENWIKI_TOKEN",
  ]);
  assert.equal(command, "search");
  assert.deepEqual(args, ["graph memory"]);
  assert.equal(options.root, "/tmp/wiki");
  assert.equal(options.limit, 12);
  assert.equal(options.offset, 4);
  assert.equal(options.title, "My Page");
  assert.equal(options.targetId, "page:concept:x");
  assert.equal(options.port, 3040);
  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.outDir, "public");
  assert.equal(options.baseUrl, "https://example.com");
  assert.equal(options.htmlPageCeiling, 100);
  assert.equal(options.gitRemote, "origin");
  assert.equal(options.gitBranch, "main");
  assert.equal(options.gitRemoteUrl, "https://example.com/wiki.git");
  assert.equal(options.expiresInDays, 30);
  assert.equal(options.serverUrl, "https://api.example.com");
  assert.equal(options.tokenEnv, "OPENWIKI_TOKEN");
});

test("parseArgs accumulates repeatable array flags", () => {
  const { options } = parseArgs([
    "search",
    "--type",
    "page",
    "--type",
    "source",
    "--topic",
    "agents",
    "--status",
    "open",
    "--source",
    "source:1",
    "--viewer",
    "user:a",
    "--contributor",
    "user:b",
    "--maintainer",
    "user:c",
    "--admin",
    "user:d",
    "--principal",
    "user:e",
  ]);
  assert.deepEqual(options.types, ["page", "source"]);
  assert.deepEqual(options.topics, ["agents"]);
  assert.deepEqual(options.statuses, ["open"]);
  assert.deepEqual(options.sourceIds, ["source:1"]);
  assert.deepEqual(options.viewerPrincipals, ["user:a"]);
  assert.deepEqual(options.contributorPrincipals, ["user:b"]);
  assert.deepEqual(options.maintainerPrincipals, ["user:c"]);
  assert.deepEqual(options.adminPrincipals, ["user:d"]);
  assert.deepEqual(options.principals, ["user:e"]);
});

test("parseArgs handles special multi-effect flags", () => {
  // --reason sets both rationale and reason.
  const reason = parseArgs(["proposal", "--reason", "because"]).options;
  assert.equal(reason.rationale, "because");
  assert.equal(reason.reason, "because");

  // --group normalizes to a group: principal; bare values are prefixed.
  const group = parseArgs(["acl", "--group", "team", "--group", "group:already"]).options;
  assert.deepEqual(group.principals, ["group:team", "group:already"]);

  // --scope expands comma-separated scopes.
  const scope = parseArgs(["token", "--scope", "wiki:read,wiki:search"]).options;
  assert.deepEqual(scope.mcpScopes, ["wiki:read", "wiki:search"]);
});

test("parseArgs applies --mode by command", () => {
  const search = parseArgs(["search", "--mode", "hybrid", "graph memory"]).options;
  assert.equal(search.searchMode, "hybrid");
  assert.equal(search.mcpToolMode, undefined);

  const mcp = parseArgs(["mcp", "--mode", "write"]).options;
  assert.equal(mcp.mcpToolMode, "write");
  assert.equal(mcp.searchMode, undefined);

  assert.throws(() => parseArgs(["search", "--mode", "read", "graph memory"]), /Invalid search mode/);
});

test("parseArgs routes --path only for commit and policy propose-section", () => {
  const commit = parseArgs(["commit", "--path", "wiki/a.md", "--path", "wiki/b.md"]).options;
  assert.deepEqual(commit.commitPaths, ["wiki/a.md", "wiki/b.md"]);

  const policy = parseArgs(["policy", "propose-section", "--path", "wiki/**"]).options;
  assert.deepEqual(policy.sectionPaths, ["wiki/**"]);

  assert.throws(() => parseArgs(["search", "--path", "wiki/a.md"]), /only supported by/);
});

test("parseArgs collects positional arguments and strips the leading --", () => {
  const { command, args } = parseArgs(["--", "page", "read", "page:concept:x"]);
  assert.equal(command, "page");
  assert.deepEqual(args, ["read", "page:concept:x"]);
});

test("parseArgs throws when a value flag is missing its argument", () => {
  assert.throws(() => parseArgs(["search", "--root"]), /--root/);
});
