import assert from "node:assert/strict";
import test from "node:test";
import { markdownHtmlCacheSize, markdownToHtml } from "../src/markdown-cache.ts";

test("markdownToHtml caches rendered markdown without changing escaping", () => {
  const html = markdownToHtml("[x](javascript:alert(1)) <strong>unsafe</strong>");
  const htmlAgain = markdownToHtml("[x](javascript:alert(1)) <strong>unsafe</strong>");

  assert.equal(html, htmlAgain);
  assert.match(html, /&lt;strong&gt;unsafe&lt;\/strong&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.ok(markdownHtmlCacheSize() >= 1);
});
