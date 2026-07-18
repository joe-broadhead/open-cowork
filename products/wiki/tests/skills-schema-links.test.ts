import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DEFAULT_OPENWIKI_SCHEMA_PACK,
  buildOpenWikiLinkGazetteer,
  explainOpenWikiSchemaPackResolution,
  extractOpenWikiTypedLinks,
  parseOpenWikiSchemaPackYaml,
  parseOpenWikiSkillMarkdown,
  renderOpenWikiSchemaPackYaml,
  validateOpenWikiSkillMarkdown,
} from "@openwiki/skills";
import { createWorkspace, graphOrphans, listGraphEdges } from "@openwiki/repo";

const ROOT = process.cwd();
const execFileAsync = promisify(execFile);

test("OpenWiki skill parser accepts strict manifests and never executes content", () => {
  const markdown = [
    "---",
    "name: openwiki-test",
    "description: Test skill.",
    "version: 1.0.0",
    "applies_to: [opencode, openclaw]",
    "required_tools: [wiki.search]",
    "allowed_operations: [wiki.search, wiki.read_page]",
    "risk_level: low",
    "---",
    "",
    "# Test",
    "",
    "```js",
    "throw new Error('must not execute');",
    "```",
  ].join("\n");
  const skill = parseOpenWikiSkillMarkdown(markdown, "test-skill");
  assert.equal(skill.manifest.name, "openwiki-test");
  assert.match(skill.body, /must not execute/);

  const invalid = validateOpenWikiSkillMarkdown(markdown.replace("risk_level: low", "risk_level: root"), "bad-skill");
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /risk_level/);
});

test("schema packs validate YAML contracts and resolve deterministically", () => {
  const pack = parseOpenWikiSchemaPackYaml(renderOpenWikiSchemaPackYaml(DEFAULT_OPENWIKI_SCHEMA_PACK), "default-pack");
  assert.equal(pack.api_version, "openwiki.schema-pack.v1");
  assert.ok(pack.allowed_edge_types.includes("page_typed_link"));

  assert.throws(
    () => parseOpenWikiSchemaPackYaml(renderOpenWikiSchemaPackYaml(DEFAULT_OPENWIKI_SCHEMA_PACK).replace("api_version:", "bad_field:"), "bad-pack"),
    /api_version|unsupported/,
  );

  const resolution = explainOpenWikiSchemaPackResolution({
    cliPath: "/tmp/cli-pack.yaml",
    env: { OPENWIKI_SCHEMA_PACK: "/tmp/env-pack.yaml" },
    repoConfig: { runtime: { schema_pack: { name: "repo-pack" } } },
    workspaceProfile: "team",
  });
  assert.equal(resolution.selected.source, "cli");
  assert.equal(resolution.selected.reference, "/tmp/cli-pack.yaml");

  const defaultResolution = explainOpenWikiSchemaPackResolution({ workspaceProfile: "local" });
  assert.equal(defaultResolution.selected.source, "bundled_default");
  assert.equal(defaultResolution.selected.reference, DEFAULT_OPENWIKI_SCHEMA_PACK.name);
});

test("typed link extraction handles explicit links, relation fields, aliases, regex rules, and collisions", () => {
  const gazetteer = buildOpenWikiLinkGazetteer({
    pages: [
      { id: "page:concept:alpha", title: "Alpha", path: "wiki/concepts/alpha.md" },
      { id: "page:concept:beta", title: "Project Beta", path: "wiki/concepts/beta.md", topics: ["beta-alias"] },
      { id: "page:concept:beta-duplicate", title: "Beta Alias", path: "wiki/concepts/beta-duplicate.md", topics: ["beta-alias"] },
    ],
    sources: [
      { id: "source:2026-06-13-001", title: "Beta Source", path: "sources/manifests/beta.yaml" },
      { id: "source:relative-evidence", title: "Quarterly Evidence", path: "wiki/sources/beta.yaml" },
    ],
  });
  const body = [
    "Alpha references [[Project Beta]].",
    "Alpha also cites [Beta Source](../../sources/manifests/beta.yaml).",
    "Alpha cites [Quarterly Evidence](../sources/beta.yaml).",
    "Alpha depends on Project   Beta for launch.",
    "This ambiguous beta-alias should not be guessed.",
    "`Project Beta in code is ignored`",
  ].join("\n");
  const result = extractOpenWikiTypedLinks({
    from_id: "page:concept:alpha",
    path: "wiki/concepts/alpha.md",
    body,
    frontmatter: {
      supports: ["source:2026-06-13-001"],
    },
    gazetteer,
  });

  assert.ok(result.candidates.some((candidate) => candidate.rule === "wikilink" && candidate.to_id === "page:concept:beta"));
  assert.ok(result.candidates.some((candidate) => candidate.rule === "markdown_link" && candidate.to_id === "source:2026-06-13-001"));
  assert.ok(result.candidates.some((candidate) => candidate.rule === "markdown_link" && candidate.to_id === "source:relative-evidence"));
  assert.ok(result.candidates.some((candidate) => candidate.rule === "frontmatter_relation" && candidate.relation === "supports"));
  const regexCandidate = result.candidates.find((candidate) => candidate.rule === "regex_relation" && candidate.relation === "depends_on");
  assert.ok(regexCandidate);
  assert.equal(body.slice(regexCandidate.span.start, regexCandidate.span.end), "Project   Beta");
  assert.ok(result.collisions.some((collision) => collision.text === "beta-alias" && collision.candidate_ids.length === 2));

  const substringResult = extractOpenWikiTypedLinks({
    from_id: "page:concept:alpha",
    path: "wiki/concepts/alpha.md",
    body: "Alpha depends on alphabetagamma for launch.",
    gazetteer,
  });
  assert.ok(!substringResult.candidates.some((candidate) => candidate.rule === "regex_relation" && candidate.to_id === "page:concept:beta"));

  const duplicatePathGazetteer = buildOpenWikiLinkGazetteer({
    pages: [
      { id: "page:concept:alpha", title: "Alpha", path: "wiki/concepts/alpha.md" },
      { id: "page:concept:local-beta", title: "Local Beta", path: "wiki/concepts/beta.md" },
      { id: "page:archive:beta", title: "Archived Beta", path: "archive/beta.md" },
    ],
  });
  const duplicatePathResult = extractOpenWikiTypedLinks({
    from_id: "page:concept:alpha",
    path: "wiki/concepts/alpha.md",
    body: "Alpha references [Beta](beta.md).",
    gazetteer: duplicatePathGazetteer,
  });
  assert.ok(duplicatePathResult.candidates.some((candidate) => candidate.rule === "markdown_link" && candidate.to_id === "page:concept:local-beta"));
  assert.ok(!duplicatePathResult.candidates.some((candidate) => candidate.rule === "markdown_link" && candidate.to_id === "page:archive:beta"));
  assert.equal(duplicatePathResult.collisions.length, 0);

  const ambiguousSuffixGazetteer = buildOpenWikiLinkGazetteer({
    pages: [
      { id: "page:concept:alpha", title: "Alpha", path: "wiki/concepts/alpha.md" },
      { id: "page:team-a:beta", title: "Team A Beta", path: "team-a/shared/beta.md" },
      { id: "page:team-b:beta", title: "Team B Beta", path: "team-b/shared/beta.md" },
    ],
  });
  const ambiguousSuffixResult = extractOpenWikiTypedLinks({
    from_id: "page:concept:alpha",
    path: "wiki/concepts/alpha.md",
    body: "Alpha references [Beta](shared/beta.md).",
    gazetteer: ambiguousSuffixGazetteer,
  });
  assert.ok(!ambiguousSuffixResult.candidates.some((candidate) => candidate.rule === "markdown_link"));
  assert.deepEqual(
    ambiguousSuffixResult.collisions.find((collision) => collision.rule === "markdown_link")?.candidate_ids,
    ["page:team-a:beta", "page:team-b:beta"],
  );
});

test("repo graph emits typed derived links with provenance without changing canonical pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-typed-links-"));
  try {
    await createWorkspace(root, "Typed Links");
    await writeWikiPage(root, "alpha", "Alpha depends on Beta for the launch.\nAlpha blocks Beta until legal review completes.");
    await writeWikiPage(root, "beta", "Beta is the linked dependency.\nAlpha mentions [[topic:private-roadmap]].", ["private-roadmap"]);

    const graph = await listGraphEdges(root);
    const typedEdges = graph.edges.filter((edge) => edge.edge_type === "page_typed_link" && edge.from_id === "page:concept:alpha" && edge.to_id === "page:concept:beta");
    assert.equal(typedEdges.length, 2);
    assert.deepEqual(new Set(typedEdges.map((edge) => edge.metadata?.relation)), new Set(["blocks", "depends_on"]));
    const typed = typedEdges.find((edge) => edge.metadata?.relation === "depends_on");
    assert.ok(typed);
    assert.equal(typed.metadata?.relation, "depends_on");
    assert.equal(typed.metadata?.extraction_rule, "regex_relation");
    assert.equal(typed.metadata?.link_kind, "derived");
    assert.ok(!graph.edges.some((edge) => edge.edge_type === "page_typed_link" && edge.to_id === "topic:private-roadmap"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_topic" && edge.to_id === "topic:private-roadmap"));

    const orphans = await graphOrphans(root);
    assert.ok(orphans.pages.some((page) => page.id === "page:concept:alpha"));
    assert.ok(orphans.pages.some((page) => page.id === "page:concept:beta"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-pack CLI lists, validates, explains, and scaffolds packs", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-schema-pack-cli-"));
  try {
    const list = JSON.parse(String((await runOpenWiki(["schema-pack", "list", "--json"])).stdout)) as { schema_packs: Array<{ name: string }> };
    assert.ok(list.schema_packs.some((pack) => pack.name === "openwiki-default"));

    const scaffold = JSON.parse(String((await runOpenWiki(["schema-pack", "scaffold", "local-pack", "--out-dir", outDir, "--json"])).stdout)) as { path: string };
    assert.equal(scaffold.path, path.join(outDir, "schema-pack.yaml"));

    const validate = JSON.parse(String((await runOpenWiki(["schema-pack", "validate", scaffold.path, "--json"])).stdout)) as { ok: boolean; pack: { name: string } };
    assert.equal(validate.ok, true);
    assert.equal(validate.pack.name, "local-pack");

    const invalidPath = path.join(outDir, "invalid-schema-pack.yaml");
    await writeFile(invalidPath, "api_version: bad\n", "utf8");
    await assert.rejects(
      runOpenWiki(["schema-pack", "validate", invalidPath, "--json"]),
      (error: unknown) => {
        const commandError = error as Error & { stdout?: unknown };
        assert.match(commandError.message, /Command failed/);
        const invalid = JSON.parse(String(commandError.stdout)) as { ok: boolean; errors: string[] };
        assert.equal(invalid.ok, false);
        assert.ok(invalid.errors.some((message) => message.includes("api_version")));
        return true;
      },
    );

    const explain = JSON.parse(String((await runOpenWiki(["schema-pack", "explain", "--schema-pack", scaffold.path, "--json"])).stdout)) as { selected: { source: string; reference: string } };
    assert.equal(explain.selected.source, "cli");
    assert.equal(explain.selected.reference, scaffold.path);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

async function writeWikiPage(root: string, slug: string, body: string, topics: string[] = []): Promise<void> {
  await writeFile(
    path.join(root, "wiki", "concepts", `${slug}.md`),
    [
      "---",
      `id: page:concept:${slug}`,
      `title: ${titleCase(slug)}`,
      "type: page",
      "page_type: concept",
      "status: draft",
      "source_ids: []",
      "claim_ids: []",
      ...(topics.length === 0 ? ["topics: []"] : ["topics:", ...topics.map((topic) => `  - ${topic}`)]),
      "created_at: 2026-06-13T00:00:00.000Z",
      "updated_at: 2026-06-13T00:00:00.000Z",
      "---",
      "",
      `# ${titleCase(slug)}`,
      "",
      body,
      "",
    ].join("\n"),
  );
}

function titleCase(value: string): string {
  return value.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}

function runOpenWiki(args: string[]): ReturnType<typeof execFileAsync> {
  return execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", path.join(ROOT, "packages", "cli", "src", "main.ts"), ...args], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024,
  });
}
