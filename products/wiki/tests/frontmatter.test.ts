import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownWithFrontmatter, parseYamlSubset, yamlScalar } from "../packages/repo/src/frontmatter.ts";
import { renderPageMarkdown } from "@openwiki/repo";
import type { PageRecord } from "@openwiki/core";

test("frontmatter quoted scalars round-trip escaped strings without compounding", () => {
  for (const input of ["C:\\Users\\joe\\notes", 'Title with "quotes"', "Tabbed\tvalue"]) {
    const firstDisk = `title: ${yamlScalar(input)}\n`;
    const firstParsed = parseYamlSubset(firstDisk).title;
    assert.equal(firstParsed, input);

    const secondDisk = `title: ${yamlScalar(String(firstParsed))}\n`;
    const secondParsed = parseYamlSubset(secondDisk).title;
    assert.equal(secondParsed, input);
    assert.equal(secondDisk, firstDisk);
  }
});

test("page markdown frontmatter preserves quoted title and summary escapes", () => {
  const page: PageRecord = {
    id: "page:concept:quoted-paths",
    uri: "openwiki://page/concept/quoted-paths",
    type: "page",
    page_type: "concept",
    title: 'Quoted "Windows" Path',
    summary: "Lives at C:\\Users\\joe\\notes\twith a tab.",
    body_format: "markdown",
    body: "Body text.",
    path: "wiki/concepts/quoted-paths.md",
    source_ids: [],
    claim_ids: [],
    topics: ["paths"],
    status: "draft",
    created_at: "2026-05-31T00:00:00.000Z",
    updated_at: "2026-05-31T00:00:00.000Z",
  };
  const rendered = renderPageMarkdown(page);
  const parsed = parseMarkdownWithFrontmatter(rendered);
  assert.equal(parsed.frontmatter.title, page.title);
  assert.equal(parsed.frontmatter.summary, page.summary);
});
