import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, renderPageMarkdown } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import { askWithCitations } from "@openwiki/workflows";

test("ask synthesizes broad project-status questions from matching page sections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-broad-ask-"));
  try {
    await createWorkspace(root, "Broad Ask Wiki");
    await mkdir(path.join(root, "wiki", "projects"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "projects", "scaled-openwiki-personal-brain-dogfood.md"),
      renderPageMarkdown({
        id: "page:project:scaled-openwiki-personal-brain-dogfood",
        uri: "openwiki://page/project/scaled-openwiki-personal-brain-dogfood",
        type: "page",
        page_type: "project",
        title: "Scaled OpenWiki Personal Brain Dogfood",
        summary: "Tracks the personal-brain dogfood status, run log, gaps, and next agent session.",
        body_format: "markdown",
        body: [
          "# Scaled OpenWiki Personal Brain Dogfood",
          "",
          "This page tracks whether OpenWiki can act as a practical personal brain for agents.",
          "",
          "## Missing Personal Context",
          "",
          "- Add real collaborators, recurring meetings, and relationship context.",
          "- Capture durable preferences and non-dogfood decisions before day-to-day use.",
          "",
          "## Recent Changes Since Last Run",
          "",
          "- Added facts and takes proposals from the inbox flow.",
          "- Verified backup and rebuild after the scaled dogfood run.",
          "",
          "## Next Agent Session",
          "",
          "- First validate the local backup, then run one eval question from this page.",
          "- Record concrete friction as reproducible GitHub issues only.",
        ].join("\n"),
        path: "wiki/projects/scaled-openwiki-personal-brain-dogfood.md",
        source_ids: [],
        claim_ids: [],
        status: "draft",
        topics: ["dogfood", "personal-brain"],
        created_at: "2026-06-15T00:00:00.000Z",
        updated_at: "2026-06-15T00:00:00.000Z",
      }),
    );
    await buildSearchIndex(root);

    const missing = await askWithCitations({ root, question: "What personal brain data is still missing before this becomes useful day to day?", limit: 3 });
    assert.match(missing.answer, /collaborators, recurring meetings, and relationship context/);
    assert.match(missing.answer, /preferences and non-dogfood decisions/);
    assert.ok(missing.citations.some((citation) => citation.id === "page:project:scaled-openwiki-personal-brain-dogfood"));

    const changed = await askWithCitations({ root, question: "What changed since the last dogfood run?", limit: 3 });
    assert.match(changed.answer, /facts and takes proposals/);
    assert.match(changed.answer, /backup and rebuild/);

    const next = await askWithCitations({ root, question: "What should the next agent session do first?", limit: 3 });
    assert.match(next.answer, /First validate the local backup/);
    assert.match(next.answer, /run one eval question/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
